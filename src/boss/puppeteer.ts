/**
 * 第二隻 Boss：傀儡師（Puppeteer）。#012 全面重做。
 *
 * ── 核心設計：跟石之守衛完全相反的命中模型 ──────────────
 *  沒有部位、沒有核心/護甲倍率分層——打到本體就是全額傷害（bodyMult 1.0）。
 *  她的難度來自「打得到」而不是「打得對」。
 *
 * ── 核心玩法：斬擊是唯一的閃避＋前進手段 ─────────────────
 *  地面危險空間被壓縮，玩家要靠斬擊的位移無敵幀穿梭到安全點，一路逼近本體。
 *  場上會有「特殊傀儡」（見 `puppets.ts` 的 `SpecialPuppet`）：不攻擊、
 *  玩家靠近會延遲爆炸，但被斬中會回復體力——斬擊因此同時兼顧移動/閃避/輸出/資源回收。
 *
 * ── 血量三階段 ───────────────────────────────────────────
 *  0..2 三個階段（依血量比例），越低越具攻擊性，逐階解鎖新招式。
 *
 * ── 招式 ─────────────────────────────────────────────────
 *  全程 招式a 放射狀路徑：向外打出等角度間隔的路徑，路徑間隙藏特殊傀儡
 *  全程 招式b 前撲扇形＋後跳＋留特殊傀儡（基本招，教玩家「特殊傀儡可以斬」）
 *  全程 招式b' 前撲扇形，不後跳（另一種基本招，打完留在原地不撤）
 *  階段1 招式e 小型旋轉環：原地召喚一圈公轉危險物，其中一格是特殊傀儡，
 *          是招式d 的低風險預告版
 *  階段2 招式c 傳送到玩家對面＋全場穿越＋暈眩：只留數條安全走廊，打中本體會暈眩她
 *  階段2 招式d 中心推牆＋旋轉環（進最終階段強制開場）：一圈公轉危險物裡藏一隻會動的特殊傀儡
 *
 * ── 終局處決（全場僅觸發一次）─────────────────────────────
 *  最終階段血量跌到「階段內剩一半」時強制觸發、鎖血：跳到場地中心，把玩家直線推到
 *  牆邊，全場鋪滿危險物只留一串安全圓（間距在斬擊可達範圍內，一路跳過去終究打得到
 *  本體）。沒有時間限制，打中本體會觸發放大/慢動作的處決演出，之後她直接死亡。
 */

import { T } from '../tuning.ts';
import { Arena } from '../arena.ts';
import { fx } from '../fx.ts';
import type { Camera } from '../core/camera.ts';
import type { Player } from '../player.ts';
import { Puppets } from './puppets.ts';
import type { HitResult } from './types.ts';
import {
  add,
  clamp,
  damp,
  dist,
  distPointSeg,
  len,
  norm,
  scale,
  sub,
  type Vec,
} from '../core/vec.ts';

export type PuppeteerState =
  | 'idle'
  | 'recover'
  | 'opening'
  | 'telegraphRadial'
  | 'telegraphLunge'
  | 'lunging'
  | 'hopBack'
  | 'telegraphPress'
  | 'pressing'
  | 'telegraphSpin'
  | 'spinning'
  | 'telegraphGauntlet'
  | 'gauntletActive'
  | 'stunned'
  | 'telegraphCenter'
  | 'centerActive'
  | 'telegraphExecute'
  | 'executeActive'
  | 'executing'
  | 'dead';

/** 兩角度差，正規化到 -π..π（跟 guardian.ts/puppets.ts 各自獨立一份，避免跨檔互相依賴） */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Puppeteer {
  pos: Vec;
  hp: number = T.puppeteer.maxHp;
  readonly name = '傀儡師';

  state: PuppeteerState = 'idle';
  private stateT = 0;

  facing: Vec = { x: 0, y: 1 };

  readonly puppets = new Puppets();

  hitFlash = 0;

  private recoverTime = 0.5;
  private lastAttack: PuppeteerState | null = null;

  /** 招式a（放射狀路徑）用：選招當下就鎖定，預警畫的角度跟實際出招角度保證一致 */
  private radialBaseAngle = 0;

  /** 招式b（前撲）用：後跳的起訖點 */
  private hopFrom: Vec = { x: 0, y: 0 };
  private hopTo: Vec = { x: 0, y: 0 };

  /** 招式c（全場穿越）用：這波場地是否已經灑出、給繪製用的走廊角度 */
  private gauntletFieldSpawned = false;
  private gauntletCorridors: number[] = [];

  /** 連續出招次數，達門檻進入一段明顯更長的破綻（見 finishAttack） */
  private attacksSinceOpening = 0;

  /** 是否已經在最終階段強制放過開場的招式d（每輪只觸發一次） */
  private centerIntroDone = false;

  /** 終局處決：是否已經觸發過（鎖血用）、下一幀是否要強制切進處決序列、安全圓路徑 */
  private executeTriggered = false;
  private executePending = false;
  private executePath: Vec[] = [];

  private time = 0;

  constructor(pos: Vec) {
    this.pos = { x: pos.x, y: pos.y };
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get facingAngle(): number {
    return Math.atan2(this.facing.y, this.facing.x);
  }

  /** 是否正在讀招/攻擊中（給場外提示用的粗略判斷，不逐招式細分） */
  get isThreatening(): boolean {
    return this.state !== 'idle' && this.state !== 'recover' && this.state !== 'opening';
  }

  // ── 階段 ────────────────────────────────────────────────

  /** 階段 0..2，依血量比例；HUD 沿用 rage/rageRatio 的欄位名稱顯示 */
  get phase(): number {
    const ratio = this.hp / T.puppeteer.maxHp;
    if (ratio <= T.puppeteer.phase3Hp) return 2;
    if (ratio <= T.puppeteer.phase2Hp) return 1;
    return 0;
  }

  get rage(): number {
    return this.phase;
  }

  get rageRatio(): number {
    return this.phase / 2;
  }

  private get idleWait(): number {
    return T.puppeteer.idleTime * T.puppeteer.idleTimeMultByPhase[this.phase];
  }

  private get dmgMult(): number {
    return T.puppeteer.dmgMultByPhase[this.phase];
  }

  private dmg(base: number): number {
    return base * this.dmgMult;
  }

  // ── 更新 ────────────────────────────────────────────────

  update(dt: number, player: Player, camera: Camera): void {
    this.time += dt;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);

    this.puppets.update(dt, player);

    if (!this.alive) return;

    // 終局處決在鎖血的那一刻就排定了，這裡強制打斷她當下正在做的任何事——
    // 瀕死的最後一搏，不等目前招式播完
    if (this.executePending) {
      this.executePending = false;
      this.beginExecuteSequence(camera);
    }

    this.stateT += dt;

    switch (this.state) {
      case 'idle':
        this.updateIdle(dt, player);
        break;
      case 'recover':
        if (this.stateT >= this.recoverTime) this.enter('idle');
        break;
      case 'opening':
        if (this.stateT >= T.puppeteer.opening.duration) this.enter('idle');
        break;

      case 'telegraphRadial':
        this.updateTelegraphRadial(dt, player);
        break;

      case 'telegraphLunge':
        this.updateTelegraphLunge(dt, player);
        break;
      case 'lunging':
        this.updateLunging(player);
        break;
      case 'hopBack':
        this.updateHopBack();
        break;

      case 'telegraphPress':
        this.updateTelegraphPress(dt, player);
        break;
      case 'pressing':
        this.updatePressing(player);
        break;

      case 'telegraphSpin':
        this.updateTelegraphSpin(dt, player);
        break;
      case 'spinning':
        if (this.stateT >= T.puppeteer.spin.ringDuration) {
          this.puppets.clearHazards();
          this.finishAttack(T.puppeteer.spin.recover);
        }
        break;

      case 'telegraphGauntlet':
        this.updateTelegraphGauntlet(dt, player, camera);
        break;
      case 'gauntletActive':
        this.updateGauntletActive(dt, player);
        break;
      case 'stunned':
        if (this.stateT >= T.puppeteer.gauntlet.stunDuration) {
          this.enterRecover(T.puppeteer.gauntlet.recover);
        }
        break;

      case 'telegraphCenter':
        this.updateTelegraphCenter(dt, player, camera);
        break;
      case 'centerActive':
        if (this.stateT >= T.puppeteer.center.ringDuration) {
          this.puppets.clearHazards();
          this.finishAttack(T.puppeteer.center.recover);
        }
        break;

      case 'telegraphExecute':
        this.updateTelegraphExecute(dt, player, camera);
        break;
      case 'executeActive':
        // 沒有時間上限——只有命中（見 tryHit）或玩家死亡才會結束
        break;
      case 'executing':
        if (this.stateT >= T.puppeteer.execute.deathDelay) {
          this.hp = 0;
          this.state = 'dead';
        }
        break;

      case 'dead':
        break;
    }

    Arena.confine(this.pos, T.puppeteer.radius);
  }

  private enter(s: PuppeteerState): void {
    this.state = s;
    this.stateT = 0;
  }

  private enterRecover(t: number): void {
    this.recoverTime = t;
    this.enter('recover');
  }

  /**
   * 出招後的收尾：大多數時候只是短暫恢復戒備，
   * 但每連續出招達到 `opening.every` 次，會換成一段明顯更長、完全靜止的破綻——
   * 讓「攻擊慾強」不等於「無懈可擊」，玩家知道窗口一定會來，只是不是每次都有。
   */
  private finishAttack(recoverTime: number): void {
    this.attacksSinceOpening++;
    if (this.attacksSinceOpening >= T.puppeteer.opening.every) {
      this.attacksSinceOpening = 0;
      fx.ring(this.pos, {
        r0: 10,
        r1: T.puppeteer.radius * 1.6,
        life: 0.4,
        width: 4,
        col: [170, 255, 190],
      });
      fx.flash(this.pos, T.puppeteer.radius * 1.2, 0.25, [180, 255, 200]);
      this.enter('opening');
    } else {
      this.enterRecover(recoverTime);
    }
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

  // ── 待機：逼近玩家、選招 ─────────────────────────────────

  private updateIdle(dt: number, player: Player): void {
    this.faceToward(player.pos, 6, dt);

    // 持續給壓力：只有貼到幾乎面對面才會退，其餘任何距離都在往玩家身上逼近——
    // 遠了全速追，近了也用較慢速度持續貼近，不會呆站不動。
    const away = sub(this.pos, player.pos);
    const d = len(away);
    if (d < T.puppeteer.retreatDist) {
      const dir = d > 1 ? norm(away) : { x: 0, y: -1 };
      this.pos = add(this.pos, scale(dir, T.puppeteer.kiteSpeed * dt));
    } else {
      const dir = d > 1 ? norm(scale(away, -1)) : { ...this.facing };
      const speed =
        d > T.puppeteer.approachDist
          ? T.puppeteer.approachSpeed
          : T.puppeteer.approachSpeed * T.puppeteer.creepSpeedMult;
      this.pos = add(this.pos, scale(dir, speed * dt));
    }

    if (this.stateT >= this.idleWait) {
      // 剛跨入最終階段：不透過加權隨機，強制先放一次招式d，
      // 確保玩家一定會看到這個階段的招牌動作，不是完全看運氣
      if (this.phase === 2 && !this.centerIntroDone) {
        this.centerIntroDone = true;
        this.lastAttack = 'telegraphCenter';
        // 方向在選招當下就鎖定，整段預警不再轉向玩家
        this.snapFacing(player.pos);
        this.enter('telegraphCenter');
        return;
      }

      // 沒有任何招式打得到人時（例如玩家一直拉開距離）不勉強出招——
      // 繼續逼近，等真的到了打得到的距離再攻擊
      const next = this.pickAttack(player);
      if (next) {
        this.lastAttack = next;
        this.snapFacing(player.pos);
        // 放射狀路徑的角度也在選招當下鎖定，跟方向鎖定同一個原則：
        // 預警畫出來的就是最終結果，不是等出招瞬間才重新隨機
        if (next === 'telegraphRadial') this.radialBaseAngle = Math.random() * Math.PI * 2;
        this.enter(next);
      }
    }
  }

  /**
   * 依階段與距離加權隨機選招，避免連續出同一招。
   * 招式a（放射狀路徑）以全場為範圍，隨時可用；招式b／b'（前撲）是近戰基本招，
   * 只有打得到人的距離才列入候選，且不受「避免連續同招」限制，可以連續使用。
   */
  private pickAttack(player: Player): PuppeteerState | null {
    const phase = this.phase;
    const d = dist(this.pos, player.pos);

    const cands: Array<[PuppeteerState, number]> = [['telegraphRadial', 2.2]];
    if (d < T.puppeteer.lunge.radius + 40) {
      cands.push(['telegraphLunge', 2.6]);
    }
    if (d < T.puppeteer.press.radius + 40) {
      cands.push(['telegraphPress', 2.6]);
    }
    if (phase >= T.puppeteer.spin.unlockPhase) cands.push(['telegraphSpin', 2.0]);
    if (phase >= T.puppeteer.gauntlet.unlockPhase) cands.push(['telegraphGauntlet', 2.2]);
    if (phase >= T.puppeteer.center.unlockPhase) cands.push(['telegraphCenter', 1.6]);

    // 普攻（前撲兩種）不受「避免連續同招」限制，可以連續使用
    const isBasic = (s: PuppeteerState) => s === 'telegraphLunge' || s === 'telegraphPress';
    let total = 0;
    const weighted = cands.map(([s, w]) => {
      const adj = s === this.lastAttack && !isBasic(s) ? w * 0.35 : w;
      total += adj;
      return [s, adj] as [PuppeteerState, number];
    });

    if (total <= 0) return null;

    let roll = Math.random() * total;
    for (const [s, w] of weighted) {
      roll -= w;
      if (roll <= 0) return s;
    }
    return null;
  }

  // ── 招式a：放射狀路徑（全程可用）──────────────────────────

  private updateTelegraphRadial(dt: number, _player: Player): void {
    const cfg = T.puppeteer.radial;

    if (this.stateT >= cfg.telegraph) {
      // 用選招當下就鎖定的角度（見 updateIdle），不是這裡重新隨機——
      // 保證預警畫出來的路徑跟實際出招的路徑是同一組
      const baseAngle = this.radialBaseAngle;
      for (let i = 0; i < cfg.rayCount; i++) {
        this.puppets.spawnRay(this.pos, baseAngle + (i / cfg.rayCount) * Math.PI * 2, this.dmg(cfg.damage));
      }
      // 每兩條路徑的中間空隙都放一隻特殊傀儡
      for (let i = 0; i < cfg.rayCount; i++) {
        const mid = baseAngle + ((i + 0.5) / cfg.rayCount) * Math.PI * 2;
        const pos = add(this.pos, { x: Math.cos(mid) * cfg.specialDist, y: Math.sin(mid) * cfg.specialDist });
        Arena.confine(pos, 20);
        this.puppets.spawnSpecial(pos, T.puppeteer.special.life);
      }
      fx.flash(this.pos, 90, 0.2, [200, 150, 220]);
      this.finishAttack(cfg.recover);
    }
  }

  // ── 招式b：前撲扇形＋後跳＋留特殊傀儡（全程可用，基本招）────

  private updateTelegraphLunge(dt: number, _player: Player): void {
    // 方向在選招當下已經鎖定（見 updateIdle），這裡整段預警都不再轉向玩家
    if (this.stateT >= T.puppeteer.lunge.telegraph) {
      this.enter('lunging');
    }
  }

  private updateLunging(player: Player): void {
    const cfg = T.puppeteer.lunge;
    this.forwardStrike(player, cfg.halfAngle, cfg.radius, cfg.damage);

    this.hopFrom = { x: this.pos.x, y: this.pos.y };
    this.hopTo = add(this.pos, scale(this.facing, -cfg.hopDistance));
    Arena.confine(this.hopTo, T.puppeteer.radius);
    this.enter('hopBack');
  }

  /** 一記扇形近戰命中判定，以她自己為中心、朝目前面向——招式b／招式b' 共用 */
  private forwardStrike(player: Player, halfAngle: number, radius: number, damage: number): void {
    const fa = this.facingAngle;

    fx.arc(this.pos, fa, halfAngle, 10, radius, 0.22, [195, 140, 220], 1);
    fx.spark(this.pos, 10, {
      dir: this.facing,
      spread: halfAngle,
      speed: 300,
      life: 0.26,
      size: 2.4,
      col: [215, 165, 235],
    });

    if (player.alive) {
      const d = dist(this.pos, player.pos);
      if (d < radius + T.player.radius) {
        const a = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);
        if (Math.abs(angleDiff(a, fa)) < halfAngle) {
          player.takeDamage(this.dmg(damage), norm(sub(player.pos, this.pos)));
        }
      }
    }
  }

  // ── 招式b'：前撲扇形，不後跳（全程可用，另一種基本招）────

  private updateTelegraphPress(dt: number, _player: Player): void {
    // 方向在選招當下已經鎖定（見 updateIdle），這裡整段預警都不再轉向玩家
    if (this.stateT >= T.puppeteer.press.telegraph) {
      this.enter('pressing');
    }
  }

  private updatePressing(player: Player): void {
    const cfg = T.puppeteer.press;
    this.forwardStrike(player, cfg.halfAngle, cfg.radius, cfg.damage);
    this.finishAttack(cfg.recover);
  }

  private updateHopBack(): void {
    const p = clamp(this.stateT / T.puppeteer.lunge.hopDuration, 0, 1);
    this.pos.x = this.hopFrom.x + (this.hopTo.x - this.hopFrom.x) * p;
    this.pos.y = this.hopFrom.y + (this.hopTo.y - this.hopFrom.y) * p;
    if (p >= 1) {
      // 原地（她出招時的位置）留下一隻特殊傀儡
      this.puppets.spawnSpecial(this.hopFrom, T.puppeteer.special.life);
      this.finishAttack(T.puppeteer.lunge.recover);
    }
  }

  // ── 招式e：小型旋轉環（階段1解鎖）─────────────────────────
  // 原地召喚一圈公轉危險物（比招式d 小、少、短），其中一格是特殊傀儡——
  // 在正式面對招式d 之前，先讓玩家練習「抓時機貼近旋轉中的特殊傀儡」這件事。

  private updateTelegraphSpin(dt: number, _player: Player): void {
    if (this.stateT >= T.puppeteer.spin.telegraph) {
      const cfg = T.puppeteer.spin;
      this.puppets.spawnOrbitRing(
        this.pos,
        cfg.ringRadius,
        cfg.ringCount,
        cfg.ringSpeed,
        this.dmg(cfg.ringDamage),
        cfg.ringDuration,
        Math.random() * Math.PI * 2,
      );
      this.enter('spinning');
    }
  }

  // ── 招式c：傳送對面＋全場穿越＋暈眩（階段2解鎖）───────────

  private updateTelegraphGauntlet(dt: number, player: Player, camera: Camera): void {
    if (this.stateT >= T.puppeteer.gauntlet.telegraph) {
      // 傳送到「玩家位置以競技場中心鏡射」的位置
      const target: Vec = {
        x: Arena.w - player.pos.x,
        y: Arena.h - player.pos.y,
      };
      Arena.confine(target, T.puppeteer.radius);
      this.pos = target;
      camera.shake(18, 0.35);
      fx.flash(this.pos, 100, 0.25, [200, 150, 220]);

      // 走廊角度在傳送當下就鎖定，不是等場地正式啟動才算——
      // 讓 fieldDelay 這段緩衝真的是「玩家看得到真實走廊在哪」的預警時間，
      // 而不是憑空倒數完才突然決定安全區在哪
      this.computeGauntletCorridors(player);
      this.gauntletFieldSpawned = false;
      this.enter('gauntletActive');
    }
  }

  private updateGauntletActive(dt: number, player: Player): void {
    const cfg = T.puppeteer.gauntlet;

    if (!this.gauntletFieldSpawned && this.stateT >= cfg.fieldDelay) {
      this.gauntletFieldSpawned = true;
      this.spawnGauntletField();
    }

    if (this.stateT >= cfg.duration) {
      this.puppets.clearHazards();
      this.finishAttack(cfg.recover);
    }
  }

  /** 走廊角度：其中一條保證是本體→玩家的最短直線，鎖定後直到收招都不再變 */
  private computeGauntletCorridors(player: Player): void {
    const cfg = T.puppeteer.gauntlet;
    const dirToPlayer = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);
    this.gauntletCorridors = [];
    for (let i = 0; i < cfg.corridorCount; i++) {
      this.gauntletCorridors.push(dirToPlayer + (i * Math.PI * 2) / cfg.corridorCount);
    }
  }

  /** 鋪滿全場的脈衝傀儡，避開 `computeGauntletCorridors()` 早就鎖定好的安全走廊 */
  private spawnGauntletField(): void {
    const cfg = T.puppeteer.gauntlet;
    const inCorridor = (a: number) =>
      this.gauntletCorridors.some((c) => Math.abs(angleDiff(a, c)) < cfg.corridorHalfAngle);

    const life = cfg.duration - cfg.fieldDelay;
    for (let gx = cfg.gridSpacing / 2; gx < Arena.w; gx += cfg.gridSpacing) {
      for (let gy = cfg.gridSpacing / 2; gy < Arena.h; gy += cfg.gridSpacing) {
        const angle = Math.atan2(gy - this.pos.y, gx - this.pos.x);
        if (inCorridor(angle)) continue;
        this.puppets.spawnPulse({ x: gx, y: gy }, life);
      }
    }

    for (const c of this.gauntletCorridors) {
      for (let i = 1; i <= cfg.specialPerCorridor; i++) {
        const pos = add(this.pos, {
          x: Math.cos(c) * (140 + i * 180),
          y: Math.sin(c) * (140 + i * 180),
        });
        Arena.confine(pos, 20);
        this.puppets.spawnSpecial(pos, T.puppeteer.special.life);
      }
    }
  }

  // ── 招式d：中心推牆＋旋轉環（階段2解鎖，最終階段開場強制招）──

  private updateTelegraphCenter(dt: number, player: Player, camera: Camera): void {
    if (this.stateT >= T.puppeteer.center.telegraph) {
      this.pos = { x: Arena.w / 2, y: Arena.h / 2 };
      this.centerPush(player, camera);

      const cfg = T.puppeteer.center;
      this.puppets.spawnOrbitRing(
        this.pos,
        cfg.ringRadius,
        cfg.ringCount,
        cfg.ringSpeed,
        this.dmg(cfg.ringDamage),
        cfg.ringDuration,
        Math.random() * Math.PI * 2,
      );
      this.enter('centerActive');
    }
  }

  private centerPush(player: Player, camera: Camera): void {
    const cfg = T.puppeteer.center;
    camera.shake(24, 0.42);
    fx.ring(this.pos, { r0: 10, r1: cfg.pushRadius, life: 0.4, width: 10, col: [190, 130, 210], ground: true });
    fx.debris(this.pos, 14, { speed: 320, life: 0.6, radius: 16 });
    fx.flash(this.pos, cfg.pushRadius * 0.55, 0.26, [210, 150, 230]);

    if (player.alive && dist(this.pos, player.pos) < cfg.pushRadius + T.player.radius) {
      const dir = norm(sub(player.pos, this.pos));
      player.takeDamage(this.dmg(cfg.pushDamage), dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir);
    }
  }

  // ── 終局處決（全場僅觸發一次）─────────────────────────────

  /** 強制打斷目前狀態，進入處決前搖——由 `update()` 在偵測到 `executePending` 時呼叫 */
  private beginExecuteSequence(camera: Camera): void {
    this.puppets.clear();
    camera.shake(26, 0.5);
    fx.flash(this.pos, 140, 0.3, [220, 160, 240]);
    this.enter('telegraphExecute');
  }

  private updateTelegraphExecute(dt: number, player: Player, camera: Camera): void {
    if (this.stateT >= T.puppeteer.execute.telegraph) {
      // 她跳到場地正中央
      this.pos = { x: Arena.w / 2, y: Arena.h / 2 };

      // 玩家沿「本體（現在在中心）→玩家」方向直線推到牆邊
      const away = sub(player.pos, this.pos);
      const pushDir = away.x === 0 && away.y === 0 ? { x: 0, y: 1 } : norm(away);
      const pushed = add(this.pos, scale(pushDir, Math.max(Arena.w, Arena.h)));
      Arena.confine(pushed, T.player.radius);
      player.pos.x = pushed.x;
      player.pos.y = pushed.y;

      camera.shake(30, 0.55);
      fx.ring(player.pos, { r0: 10, r1: 140, life: 0.4, width: 8, col: [220, 160, 240] });
      fx.ring(this.pos, { r0: 20, r1: 260, life: 0.5, width: 12, col: [200, 140, 220], ground: true });
      fx.flash(this.pos, 170, 0.32, [210, 150, 235]);

      this.buildExecuteField(player);
      this.enter('executeActive');
    }
  }

  /** 建構安全圓路徑，鋪滿全場危險物只留安全圓，路徑上（除玩家起點外）擺特殊傀儡 */
  private buildExecuteField(player: Player): void {
    const cfg = T.puppeteer.execute;
    this.executePath = this.buildExecutePath(player.pos, this.pos);
    const inSafeZone = (p: Vec) => this.executePath.some((c) => dist(p, c) < cfg.safeRadius);

    for (let gx = cfg.gridSpacing / 2; gx < Arena.w; gx += cfg.gridSpacing) {
      for (let gy = cfg.gridSpacing / 2; gy < Arena.h; gy += cfg.gridSpacing) {
        const p: Vec = { x: gx, y: gy };
        if (inSafeZone(p)) continue;
        this.puppets.spawnPulse(p, cfg.infiniteLife);
      }
    }

    // 安全圓（除了玩家起點跟本體所在的最後一點）都放一隻特殊傀儡
    for (let i = 1; i < this.executePath.length - 1; i++) {
      this.puppets.spawnSpecial(this.executePath[i], cfg.infiniteLife);
    }
  }

  /**
   * 從玩家目前位置到本體位置，用固定步距逐步前進、加一點隨機橫向偏移，
   * 形成一串安全圓中心點——每一步都保證在斬擊可達範圍內，連通性天生成立。
   */
  private buildExecutePath(from: Vec, to: Vec): Vec[] {
    const cfg = T.puppeteer.execute;
    const path: Vec[] = [{ x: from.x, y: from.y }];
    const total = dist(from, to);
    const steps = Math.max(1, Math.ceil(total / cfg.stepDist));
    const dir = norm(sub(to, from));
    const perp: Vec = { x: -dir.y, y: dir.x };

    for (let i = 1; i <= steps; i++) {
      if (i === steps) {
        path.push({ x: to.x, y: to.y });
        break;
      }
      const t = i / steps;
      const base: Vec = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      const off = (Math.random() * 2 - 1) * cfg.jitter;
      const wp = add(base, scale(perp, off));
      Arena.confine(wp, cfg.safeRadius);
      path.push(wp);
    }
    return path;
  }

  /** 斬中本體那一刻：清場、定格，讓 main.ts 的處決演出接手 */
  private triggerExecutionHit(): void {
    this.puppets.clearHazards();
    this.enter('executing');
  }

  // ── 受傷 ────────────────────────────────────────────────

  /**
   * 用斬擊軌跡線段判定命中。跟石之守衛不同：沒有部位/核心分層，
   * 打中本體一律全額傷害。kind 回報 'core' 是刻意重用——本體命中在敘事上
   * 就是「正確、高回饋的目標」，直接沿用 main.ts 既有的金色特效與大數字回饋。
   * 終局處決期間（`executeActive`）命中不再扣血，而是直接觸發處決。
   */
  tryHit(a: Vec, b: Vec, baseDamage: number, _playerPos: Vec): HitResult | null {
    if (!this.alive) return null;

    const HR = T.slash.hitRadius;
    if (distPointSeg(this.pos, a, b) < T.puppeteer.radius + HR) {
      if (this.state === 'executeActive') {
        this.triggerExecutionHit();
        return {
          damage: 0,
          kind: 'core',
          broke: false,
          point: { x: this.pos.x, y: this.pos.y },
          executed: true,
        };
      }

      const dmg = baseDamage * T.puppeteer.bodyMult;
      this.applyDamage(dmg);
      this.maybeTriggerStun();
      return { damage: dmg, kind: 'core', broke: false, point: { x: this.pos.x, y: this.pos.y } };
    }

    return null;
  }

  /** 招式c 啟動期間打中本體 → 暈眩她幾秒，並立刻清場讓輸出窗口乾淨可打 */
  private maybeTriggerStun(): void {
    if (this.alive && this.state === 'gauntletActive' && this.gauntletFieldSpawned) {
      this.puppets.clearHazards();
      this.enter('stunned');
    }
  }

  private applyDamage(n: number): void {
    // 終局處決觸發後鎖血，一般傷害不再讓血量繼續下降——只有處決本身能真正殺死她
    if (this.executeTriggered) return;

    this.hp = Math.max(0, this.hp - n);
    this.hitFlash = 1;
    if (this.hp <= 0) {
      this.state = 'dead';
      this.stateT = 0;
      return;
    }

    // 最終階段、血量跌到「階段內剩一半」→ 排定下一幀強制進入終局處決序列
    if (this.phase === 2 && this.hp / T.puppeteer.maxHp <= T.puppeteer.execute.triggerHpRatio) {
      this.executeTriggered = true;
      this.executePending = true;
    }
  }

  reset(pos: Vec): void {
    this.pos = { x: pos.x, y: pos.y };
    this.hp = T.puppeteer.maxHp;
    this.state = 'idle';
    this.stateT = 0;
    this.facing = { x: 0, y: 1 };
    this.hitFlash = 0;
    this.lastAttack = null;
    this.radialBaseAngle = 0;
    this.hopFrom = { x: 0, y: 0 };
    this.hopTo = { x: 0, y: 0 };
    this.gauntletFieldSpawned = false;
    this.gauntletCorridors = [];
    this.attacksSinceOpening = 0;
    this.centerIntroDone = false;
    this.executeTriggered = false;
    this.executePending = false;
    this.executePath = [];
    this.time = 0;
    this.puppets.clear();
  }

  // ── 繪製 ────────────────────────────────────────────────

  /** 地面層：攻擊預警，畫在實體底下 */
  drawGround(ctx: CanvasRenderingContext2D): void {
    this.puppets.drawGround(ctx);
    if (!this.alive) return;

    switch (this.state) {
      case 'telegraphRadial': {
        const p = clamp(this.stateT / T.puppeteer.radial.telegraph, 0, 1);
        this.radialTelegraph(ctx, p);
        break;
      }
      case 'telegraphLunge': {
        const cfg = T.puppeteer.lunge;
        const p = clamp(this.stateT / cfg.telegraph, 0, 1);
        this.fanTelegraph(ctx, p, cfg.halfAngle, cfg.radius);
        break;
      }
      case 'telegraphPress': {
        const cfg = T.puppeteer.press;
        const p = clamp(this.stateT / cfg.telegraph, 0, 1);
        this.fanTelegraph(ctx, p, cfg.halfAngle, cfg.radius);
        break;
      }
      case 'telegraphSpin': {
        const p = clamp(this.stateT / T.puppeteer.spin.telegraph, 0, 1);
        this.ringTelegraph(ctx, this.pos, T.puppeteer.spin.ringRadius, p);
        break;
      }
      case 'gauntletActive': {
        if (!this.gauntletFieldSpawned) {
          const p = clamp(this.stateT / T.puppeteer.gauntlet.fieldDelay, 0, 1);
          this.corridorTelegraph(ctx, p);
        }
        break;
      }
      case 'telegraphCenter': {
        const p = clamp(this.stateT / T.puppeteer.center.telegraph, 0, 1);
        this.ringTelegraph(ctx, this.pos, T.puppeteer.center.pushRadius, p);
        break;
      }
      case 'telegraphExecute': {
        const p = clamp(this.stateT / T.puppeteer.execute.telegraph, 0, 1);
        this.ringTelegraph(ctx, this.pos, 300, p);
        break;
      }
      case 'executeActive':
      case 'executing':
        this.executeFieldTelegraph(ctx);
        break;
      default:
        break;
    }
  }

  /** 招式a 的放射預警：等角度間隔的淡出線條 */
  /** 用鎖定好的 `radialBaseAngle` 畫，跟實際出招的路徑角度完全一致，不是裝飾用的假預覽 */
  private radialTelegraph(ctx: CanvasRenderingContext2D, p: number): void {
    const cfg = T.puppeteer.radial;
    ctx.strokeStyle = `rgba(200,140,220,${0.15 + p * 0.5})`;
    ctx.lineWidth = 3;
    for (let i = 0; i < cfg.rayCount; i++) {
      const a = this.radialBaseAngle + (i / cfg.rayCount) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(this.pos.x, this.pos.y);
      ctx.lineTo(this.pos.x + Math.cos(a) * cfg.rayLength * p, this.pos.y + Math.sin(a) * cfg.rayLength * p);
      ctx.stroke();
    }
  }

  /** 招式c 場地啟動前的走廊預告：讓玩家先看清楚安全通道在哪 */
  private corridorTelegraph(ctx: CanvasRenderingContext2D, p: number): void {
    const cfg = T.puppeteer.gauntlet;
    ctx.fillStyle = `rgba(170,255,190,${0.06 + p * 0.1})`;
    for (const c of this.gauntletCorridors) {
      const a0 = c - cfg.corridorHalfAngle;
      const a1 = c + cfg.corridorHalfAngle;
      ctx.beginPath();
      ctx.moveTo(this.pos.x, this.pos.y);
      ctx.arc(this.pos.x, this.pos.y, 1400, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** 招式b／招式b' 共用的扇形預警，以她自己為中心、朝目前面向 */
  private fanTelegraph(ctx: CanvasRenderingContext2D, p: number, halfAngle: number, radius: number): void {
    const fa = this.facingAngle;
    const a0 = fa - halfAngle;
    const a1 = fa + halfAngle;

    ctx.fillStyle = `rgba(190,130,210,${0.07 + p * 0.22})`;
    ctx.beginPath();
    ctx.moveTo(this.pos.x, this.pos.y);
    ctx.arc(this.pos.x, this.pos.y, radius, a0, a1);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = `rgba(215,165,235,${0.35 + p * 0.5})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  private ringTelegraph(ctx: CanvasRenderingContext2D, at: Vec, radius: number, p: number): void {
    ctx.strokeStyle = `rgba(200,140,220,${0.3 + p * 0.5})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = `rgba(180,120,205,${0.08 + p * 0.16})`;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius * p, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 終局處決的安全圓標記：持續顯示整條路徑，讓玩家看得懂該往哪跳 */
  private executeFieldTelegraph(ctx: CanvasRenderingContext2D): void {
    const r = T.puppeteer.execute.safeRadius;
    const pulse = 0.6 + 0.4 * Math.sin(this.time * 3);
    for (const p of this.executePath) {
      ctx.fillStyle = `rgba(170,255,210,${0.06 * pulse})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(170,255,210,${0.4 + pulse * 0.3})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const RAD = T.puppeteer.radius;
    const dead = !this.alive;
    const k = this.phase / 2;

    // 影子
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y + RAD * 0.6, RAD * 0.9, RAD * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // 破綻：淡綠色脈動外環，讓「現在打得到」不必只靠讀文字
    if (this.state === 'opening' && !dead) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 10);
      ctx.strokeStyle = `rgba(170,255,190,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, RAD * 1.35, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 暈眩：金黃色慢速脈動外環，跟「破綻」用不同顏色區分意涵
    if (this.state === 'stunned' && !dead) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
      ctx.strokeStyle = `rgba(255,220,140,${0.55 + pulse * 0.35})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, RAD * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 階段光暈：越後期越明顯的紫紅光暈，呼應「更具進攻性」
    if (k > 0 && !dead) {
      const pulse = 0.6 + 0.4 * Math.sin(this.time * 5);
      const glow = ctx.createRadialGradient(
        this.pos.x,
        this.pos.y,
        RAD * 0.6,
        this.pos.x,
        this.pos.y,
        RAD * (1.8 + k * 0.7),
      );
      glow.addColorStop(0, `rgba(210,60,140,${0.22 * k * pulse})`);
      glow.addColorStop(1, 'rgba(210,60,140,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, RAD * (1.8 + k * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.facingAngle + Math.PI / 2);

    let body = dead ? '#332738' : '#5b3a68';
    if (!dead && this.hitFlash > 0) body = '#9d7aad';

    // 本體：瘦長菱形剪影，跟傀儡的矮胖橢圓做出區別
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -RAD);
    ctx.lineTo(RAD * 0.62, RAD * 0.15);
    ctx.lineTo(0, RAD);
    ctx.lineTo(-RAD * 0.62, RAD * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,10,18,0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 兜帽：頭部三角形疊加
    ctx.fillStyle = dead ? '#241c28' : '#432b4d';
    ctx.beginPath();
    ctx.moveTo(0, -RAD * 1.25);
    ctx.lineTo(RAD * 0.4, -RAD * 0.55);
    ctx.lineTo(-RAD * 0.4, -RAD * 0.55);
    ctx.closePath();
    ctx.fill();

    // 蒼白面具臉部圓點
    if (!dead) {
      ctx.fillStyle = '#e8d9e0';
      ctx.beginPath();
      ctx.arc(0, -RAD * 0.72, RAD * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    this.drawStateLabel(ctx, RAD);
  }

  private drawStateLabel(ctx: CanvasRenderingContext2D, RAD: number): void {
    let text = '';
    let color = '';

    if (this.state === 'opening') {
      text = '破綻';
      color = `rgba(170,255,190,${0.75 + 0.25 * Math.sin(this.time * 8)})`;
    } else if (this.state === 'stunned') {
      text = '暈眩';
      color = `rgba(255,220,140,${0.75 + 0.25 * Math.sin(this.time * 6)})`;
    } else if (this.state === 'gauntletActive' && this.gauntletFieldSpawned) {
      text = '打中她可以暈眩';
      color = 'rgba(255,200,150,0.7)';
    } else if (this.state === 'executeActive') {
      text = '沿著安全圈斬過去，打中她就結束了';
      color = `rgba(255,230,180,${0.75 + 0.25 * Math.sin(this.time * 5)})`;
    } else if (this.state === 'executing') {
      text = '處決';
      color = 'rgba(255,230,150,0.95)';
    }

    if (!text) return;

    ctx.fillStyle = color;
    ctx.font = 'bold 15px "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, this.pos.x, this.pos.y - RAD - 24);
    ctx.textAlign = 'left';
  }

  /** 實體層：傀儡本體（畫在 Boss 之後） */
  drawProjectiles(ctx: CanvasRenderingContext2D): void {
    this.puppets.draw(ctx);
  }
}
