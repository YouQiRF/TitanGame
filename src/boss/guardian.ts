/**
 * 第一隻 Boss：石之守衛（Guardian）。
 *
 * ── 核心設計：破壞部位會「激怒」牠，不是削弱 ──────────
 *  每破壞一個部位，憤怒 +1 級（0..4）：
 *    · 攻擊傷害提高      · 移動與衝撞加速
 *    · 預警時間縮短      · 出招間隔縮短
 *    · 撞牆硬直縮短（輸出窗口越來越短）
 *    · 解鎖更多招式
 *
 *  所以拆部位是真正的抉擇：你換到了傷害與優勢
 *  （尤其打破核心護甲後核心永久暴露），代價是一隻更快更痛的守衛。
 *
 * ── 攻略路線 ──────────────────────────────────────────
 *  A. 保守：不拆部位，只誘導衝撞撞牆，抓天然的核心窗口
 *  B. 激進：拆掉核心護甲換取常駐核心，然後在牠最狂暴的狀態下速殺
 *
 * ── 招式（依破壞部位數解鎖）─────────────────────────
 *  rage 0  衝撞 / 砸地 / 橫掃
 *  rage 1  ＋投石、三連踏
 *  rage 2  ＋地裂
 *  rage 3  ＋狂暴連撞
 */

import { T } from '../tuning.ts';
import { Arena } from '../arena.ts';
import { fx } from '../fx.ts';
import type { Camera } from '../core/camera.ts';
import type { Player } from '../player.ts';
import { PartSet, type BodyPart } from './parts.ts';
import { Projectiles } from './projectiles.ts';
import type { HitResult } from './types.ts';
import {
  add,
  clamp,
  damp,
  dist,
  distPointSeg,
  norm,
  scale,
  sub,
  type Vec,
} from '../core/vec.ts';

export type GuardianState =
  | 'idle'
  | 'stagger'
  | 'stunned'
  | 'recover'
  | 'telegraphCharge'
  | 'charging'
  | 'telegraphSlam'
  | 'telegraphSweep'
  | 'sweeping'
  | 'telegraphThrow'
  | 'throwing'
  | 'telegraphStomp'
  | 'stomping'
  | 'telegraphQuake'
  | 'telegraphRampage'
  | 'rampaging'
  | 'telegraphPunch'
  | 'punching'
  | 'telegraphHeavyPunch'
  | 'dead';

interface PendingStomp {
  pos: Vec;
  timer: number;
}

/** 發狂時從身體縫隙噴出的火星 */
interface Ember {
  pos: Vec;
  vel: Vec;
  life: number;
  size: number;
}

/** 兩角度差，正規化到 -π..π */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const R = T.guardian.rage;

export class Guardian {
  pos: Vec;
  hp: number = T.guardian.maxHp;
  readonly name = '石之守衛';

  state: GuardianState = 'idle';
  private stateT = 0;

  /** 面向；核心與護甲長在正前方，所以繞到背後反而打不到核心 */
  facing: Vec = { x: 0, y: -1 };

  readonly parts = new PartSet();
  readonly projectiles = new Projectiles();

  hitFlash = 0;
  /** 剛被打破部位時的強提示，也用來驅動「爆發」視覺 */
  breakFlash = 0;

  private chargeDir: Vec = { x: 0, y: 0 };
  private recoverTime = 0.55;
  private lastAttack: GuardianState | null = null;

  /** 多段招式的內部計數 */
  private subCount = 0;
  private subT = 0;
  private dashing = false;
  private stomps: PendingStomp[] = [];

  private embers: Ember[] = [];
  private time = 0;
  /** 持續型特效（拖尾、蓄力塵土）的節流計時；同時間只有一個狀態在跑，可共用 */
  private fxT = 0;

  constructor(pos: Vec) {
    this.pos = { x: pos.x, y: pos.y };
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  /** 核心是否暴露：撞牆硬直中，或護甲已被打破（永久） */
  get coreExposed(): boolean {
    return this.state === 'stunned' || this.parts.isBroken('coreShell');
  }

  get corePos(): Vec {
    return add(this.pos, scale(this.facing, T.guardian.coreOffset));
  }

  get facingAngle(): number {
    return Math.atan2(this.facing.y, this.facing.x);
  }

  /** 是否正在讀招/攻擊中（給場外提示用的粗略判斷，不逐招式細分） */
  get isThreatening(): boolean {
    return this.state !== 'idle' && this.state !== 'recover' && this.state !== 'stagger';
  }

  // ── 憤怒 ────────────────────────────────────────────────

  /** 憤怒等級 = 已破壞的部位數（0..4） */
  get rage(): number {
    return this.parts.brokenCount;
  }

  /** 憤怒的視覺強度 0..1 */
  get rageRatio(): number {
    return this.rage / this.parts.list.length;
  }

  /** 攻擊傷害倍率 */
  private get dmgMult(): number {
    return 1 + this.rage * R.damagePerLevel;
  }

  /** 移動 / 衝撞速度倍率 */
  private get speedMult(): number {
    return 1 + this.rage * R.speedPerLevel;
  }

  /** 依憤怒縮短預警時間（有下限，保證預警看得見） */
  private tele(base: number): number {
    return base * (1 - Math.min(this.rage * R.telegraphCutPerLevel, R.telegraphCutMax));
  }

  private dmg(base: number): number {
    return base * this.dmgMult;
  }

  private get idleWait(): number {
    let t = T.guardian.idleTime * (1 - Math.min(this.rage * R.idleCutPerLevel, R.idleCutMax));
    if (this.hp / T.guardian.maxHp < T.guardian.lowHpThreshold) t *= T.guardian.lowHpIdleMult;
    return t;
  }

  private get stunDur(): number {
    return T.guardian.stunTime * (1 - Math.min(this.rage * R.stunCutPerLevel, R.stunCutMax));
  }

  // ── 更新 ────────────────────────────────────────────────

  update(dt: number, player: Player, camera: Camera): void {
    this.time += dt;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    if (this.breakFlash > 0) this.breakFlash = Math.max(0, this.breakFlash - dt * 1.4);

    this.parts.update(dt);
    this.projectiles.update(dt, player, camera);
    this.updateEmbers(dt);

    if (!this.alive) return;

    this.stateT += dt;
    this.fxT -= dt;

    // 核心暴露期間持續噴出金色火星，讓「快打這裡」在畫面上不可能被忽略
    if (this.state === 'stunned' && this.fxT <= 0) {
      this.fxT = 0.05;
      const c = this.corePos;
      fx.spark(c, 2, {
        speed: 90,
        life: 0.45,
        size: 2.8,
        col: [255, 215, 120],
        radius: T.guardian.coreRadius,
      });
    }

    switch (this.state) {
      case 'idle':
        this.updateIdle(dt, player);
        break;
      case 'stagger':
        if (this.stateT >= T.guardian.staggerTime) this.enter('idle');
        break;
      case 'stunned':
        if (this.stateT >= this.stunDur) this.enterRecover(0.35);
        break;
      case 'recover':
        if (this.stateT >= this.recoverTime) this.enter('idle');
        break;

      case 'telegraphCharge':
        this.updateTelegraphCharge(dt, player);
        break;
      case 'charging':
        this.updateCharging(dt, player, camera);
        break;

      case 'telegraphSlam':
        this.updateTelegraphSlam(dt, player, camera);
        break;

      case 'telegraphSweep':
        this.updateTelegraphSweep(dt, player, camera);
        break;
      case 'sweeping':
        if (this.stateT >= T.guardian.sweepDuration) this.enterRecover(T.guardian.sweepRecover);
        break;

      case 'telegraphThrow':
        this.updateTelegraphThrow(dt, player);
        break;
      case 'throwing':
        this.updateThrowing(dt, player);
        break;

      case 'telegraphStomp':
        if (this.stateT >= this.tele(T.guardian.stompTelegraph)) {
          this.enter('stomping');
          this.subCount = 0;
          this.subT = 0;
          this.stomps = [];
        }
        break;
      case 'stomping':
        this.updateStomping(dt, player, camera);
        break;

      case 'telegraphQuake':
        this.updateTelegraphQuake(dt, camera);
        break;

      case 'telegraphRampage':
        this.updateTelegraphRampage(dt, player);
        break;
      case 'rampaging':
        this.updateRampaging(dt, player, camera);
        break;

      case 'telegraphPunch':
        this.updateTelegraphPunch(dt, player);
        break;
      case 'punching':
        this.updatePunching(dt, player, camera);
        break;
      case 'telegraphHeavyPunch':
        this.updateTelegraphHeavyPunch(dt, player, camera);
        break;

      case 'dead':
        break;
    }

    Arena.confine(this.pos, T.guardian.radius);
  }

  private enter(s: GuardianState): void {
    this.state = s;
    this.stateT = 0;
  }

  private enterRecover(t: number): void {
    this.recoverTime = t;
    this.enter('recover');
  }

  private faceToward(target: Vec, rate: number, dt: number): void {
    const want = norm(sub(target, this.pos));
    if (want.x === 0 && want.y === 0) return;
    this.facing = norm({
      x: damp(this.facing.x, want.x, rate, dt),
      y: damp(this.facing.y, want.y, rate, dt),
    });
  }

  /** 瞬間鎖定朝向，不像 faceToward 那樣漸進——出招瞬間定案，預警期間不再轉向玩家 */
  private snapFacing(target: Vec): void {
    const want = norm(sub(target, this.pos));
    if (want.x !== 0 || want.y !== 0) this.facing = want;
  }

  private stepToward(target: Vec, speed: number, dt: number): void {
    const dir = norm(sub(target, this.pos));
    this.pos = add(this.pos, scale(dir, speed * dt));
  }

  // ── 待機與選招 ──────────────────────────────────────────

  private updateIdle(dt: number, player: Player): void {
    this.faceToward(player.pos, 6, dt);
    this.stepToward(player.pos, T.guardian.walkSpeed * this.speedMult, dt);

    if (this.stateT >= this.idleWait) {
      const next = this.pickAttack(player);
      if (next) {
        // 方向在選招當下就鎖定，整段預警不再轉向玩家——
        // 玩家看到預警的那一刻，方向已經是最終結果，可以放心照著讀
        this.snapFacing(player.pos);
        this.chargeDir = { ...this.facing };
        this.enter(next);
        this.lastAttack = this.state;
      }
    }
  }

  /**
   * 依距離與憤怒等級加權隨機選招。
   *
   * 砸地／橫掃都是以自己為中心的範圍技，離太遠會直接落空——
   * 不只是降低權重，而是**直接不列入候選**，避免她在打不到人的距離硬出招。
   * 衝撞／狂暴連撞需要助跑距離，太貼近時沒有意義，也一併排除。
   * 其餘招式（投石、三連踏、地裂）本來就會追蹤/覆蓋玩家目前位置，不受這個限制。
   */
  private pickAttack(player: Player): GuardianState | null {
    const d = dist(this.pos, player.pos);
    const rage = this.rage;

    const cands: Array<[GuardianState, number]> = [];

    if (d > 130) {
      cands.push(['telegraphCharge', d > T.guardian.chargePreferDist ? 3.2 : 0.8]);
    }
    if (d < T.guardian.slamRadius + 70) {
      cands.push(['telegraphSlam', d < 260 ? 2.4 : 0.6]);
    }
    if (d < T.guardian.sweepRadius + 45) {
      cands.push(['telegraphSweep', d < T.guardian.meleePreferDist ? 3.0 : 0.5]);
    }

    if (rage >= R.unlockThrow) cands.push(['telegraphThrow', d > 290 ? 2.7 : 0.5]);
    if (rage >= R.unlockStomp) cands.push(['telegraphStomp', d > 160 && d < 420 ? 2.3 : 0.5]);
    if (rage >= R.unlockQuake) cands.push(['telegraphQuake', 1.9]);
    if (rage >= R.unlockRampage && d > 130) {
      cands.push(['telegraphRampage', d > 220 ? 3.0 : 1.2]);
    }
    // 普攻（拳擊連段）：近戰基礎攻擊，隨時可用，不看憤怒等級
    if (d < T.guardian.punchReach + T.guardian.punchRadius + 40) {
      cands.push(['telegraphPunch', 2.8]);
    }

    // 避免連續出同一招——但普攻是基礎攻擊，刻意不受這個限制，可以連續使用（「普攻可以相接」）
    let total = 0;
    const weighted = cands.map(([s, w]) => {
      const adj = s === this.lastAttack && s !== 'telegraphPunch' ? w * 0.35 : w;
      total += adj;
      return [s, adj] as [GuardianState, number];
    });

    if (total <= 0) return null;

    let roll = Math.random() * total;
    for (const [s, w] of weighted) {
      roll -= w;
      if (roll <= 0) return s;
    }
    return null;
  }

  // ── 招式 1：衝撞 ────────────────────────────────────────

  private updateTelegraphCharge(dt: number, _player: Player): void {
    const dur = this.tele(T.guardian.chargeTelegraph);
    // 方向在選招當下已經鎖定（見 updateIdle），這裡整段預警都不再轉向玩家
    this.pos = add(this.pos, scale(this.chargeDir, -34 * dt));

    // 蓄力：腳邊不斷刮起塵土，越接近發動越急
    this.fxT -= dt;
    if (this.fxT <= 0) {
      const p = this.stateT / dur;
      this.fxT = 0.07 - p * 0.04;
      fx.dust(this.pos, 2, {
        dir: scale(this.chargeDir, -1),
        spread: 1.0,
        speed: 90 + p * 130,
        life: 0.4,
        size: 5,
        radius: T.guardian.radius * 0.8,
      });
    }

    if (this.stateT >= dur) {
      // 起步爆發
      const back = scale(this.chargeDir, -1);
      fx.dust(this.pos, 20, { dir: back, spread: 0.9, speed: 260, size: 8.5, life: 0.55 });
      fx.debris(this.pos, 9, { dir: back, spread: 0.8, speed: 300 });
      this.enter('charging');
    }
  }

  private updateCharging(dt: number, player: Player, camera: Camera): void {
    this.pos = add(this.pos, scale(this.chargeDir, T.guardian.chargeSpeed * this.speedMult * dt));
    this.facing = { ...this.chargeDir };

    // 高速拖尾
    this.fxT -= dt;
    if (this.fxT <= 0) {
      this.fxT = 0.018;
      fx.dust(this.pos, 2, {
        dir: scale(this.chargeDir, -1),
        spread: 0.5,
        speed: 130,
        life: 0.45,
        size: 7,
        radius: T.guardian.radius * 0.6,
      });
      if (this.rage > 0) {
        fx.spark(this.pos, 1, {
          dir: scale(this.chargeDir, -1),
          spread: 0.6,
          speed: 110,
          life: 0.35,
          size: 2.6,
          col: [255, 120, 60],
          radius: T.guardian.radius * 0.5,
        });
      }
    }

    if (dist(this.pos, player.pos) < T.guardian.radius + T.player.radius) {
      const dir = norm(sub(player.pos, this.pos));
      if (player.takeDamage(this.dmg(T.guardian.chargeDamage), dir)) camera.shake(16, 0.32);
    }

    if (Arena.touchingWall(this.pos, T.guardian.radius)) {
      Arena.confine(this.pos, T.guardian.radius);
      camera.shake(26, 0.5);
      this.wallImpactFx();
      this.enter('stunned');
      return;
    }

    if (this.stateT >= T.guardian.chargeMaxTime) this.enterRecover(0.5);
  }

  /** 撞牆：整場最重的一次衝擊，特效也要對應到那個份量 */
  private wallImpactFx(): void {
    const back = scale(this.chargeDir, -1);
    fx.debris(this.pos, 24, { dir: back, spread: 1.35, speed: 430, life: 0.8 });
    fx.dust(this.pos, 22, { speed: 240, size: 9.5, life: 0.65, radius: T.guardian.radius * 0.7 });
    fx.ring(this.pos, { r0: 24, r1: 200, life: 0.42, width: 10, col: [225, 205, 180] });
    fx.flash(this.pos, 130, 0.22, [255, 225, 190]);
  }

  // ── 招式 2：砸地 ────────────────────────────────────────

  private updateTelegraphSlam(dt: number, player: Player, camera: Camera): void {
    this.faceToward(player.pos, 4, dt);
    this.stepToward(player.pos, 42 * this.speedMult, dt);

    if (this.stateT >= this.tele(T.guardian.slamTelegraph)) {
      camera.shake(22, 0.45);

      // ── 砸地特效：地面環 + 放射碎石 + 揚塵 + 中心閃光 ──
      const SR = T.guardian.slamRadius;
      fx.ring(this.pos, { r0: 26, r1: SR, life: 0.36, width: 12, col: [255, 150, 70], ground: true });
      fx.ring(this.pos, { r0: 10, r1: SR * 0.55, life: 0.24, width: 6, col: [255, 220, 160] });
      fx.debris(this.pos, 22, { speed: 360, life: 0.75, radius: 26 });
      fx.dust(this.pos, 26, { speed: 210, size: 9, life: 0.62, radius: 34 });
      fx.flash(this.pos, SR * 0.7, 0.22, [255, 160, 80]);

      if (dist(this.pos, player.pos) < T.guardian.slamRadius + T.player.radius) {
        const dir = norm(sub(player.pos, this.pos));
        player.takeDamage(
          this.dmg(T.guardian.slamDamage),
          dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir,
        );
      }
      this.projectiles.spawnShockwave(
        this.pos,
        T.guardian.slamRadius * 0.5,
        this.dmg(T.guardian.shockwaveDamage),
        T.guardian.shockwaveMaxRadius,
      );
      this.enterRecover(T.guardian.slamRecover);
    }
  }

  // ── 招式 3：橫掃 ────────────────────────────────────────

  private updateTelegraphSweep(dt: number, player: Player, camera: Camera): void {
    // 方向在選招當下已經鎖定（見 updateIdle），這裡整段預警都不再轉向玩家
    if (this.stateT >= this.tele(T.guardian.sweepTelegraph)) {
      camera.shake(11, 0.24);

      // ── 橫掃特效：一道沿扇形掃過去的刀光，外加沿弧撒出的塵土 ──
      const SR = T.guardian.sweepRadius;
      const half = T.guardian.sweepHalfAngle;
      fx.arc(this.pos, this.facingAngle, half, 34, SR, T.guardian.sweepDuration + 0.14, [255, 150, 95], 1);
      for (let i = 0; i <= 6; i++) {
        const a = this.facingAngle - half + (half * 2 * i) / 6;
        const at = {
          x: this.pos.x + Math.cos(a) * SR * 0.85,
          y: this.pos.y + Math.sin(a) * SR * 0.85,
        };
        fx.dust(at, 3, { speed: 130, life: 0.42, size: 5.5, radius: 12 });
      }
      fx.spark(this.pos, 10, {
        dir: this.facing,
        spread: half,
        speed: 340,
        life: 0.3,
        size: 2.6,
        col: [255, 170, 110],
        radius: 30,
      });

      const d = dist(this.pos, player.pos);
      if (d < T.guardian.sweepRadius + T.player.radius) {
        const a = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);
        if (Math.abs(angleDiff(a, this.facingAngle)) < T.guardian.sweepHalfAngle) {
          player.takeDamage(this.dmg(T.guardian.sweepDamage), norm(sub(player.pos, this.pos)));
        }
      }
      this.enter('sweeping');
    }
  }

  // ── 招式 4：投石 ────────────────────────────────────────

  private updateTelegraphThrow(dt: number, player: Player): void {
    this.faceToward(player.pos, 5, dt);
    if (this.stateT >= this.tele(T.guardian.throwTelegraph)) {
      this.enter('throwing');
      this.subCount = 0;
      this.subT = 0;
    }
  }

  private updateThrowing(dt: number, player: Player): void {
    this.faceToward(player.pos, 3, dt);
    this.subT -= dt;

    if (this.subT <= 0 && this.subCount < T.guardian.throwCount) {
      // 朝玩家目前位置略帶前導，逼玩家不要直線走
      const target = add(player.pos, scale(player.vel, 0.18));
      Arena.confine(target, 40);
      const from = add(this.pos, scale(this.facing, T.guardian.radius * 0.8));
      this.projectiles.spawnBoulder(from, target, this.dmg(T.guardian.boulderDamage));

      // 投擲的甩臂與碎屑
      fx.dust(from, 8, { dir: this.facing, spread: 0.7, speed: 190, life: 0.4, size: 5 });
      fx.debris(from, 5, { dir: this.facing, spread: 0.6, speed: 240, life: 0.5 });
      fx.ring(from, { r0: 6, r1: 42, life: 0.2, width: 4, col: [200, 190, 175] });

      this.subCount++;
      this.subT = T.guardian.throwInterval;
    }

    if (this.subCount >= T.guardian.throwCount && this.subT <= 0) {
      this.enterRecover(T.guardian.throwRecover);
    }
  }

  // ── 招式 5：三連踏 ──────────────────────────────────────

  private updateStomping(dt: number, player: Player, camera: Camera): void {
    this.faceToward(player.pos, 5, dt);
    this.stepToward(player.pos, T.guardian.walkSpeed * 1.35 * this.speedMult, dt);

    this.subT -= dt;

    // 排定下一發：在玩家目前位置預告，給一小段反應時間
    if (this.subT <= 0 && this.subCount < T.guardian.stompCount) {
      this.stomps.push({ pos: { ...player.pos }, timer: this.tele(T.guardian.stompWarn) });
      this.subCount++;
      this.subT = T.guardian.stompInterval;
    }

    for (const s of this.stomps) {
      s.timer -= dt;
      if (s.timer <= 0) {
        camera.shake(14, 0.28);

        // ── 踏擊特效 ──
        const R2 = T.guardian.stompRadius;
        fx.ring(s.pos, { r0: 14, r1: R2, life: 0.3, width: 9, col: [255, 160, 80], ground: true });
        fx.debris(s.pos, 13, { speed: 320, life: 0.6, radius: 16 });
        fx.dust(s.pos, 16, { speed: 180, size: 7.5, life: 0.5, radius: 20 });
        fx.flash(s.pos, R2 * 0.6, 0.16, [255, 170, 90]);

        if (dist(s.pos, player.pos) < T.guardian.stompRadius + T.player.radius) {
          const dir = norm(sub(player.pos, s.pos));
          player.takeDamage(
            this.dmg(T.guardian.stompDamage),
            dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir,
          );
        }
      }
    }
    this.stomps = this.stomps.filter((s) => s.timer > 0);

    if (this.subCount >= T.guardian.stompCount && this.stomps.length === 0) {
      this.enterRecover(T.guardian.stompRecover);
    }
  }

  // ── 招式 6：地裂 ────────────────────────────────────────

  private updateTelegraphQuake(dt: number, camera: Camera): void {
    // 蓄力：地面碎石被震得往上跳，是最明顯的「快跑」訊號
    this.fxT -= dt;
    if (this.fxT <= 0) {
      this.fxT = 0.05;
      const a = Math.random() * Math.PI * 2;
      const r = 70 + Math.random() * 170;
      const at = { x: this.pos.x + Math.cos(a) * r, y: this.pos.y + Math.sin(a) * r };
      fx.debris(at, 2, { speed: 90, life: 0.5, gravity: 340, size: 3.5 });
      fx.dust(at, 2, { speed: 40, life: 0.4, size: 4 });
    }

    if (this.stateT >= this.tele(T.guardian.quakeTelegraph)) {
      camera.shake(30, 0.6);

      // ── 地裂發動：全場級別的爆發 ──
      fx.ring(this.pos, { r0: 12, r1: 240, life: 0.45, width: 16, col: [255, 110, 50], ground: true });
      fx.ring(this.pos, { r0: 6, r1: 120, life: 0.28, width: 8, col: [255, 220, 150] });
      fx.debris(this.pos, 30, { speed: 430, life: 0.85, radius: 40 });
      fx.dust(this.pos, 30, { speed: 260, size: 10, life: 0.7, radius: 50 });
      fx.flash(this.pos, 220, 0.3, [255, 130, 55]);

      // 起始角度隨機，避免每次都一樣好躲
      this.projectiles.spawnQuake(
        this.pos,
        Math.random() * Math.PI * 2,
        T.guardian.quakeCracks,
        this.dmg(T.guardian.quakeDamage),
      );
      this.enterRecover(T.guardian.quakeRecover);
    }
  }

  // ── 招式 7：狂暴連撞（發狂技）──────────────────────────

  private updateTelegraphRampage(dt: number, _player: Player): void {
    // 方向在選招當下已經鎖定（見 updateIdle），這裡整段預警都不再轉向玩家
    // 蓄力：赤紅火星從身體向內收束，宣告「這是最兇的一招」
    this.fxT -= dt;
    if (this.fxT <= 0) {
      this.fxT = 0.03;
      const a = Math.random() * Math.PI * 2;
      const r = T.guardian.radius * 1.9;
      const at = { x: this.pos.x + Math.cos(a) * r, y: this.pos.y + Math.sin(a) * r };
      // 朝 Boss 中心飛回去 = 收束感
      fx.spark(at, 1, {
        dir: { x: -Math.cos(a), y: -Math.sin(a) },
        spread: 0.2,
        speed: 300,
        life: 0.24,
        size: 3.2,
        col: [255, 90, 45],
        drag: 0.4,
      });
    }

    if (this.stateT >= this.tele(T.guardian.rampageTelegraph)) {
      fx.ring(this.pos, { r0: T.guardian.radius * 1.6, r1: 20, life: 0.2, width: 7, col: [255, 90, 45] });
      fx.flash(this.pos, 110, 0.18, [255, 90, 45]);
      this.enter('rampaging');
      this.subCount = 0;
      this.subT = 0;
      this.dashing = true;
      this.rampageDashFx();
    }
  }

  /** 每一段衝刺起步的爆發 */
  private rampageDashFx(): void {
    const back = scale(this.chargeDir, -1);
    fx.dust(this.pos, 14, { dir: back, spread: 0.85, speed: 280, size: 8, life: 0.5 });
    fx.spark(this.pos, 12, {
      dir: back,
      spread: 0.7,
      speed: 340,
      life: 0.35,
      size: 3,
      col: [255, 110, 55],
    });
    fx.debris(this.pos, 6, { dir: back, spread: 0.7, speed: 300 });
  }

  private updateRampaging(dt: number, player: Player, camera: Camera): void {
    this.subT += dt;

    if (this.dashing) {
      this.pos = add(
        this.pos,
        scale(this.chargeDir, T.guardian.rampageSpeed * this.speedMult * dt),
      );
      this.facing = { ...this.chargeDir };

      // 赤紅拖尾
      this.fxT -= dt;
      if (this.fxT <= 0) {
        this.fxT = 0.015;
        const back = scale(this.chargeDir, -1);
        fx.spark(this.pos, 2, {
          dir: back,
          spread: 0.55,
          speed: 150,
          life: 0.32,
          size: 3.2,
          col: [255, 105, 50],
          radius: T.guardian.radius * 0.6,
        });
        fx.dust(this.pos, 1, {
          dir: back,
          spread: 0.5,
          speed: 120,
          life: 0.4,
          size: 7,
          radius: T.guardian.radius * 0.6,
        });
      }

      if (dist(this.pos, player.pos) < T.guardian.radius + T.player.radius) {
        const dir = norm(sub(player.pos, this.pos));
        if (player.takeDamage(this.dmg(T.guardian.rampageDamage), dir)) camera.shake(18, 0.34);
      }

      // 撞牆只中斷這一段衝刺，不會失衡——發狂狀態下沒有免費的窗口
      const hitWall = Arena.touchingWall(this.pos, T.guardian.radius);
      if (hitWall) {
        Arena.confine(this.pos, T.guardian.radius);
        camera.shake(20, 0.3);
        const back = scale(this.chargeDir, -1);
        fx.debris(this.pos, 16, { dir: back, spread: 1.2, speed: 380, life: 0.7 });
        fx.dust(this.pos, 14, { speed: 200, size: 8, life: 0.55, radius: 30 });
        fx.ring(this.pos, { r0: 18, r1: 150, life: 0.32, width: 8, col: [255, 130, 70] });
        fx.flash(this.pos, 100, 0.18, [255, 140, 80]);
      }

      if (hitWall || this.subT >= T.guardian.rampageDashTime) {
        this.dashing = false;
        this.subT = 0;
        this.subCount++;
      }
    } else {
      if (this.subCount >= T.guardian.rampageDashes) {
        this.enterRecover(T.guardian.rampageRecover);
        return;
      }
      // 間隔中重新鎖定玩家
      this.faceToward(player.pos, 16, dt);
      if (this.subT >= T.guardian.rampageGap) {
        this.chargeDir = { ...this.facing };
        this.dashing = true;
        this.subT = 0;
        this.rampageDashFx();
      }
    }
  }

  // ── 招式 8：普攻（拳擊連段）──────────────────────────────

  private punchPoint(): Vec {
    return add(this.pos, scale(this.facing, T.guardian.punchReach));
  }

  private heavyPoint(): Vec {
    return add(this.pos, scale(this.facing, T.guardian.heavyReach));
  }

  private updateTelegraphPunch(dt: number, _player: Player): void {
    // 方向在選招當下已經鎖定（見 updateIdle），這裡整段預警都不再轉向玩家
    if (this.stateT >= T.guardian.punchTelegraph) {
      this.subCount = 0;
      this.subT = 0;
      this.enter('punching');
    }
  }

  private updatePunching(dt: number, player: Player, camera: Camera): void {
    // 兩拳跟蓄力重擊共用選招當下鎖定的方向，整段連段不再轉向玩家
    this.subT -= dt;
    if (this.subT <= 0) {
      this.doPunch(player, camera);
      this.subCount++;
      if (this.subCount >= 2) {
        this.enter('telegraphHeavyPunch');
      } else {
        this.subT = T.guardian.punchInterval;
      }
    }
  }

  private doPunch(player: Player, camera: Camera): void {
    const p = this.punchPoint();
    camera.shake(9, 0.16);
    fx.debris(p, 7, { speed: 220, life: 0.4, radius: 8 });
    fx.spark(p, 9, { speed: 260, life: 0.28, size: 2.4, col: [205, 210, 225] });
    fx.flash(p, T.guardian.punchRadius * 0.6, 0.14, [210, 215, 230]);

    if (player.alive && dist(p, player.pos) < T.guardian.punchRadius + T.player.radius) {
      const dir = norm(sub(player.pos, p));
      player.takeDamage(
        this.dmg(T.guardian.punchDamage),
        dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir,
      );
    }
  }

  private updateTelegraphHeavyPunch(dt: number, player: Player, camera: Camera): void {
    // 沿用連段鎖定的方向，不再轉向玩家
    if (this.stateT >= T.guardian.heavyTelegraph) {
      const p = this.heavyPoint();
      camera.shake(20, 0.34);
      fx.debris(p, 18, { speed: 350, life: 0.65, radius: 15 });
      fx.dust(p, 14, { speed: 210, size: 8, life: 0.55, radius: 22 });
      fx.ring(p, { r0: 12, r1: T.guardian.heavyRadius, life: 0.32, width: 9, col: [255, 150, 80], ground: true });
      fx.flash(p, T.guardian.heavyRadius * 0.7, 0.24, [255, 175, 105]);

      if (player.alive && dist(p, player.pos) < T.guardian.heavyRadius + T.player.radius) {
        const dir = norm(sub(player.pos, p));
        player.takeDamage(
          this.dmg(T.guardian.heavyDamage),
          dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir,
        );
      }
      this.enterRecover(T.guardian.heavyRecover);
    }
  }

  // ── 受傷與部位破壞 ──────────────────────────────────────

  /**
   * 用斬擊軌跡線段判定命中。判定優先序：暴露的核心 > 最近的未破壞部位 > 身體。
   * @param baseDamage 斬擊方案算出的原始傷害（同時作為部位的破壞值累積量）
   * @param _playerPos 石之守衛用不到——這個參數只是為了跟 Puppeteer.tryHit 共用同一組呼叫簽章，
   *   讓 main.ts 可以用 `AnyBoss` 聯合型別統一呼叫，不必判斷是哪一種 Boss
   */
  tryHit(a: Vec, b: Vec, baseDamage: number, _playerPos: Vec): HitResult | null {
    if (!this.alive) return null;

    const HR = T.slash.hitRadius;

    // 1. 暴露的核心最優先
    if (this.coreExposed) {
      const core = this.corePos;
      if (distPointSeg(core, a, b) < T.guardian.coreRadius + HR) {
        const dmg = baseDamage * T.guardian.coreMult;
        this.applyDamage(dmg);
        return { damage: dmg, kind: 'core', broke: false, point: core };
      }
    }

    const fa = this.facingAngle;

    // 2. 已破壞部位留下的裸露傷口 —— 永久弱點，優先於裝甲判定。
    //    優先的理由：玩家是「刻意瞄準傷口」，不該因為旁邊的裝甲剛好更近而被吃掉。
    let wound: BodyPart | null = null;
    let woundD = Infinity;
    for (const p of this.parts.list) {
      if (!p.broken) continue;
      const wp = p.worldPos(this.pos, fa);
      const d = distPointSeg(wp, a, b);
      if (d < p.def.radius + HR && d < woundD) {
        wound = p;
        woundD = d;
      }
    }

    if (wound) {
      const dmg = baseDamage * T.guardian.brokenPartMult;
      this.applyDamage(dmg);
      return {
        damage: dmg,
        kind: 'wound',
        partId: wound.id,
        partLabel: wound.def.label,
        broke: false,
        point: wound.worldPos(this.pos, fa),
      };
    }

    // 3. 最近的未破壞裝甲部位
    let best: BodyPart | null = null;
    let bestD = Infinity;
    for (const p of this.parts.list) {
      if (p.broken) continue;
      // 核心已暴露時，正前方的判定歸核心（上面已處理），護甲不再吃這一刀
      if (p.id === 'coreShell' && this.coreExposed) continue;
      const wp = p.worldPos(this.pos, fa);
      const d = distPointSeg(wp, a, b);
      if (d < p.def.radius + HR && d < bestD) {
        best = p;
        bestD = d;
      }
    }

    if (best) {
      const broke = best.applyDamage(baseDamage);
      let dmg = baseDamage * best.def.dmgMult;
      if (broke) {
        dmg += best.def.integrity * T.guardian.partBreakBonusDamage;
        this.onPartBroken();
      }
      this.applyDamage(dmg);
      return {
        damage: dmg,
        kind: 'part',
        partId: best.id,
        partLabel: best.def.label,
        broke,
        point: best.worldPos(this.pos, fa),
      };
    }

    // 4. 身體
    if (distPointSeg(this.pos, a, b) < T.guardian.radius + HR) {
      const dmg = baseDamage * T.guardian.bodyMult;
      this.applyDamage(dmg);
      return { damage: dmg, kind: 'body', broke: false, point: { ...this.pos } };
    }

    return null;
  }

  private onPartBroken(): void {
    this.breakFlash = 1;

    // 部位破壞是整場最重要的事件，特效份量要對得起它：
    // 石塊崩解 + 內部能量爆發 + 雙層衝擊環 + 強閃光
    fx.debris(this.pos, 26, { speed: 400, life: 0.9, radius: T.guardian.radius * 0.7 });
    fx.spark(this.pos, 34, {
      speed: 330,
      life: 0.6,
      size: 3.4,
      col: [255, 140, 60],
      radius: T.guardian.radius * 0.5,
    });
    fx.dust(this.pos, 18, { speed: 190, size: 8, life: 0.6, radius: T.guardian.radius * 0.6 });
    fx.ring(this.pos, { r0: 20, r1: 190, life: 0.42, width: 11, col: [255, 120, 60] });
    fx.ring(this.pos, { r0: 8, r1: 90, life: 0.26, width: 6, col: [255, 225, 170] });
    fx.flash(this.pos, 165, 0.3, [255, 130, 60]);
    // 打斷當前動作進入踉蹌；但撞牆硬直不打斷——那是玩家好不容易換來的輸出窗口
    if (this.state !== 'stunned' && this.alive) {
      this.stomps = [];
      this.dashing = false;
      this.enter('stagger');
    }
  }

  private applyDamage(n: number): void {
    this.hp = Math.max(0, this.hp - n);
    this.hitFlash = 1;
    if (this.hp <= 0) {
      this.state = 'dead';
      this.stateT = 0;
    }
  }

  reset(pos: Vec): void {
    this.pos = { x: pos.x, y: pos.y };
    this.hp = T.guardian.maxHp;
    this.state = 'idle';
    this.stateT = 0;
    this.facing = { x: 0, y: -1 };
    this.chargeDir = { x: 0, y: 0 };
    this.hitFlash = 0;
    this.breakFlash = 0;
    this.lastAttack = null;
    this.subCount = 0;
    this.subT = 0;
    this.dashing = false;
    this.stomps = [];
    this.embers = [];
    this.time = 0;
    this.parts.reset();
    this.projectiles.clear();
  }

  // ── 發狂的火星 ──────────────────────────────────────────

  private updateEmbers(dt: number): void {
    // 憤怒越高，身上持續冒出的火星越多
    if (this.alive && this.rage > 0) {
      const rate = this.rage * 16;
      if (Math.random() < rate * dt) {
        const a = Math.random() * Math.PI * 2;
        const r = T.guardian.radius * (0.4 + Math.random() * 0.6);
        this.embers.push({
          pos: { x: this.pos.x + Math.cos(a) * r, y: this.pos.y + Math.sin(a) * r },
          vel: { x: (Math.random() - 0.5) * 40, y: -30 - Math.random() * 70 },
          life: 0.4 + Math.random() * 0.5,
          size: 1.2 + Math.random() * 2.2,
        });
      }
    }

    for (const e of this.embers) {
      e.life -= dt;
      e.pos.x += e.vel.x * dt;
      e.pos.y += e.vel.y * dt;
      e.vel.x *= 1 - dt * 2.2;
      e.vel.y *= 1 - dt * 2.2;
    }
    this.embers = this.embers.filter((e) => e.life > 0);
  }

  // ── 繪製 ────────────────────────────────────────────────

  /** 地面層：攻擊預警與所有危險物，畫在實體底下 */
  drawGround(ctx: CanvasRenderingContext2D): void {
    this.projectiles.drawGround(ctx);
    if (!this.alive) return;

    // 憤怒時腳下的紅色地光
    if (this.rage > 0) {
      const k = this.rageRatio * (0.55 + 0.45 * Math.sin(this.time * 4));
      const g = ctx.createRadialGradient(
        this.pos.x,
        this.pos.y,
        0,
        this.pos.x,
        this.pos.y,
        T.guardian.radius * 2.6,
      );
      g.addColorStop(0, `rgba(255,70,40,${0.2 * k})`);
      g.addColorStop(1, 'rgba(255,70,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, T.guardian.radius * 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    switch (this.state) {
      case 'telegraphCharge': {
        const p = clamp(this.stateT / this.tele(T.guardian.chargeTelegraph), 0, 1);
        this.laneTelegraph(ctx, this.chargeDir, T.guardian.radius, 0.06 + p * 0.18);
        break;
      }

      case 'telegraphRampage': {
        const p = clamp(this.stateT / this.tele(T.guardian.rampageTelegraph), 0, 1);
        // 狂暴連撞用更濃的預警，且會抖動
        const jitter = { x: this.chargeDir.x, y: this.chargeDir.y };
        this.laneTelegraph(ctx, jitter, T.guardian.radius * 1.05, 0.12 + p * 0.28);
        break;
      }

      case 'telegraphSlam': {
        const p = clamp(this.stateT / this.tele(T.guardian.slamTelegraph), 0, 1);
        this.ringTelegraph(ctx, this.pos, T.guardian.slamRadius, p, 255, 120, 60);
        break;
      }

      case 'telegraphSweep': {
        const p = clamp(this.stateT / this.tele(T.guardian.sweepTelegraph), 0, 1);
        const a0 = this.facingAngle - T.guardian.sweepHalfAngle;
        const a1 = this.facingAngle + T.guardian.sweepHalfAngle;

        ctx.fillStyle = `rgba(255,100,80,${0.08 + p * 0.2})`;
        ctx.beginPath();
        ctx.moveTo(this.pos.x, this.pos.y);
        ctx.arc(this.pos.x, this.pos.y, T.guardian.sweepRadius, a0, a1);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = `rgba(255,160,120,${0.35 + p * 0.5})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        break;
      }

      case 'telegraphQuake': {
        const p = clamp(this.stateT / this.tele(T.guardian.quakeTelegraph), 0, 1);
        ctx.strokeStyle = `rgba(255,90,50,${0.25 + p * 0.55})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, 250 * (1 - p) + 70, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = `rgba(255,70,40,${p * 0.13})`;
        ctx.beginPath();
        ctx.arc(this.pos.x, this.pos.y, 800, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'stomping': {
        for (const s of this.stomps) {
          const warn = this.tele(T.guardian.stompWarn);
          const p = clamp(1 - s.timer / warn, 0, 1);
          this.ringTelegraph(ctx, s.pos, T.guardian.stompRadius, p, 255, 140, 70);
        }
        break;
      }

      case 'telegraphPunch': {
        const p = clamp(this.stateT / T.guardian.punchTelegraph, 0, 1);
        this.ringTelegraph(ctx, this.punchPoint(), T.guardian.punchRadius, p, 210, 212, 226);
        break;
      }

      case 'telegraphHeavyPunch': {
        const p = clamp(this.stateT / T.guardian.heavyTelegraph, 0, 1);
        this.ringTelegraph(ctx, this.heavyPoint(), T.guardian.heavyRadius, p, 255, 150, 80);
        break;
      }

      default:
        break;
    }
  }

  private laneTelegraph(
    ctx: CanvasRenderingContext2D,
    dir: Vec,
    half: number,
    alpha: number,
  ): void {
    const side = { x: -dir.y, y: dir.x };
    const p0 = add(this.pos, scale(side, half));
    const p1 = add(p0, scale(dir, 1600));
    const p2 = add(add(this.pos, scale(side, -half)), scale(dir, 1600));
    const p3 = add(this.pos, scale(side, -half));

    ctx.fillStyle = `rgba(255,80,80,${alpha})`;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();
  }

  private ringTelegraph(
    ctx: CanvasRenderingContext2D,
    at: Vec,
    radius: number,
    p: number,
    r: number,
    g: number,
    b: number,
  ): void {
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.35 + p * 0.5})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = `rgba(${r},${g - 30},${b - 20},${0.1 + p * 0.16})`;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius * p, 0, Math.PI * 2);
    ctx.fill();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const RAD = T.guardian.radius;
    const dead = !this.alive;
    const rageK = this.rageRatio;

    // 影子
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y + RAD * 0.55, RAD, RAD * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    // 抖動：硬直、踉蹌、蓄力連撞，以及憤怒帶來的持續顫動
    let ox = 0;
    let oy = 0;
    if (this.state === 'stunned') {
      ox = Math.sin(this.stateT * 34) * 3;
      oy = Math.cos(this.stateT * 27) * 2;
    } else if (this.state === 'stagger') {
      const k = 1 - this.stateT / T.guardian.staggerTime;
      ox = Math.sin(this.stateT * 46) * 5 * k;
      oy = Math.cos(this.stateT * 39) * 3 * k;
    } else if (this.state === 'telegraphRampage') {
      ox = (Math.random() - 0.5) * 7;
      oy = (Math.random() - 0.5) * 7;
    } else if (rageK > 0 && !dead) {
      ox = Math.sin(this.time * 26) * rageK * 1.9;
      oy = Math.cos(this.time * 21) * rageK * 1.4;
    }

    // 憤怒外圈光暈
    if (rageK > 0 && !dead) {
      const pulse = 0.6 + 0.4 * Math.sin(this.time * 5.5);
      const glow = ctx.createRadialGradient(
        this.pos.x,
        this.pos.y,
        RAD * 0.7,
        this.pos.x,
        this.pos.y,
        RAD * (1.7 + rageK * 0.6),
      );
      glow.addColorStop(0, `rgba(255,80,40,${0.22 * rageK * pulse})`);
      glow.addColorStop(1, 'rgba(255,60,30,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, RAD * (1.7 + rageK * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(this.pos.x + ox, this.pos.y + oy);
    ctx.rotate(this.facingAngle + Math.PI / 2);

    const winding = this.state.startsWith('telegraph');

    // 本體顏色：憤怒越高越偏暗紅
    let body = '#4a4f60';
    if (dead) body = '#33363f';
    else if (this.hitFlash > 0) body = '#8e94a8';
    else if (this.state === 'stunned') body = '#5c5348';
    else if (this.state === 'stagger') body = '#6a5a52';
    else if (winding) body = '#5a4a52';

    if (!dead && rageK > 0) {
      body = this.mixRage(body, rageK);
    }

    // 部位畫在本體下面，看起來像從身體長出來
    this.parts.draw(ctx, this.coreExposed, this.time);

    ctx.fillStyle = body;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
      const rr = RAD * (i % 2 === 0 ? 1 : 0.9);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(15,16,22,0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 一般裂紋：血量越低越多
    const dmgRatio = 1 - this.hp / T.guardian.maxHp;
    ctx.strokeStyle = `rgba(20,20,26,${0.3 + dmgRatio * 0.5})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-RAD * 0.5, -RAD * 0.3);
    ctx.lineTo(-RAD * 0.1, RAD * 0.1);
    ctx.lineTo(-RAD * 0.35, RAD * 0.55);
    if (dmgRatio > 0.35) {
      ctx.moveTo(RAD * 0.45, -RAD * 0.5);
      ctx.lineTo(RAD * 0.15, -RAD * 0.05);
      ctx.lineTo(RAD * 0.5, RAD * 0.35);
    }
    if (dmgRatio > 0.7) {
      ctx.moveTo(-RAD * 0.2, -RAD * 0.8);
      ctx.lineTo(RAD * 0.05, -RAD * 0.35);
    }
    ctx.stroke();

    // ── 發狂的熔岩裂縫：憤怒等級越高越亮、越多條 ──
    if (rageK > 0 && !dead) {
      const heat = 0.55 + 0.45 * Math.sin(this.time * 6.5);
      const burst = this.breakFlash;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      ctx.strokeStyle = `rgba(255,${Math.round(110 - rageK * 50)},40,${(0.45 * rageK + burst * 0.5) * heat})`;
      ctx.lineWidth = 3 + rageK * 2.5 + burst * 3;
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.moveTo(-RAD * 0.62, -RAD * 0.18);
      ctx.lineTo(-RAD * 0.18, RAD * 0.16);
      ctx.lineTo(-RAD * 0.42, RAD * 0.62);
      if (this.rage >= 2) {
        ctx.moveTo(RAD * 0.55, -RAD * 0.42);
        ctx.lineTo(RAD * 0.12, RAD * 0.02);
        ctx.lineTo(RAD * 0.5, RAD * 0.5);
      }
      if (this.rage >= 3) {
        ctx.moveTo(-RAD * 0.1, -RAD * 0.85);
        ctx.lineTo(RAD * 0.16, -RAD * 0.3);
        ctx.lineTo(-RAD * 0.05, RAD * 0.2);
      }
      if (this.rage >= 4) {
        ctx.moveTo(-RAD * 0.75, RAD * 0.3);
        ctx.lineTo(RAD * 0.7, RAD * 0.18);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.restore();
    }

    // 核心：位於面向的正前方（旋轉後為 -y）
    const cy = -T.guardian.coreOffset;
    const cr = T.guardian.coreRadius;

    if (this.coreExposed && !dead) {
      const pulse = 0.72 + 0.28 * Math.sin(this.time * (11 + rageK * 8));
      // 憤怒時核心由金黃轉為赤紅
      const g = ctx.createRadialGradient(0, cy, 0, 0, cy, cr * 3.2);
      g.addColorStop(0, `rgba(255,${Math.round(235 - rageK * 90)},${Math.round(150 - rageK * 90)},${0.95 * pulse})`);
      g.addColorStop(0.35, `rgba(255,${Math.round(150 - rageK * 60)},60,${0.7 * pulse})`);
      g.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, cy, cr * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = rageK > 0.5 ? '#ffd0a0' : '#fff3c4';
      ctx.beginPath();
      ctx.arc(0, cy, cr, 0, Math.PI * 2);
      ctx.fill();
    } else if (dead) {
      ctx.fillStyle = '#2a2c34';
      ctx.beginPath();
      ctx.arc(0, cy, cr * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    this.drawEmbers(ctx);
    this.drawStateLabel(ctx, RAD);
  }

  /** 把基礎顏色朝暗紅推移 */
  private mixRage(hex: string, k: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const nr = Math.round(r + (150 - r) * k * 0.8);
    const ng = Math.round(g + (48 - g) * k * 0.75);
    const nb = Math.round(b + (46 - b) * k * 0.75);
    return `rgb(${nr},${ng},${nb})`;
  }

  private drawEmbers(ctx: CanvasRenderingContext2D): void {
    if (this.embers.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.embers) {
      const a = clamp(e.life, 0, 1);
      ctx.fillStyle = `rgba(255,${Math.round(120 + a * 90)},60,${a * 0.85})`;
      ctx.beginPath();
      ctx.arc(e.pos.x, e.pos.y, e.size * a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawStateLabel(ctx: CanvasRenderingContext2D, RAD: number): void {
    let text = '';
    let color = '';

    if (this.state === 'stunned') {
      const remain = Math.max(0, this.stunDur - this.stateT);
      text = '核心暴露';
      color = `rgba(255,220,120,${clamp(remain / 0.6, 0, 1) * 0.92})`;
    } else if (this.state === 'stagger') {
      text = '踉蹌';
      color = `rgba(255,180,140,${clamp(1 - this.stateT / T.guardian.staggerTime, 0, 1) * 0.9})`;
    } else if (this.state === 'telegraphRampage') {
      text = '狂暴';
      color = `rgba(255,110,70,${0.6 + 0.4 * Math.sin(this.time * 22)})`;
    } else if (this.parts.isBroken('coreShell') && this.alive) {
      text = '核心裸露';
      color = 'rgba(255,205,110,0.55)';
    }

    if (!text) return;

    ctx.fillStyle = color;
    ctx.font = 'bold 15px "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, this.pos.x, this.pos.y - RAD - 20);
    ctx.textAlign = 'left';
  }

  /** 實體層的附加物（飛行中的石塊），畫在 Boss 之後 */
  drawProjectiles(ctx: CanvasRenderingContext2D): void {
    this.projectiles.draw(ctx);
  }
}
