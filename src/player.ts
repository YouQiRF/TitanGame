/**
 * 玩家角色。
 *
 * 狀態機：idle → slash → idle
 *  - 移動：WASD（瞄準時速度下降）
 *  - 斬擊：左鍵長按進子彈時間瞄準，放開沿方向位移並造成傷害——
 *    位移期間的無敵幀同時也是唯一的閃避手段（沒有獨立的翻滾）
 *
 * 血量不會自然回復；體力停止消耗一段時間後持續回復。
 */

import { T } from './tuning.ts';
import { Arena } from './arena.ts';
import { fx } from './fx.ts';
import { planSlash, type SlashPlan } from './slash.ts';
import { add, clamp, damp, easeOutQuint, norm, scale, sub, type Vec } from './core/vec.ts';

export type PlayerState = 'idle' | 'slash' | 'dead';

export class Player {
  pos: Vec;
  vel: Vec = { x: 0, y: 0 };

  hp: number = T.player.maxHp;
  stamina: number = T.player.maxStamina;

  facing: Vec = { x: 0, y: 1 };
  state: PlayerState = 'idle';

  /** 是否正在瞄準（左鍵按住且允許斬擊），由 main 每幀寫入 */
  aiming = false;

  private stateT = 0;
  private recoverT = 0;
  private staminaHoldT = 0;
  private iFrameT = 0;

  /** 受擊閃白，純視覺 */
  hitFlash = 0;

  private slashFrom: Vec = { x: 0, y: 0 };
  private slashTo: Vec = { x: 0, y: 0 };
  /** 本次斬擊的傷害，尚未結算時 > 0 */
  slashDamage = 0;
  /** 命中判定是否還沒結算（main 讀取後呼叫 markSlashResolved） */
  slashHitPending = false;

  constructor(pos: Vec) {
    this.pos = { x: pos.x, y: pos.y };
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  /** 目前是否無敵（受擊硬直 or 斬擊位移無敵幀——唯一的閃避手段） */
  get invulnerable(): boolean {
    if (!this.alive) return true;
    if (this.iFrameT > 0) return true;
    // 斬擊是「穿過去」而不是站著砍：位移期間無敵，但收招瞬間會解除
    if (this.state === 'slash') {
      const p = this.stateT / T.slash.duration;
      return p >= T.slash.iFrameStart && p <= T.slash.iFrameEnd;
    }
    return false;
  }

  /** 能否接受新指令（斬擊） */
  get canAct(): boolean {
    return this.state === 'idle' && this.recoverT <= 0 && this.alive;
  }

  /** 斬擊的完整軌跡線段，供命中判定使用 */
  get slashSegment(): { a: Vec; b: Vec } {
    return { a: this.slashFrom, b: this.slashTo };
  }

  markSlashResolved(): void {
    this.slashHitPending = false;
  }

  /** 依目前體力與瞄準向量預覽這一斬的結果 */
  plan(aimVec: Vec, cursorDist: number): SlashPlan {
    return planSlash(this.stamina, aimVec, cursorDist);
  }

  // ── 指令 ────────────────────────────────────────────────

  /** 執行斬擊；回傳實際採用的方案（取消或失敗時回傳 null） */
  doSlash(aimVec: Vec, cursorDist: number): SlashPlan | null {
    if (!this.canAct) return null;
    const plan = this.plan(aimVec, cursorDist);
    if (plan.cancel) return null;
    if (!plan.valid || plan.dist <= 0) return null;

    this.spendStamina(plan.cost);
    this.facing = plan.dir;

    this.slashFrom = { x: this.pos.x, y: this.pos.y };
    this.slashTo = add(this.pos, scale(plan.dir, plan.dist));
    // 先夾進場內，避免斬進牆裡
    Arena.confine(this.slashTo, T.player.radius);

    this.slashDamage = plan.damage;
    this.slashHitPending = true;
    this.state = 'slash';
    this.stateT = 0;
    this.vel.x = 0;
    this.vel.y = 0;

    // ── 斬擊特效：刀光 + 起步的踏塵與氣流火花 ──
    // 威力越高，刀光越粗、火花越多，讓玩家「看得出」自己這一斬有多重
    const power = plan.power;
    fx.slash(this.slashFrom, this.slashTo, power);
    fx.dust(this.slashFrom, 5 + Math.round(power * 9), {
      dir: scale(plan.dir, -1),
      spread: 0.7,
      speed: 110 + power * 130,
      life: 0.42,
      size: 4.5,
    });
    fx.spark(this.slashFrom, 4 + Math.round(power * 12), {
      dir: plan.dir,
      spread: 0.42,
      speed: 260 + power * 320,
      life: 0.3,
      size: 2.2,
      col: [175, 235, 255],
    });
    // 滿威力的一斬額外給一圈衝擊環，強調「這是全力」
    if (power > 0.62) {
      fx.ring(this.slashFrom, {
        r0: 6,
        r1: 46 + power * 34,
        life: 0.26,
        width: 3.5,
        col: [180, 235, 255],
      });
    }

    return plan;
  }

  // ── 受傷 ────────────────────────────────────────────────

  /** 回傳是否真的造成傷害（被無敵擋掉時回傳 false） */
  takeDamage(amount: number, fromDir: Vec): boolean {
    if (this.invulnerable) return false;

    this.hp = Math.max(0, this.hp - amount);
    this.iFrameT = T.player.hurtIFrame;
    this.hitFlash = 1;

    const kb = norm(fromDir);
    this.vel = scale(kb, T.player.hurtKnockback);

    // 受擊特效：紅色衝擊火花 + 一圈短促的白環
    fx.spark(this.pos, 14, {
      dir: kb,
      spread: 1.1,
      speed: 260,
      life: 0.36,
      size: 3,
      col: [255, 95, 85],
    });
    fx.ring(this.pos, { r0: 4, r1: 40, life: 0.2, width: 4, col: [255, 110, 100] });
    fx.flash(this.pos, 46, 0.14, [255, 90, 80]);

    // 受擊會打斷動作
    if (this.state === 'slash') {
      this.slashHitPending = false;
    }
    this.state = this.hp > 0 ? 'idle' : 'dead';
    this.stateT = 0;
    this.recoverT = this.hp > 0 ? 0.16 : 0;
    return true;
  }

  private spendStamina(n: number): void {
    this.stamina = clamp(this.stamina - n, 0, T.player.maxStamina);
    this.staminaHoldT = T.player.staminaRegenDelay;
  }

  /** 直接回復體力（例如斬中特殊傀儡）——跟一般消耗後的回復延遲無關，不觸發/延長 staminaHoldT */
  restoreStamina(amount: number): void {
    this.stamina = clamp(this.stamina + amount, 0, T.player.maxStamina);
  }

  // ── 更新 ────────────────────────────────────────────────

  /**
   * @param dt 已套用時間縮放的 delta（子彈時間下玩家也會變慢）
   * @param moveAxis WASD 原始輸入
   */
  update(dt: number, moveAxis: Vec, aimWorld: Vec): void {
    this.stateT += dt;
    if (this.recoverT > 0) this.recoverT = Math.max(0, this.recoverT - dt);
    if (this.iFrameT > 0) this.iFrameT = Math.max(0, this.iFrameT - dt);
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 3.5);

    switch (this.state) {
      case 'slash':
        this.updateSlash(dt);
        break;
      case 'idle':
        this.updateGround(dt, moveAxis, aimWorld);
        break;
      case 'dead':
        // 死亡後殘餘速度滑行
        this.vel.x = damp(this.vel.x, 0, 9, dt);
        this.vel.y = damp(this.vel.y, 0, 9, dt);
        this.pos = add(this.pos, scale(this.vel, dt));
        break;
    }

    // 體力回復：停止消耗一段時間後才開始
    if (this.staminaHoldT > 0) {
      this.staminaHoldT = Math.max(0, this.staminaHoldT - dt);
    } else if (this.stamina < T.player.maxStamina) {
      this.stamina = Math.min(T.player.maxStamina, this.stamina + T.player.staminaRegen * dt);
    }

    Arena.confine(this.pos, T.player.radius);
  }

  private updateGround(dt: number, moveAxis: Vec, aimWorld: Vec): void {
    // 瞄準時朝游標，否則朝移動方向
    if (this.aiming) {
      const toAim = norm(sub(aimWorld, this.pos));
      if (toAim.x !== 0 || toAim.y !== 0) this.facing = toAim;
    }

    const dir = norm(moveAxis);
    const speedMul = this.aiming ? 0.55 : 1;
    const goal = scale(dir, T.player.speed * speedMul);

    this.vel.x = damp(this.vel.x, goal.x, T.player.accel, dt);
    this.vel.y = damp(this.vel.y, goal.y, T.player.accel, dt);

    if (!this.aiming && (dir.x !== 0 || dir.y !== 0)) this.facing = dir;

    this.pos = add(this.pos, scale(this.vel, dt));
  }

  private updateSlash(dt: number): void {
    const p = clamp(this.stateT / T.slash.duration, 0, 1);
    const e = easeOutQuint(p);
    this.pos.x = this.slashFrom.x + (this.slashTo.x - this.slashFrom.x) * e;
    this.pos.y = this.slashFrom.y + (this.slashTo.y - this.slashFrom.y) * e;

    if (p >= 1) {
      this.state = 'idle';
      this.stateT = 0;
      this.recoverT = T.slash.recovery;
      this.slashHitPending = false;
      this.vel = { x: 0, y: 0 };
    }
  }

  reset(pos: Vec): void {
    this.pos = { x: pos.x, y: pos.y };
    this.vel = { x: 0, y: 0 };
    this.hp = T.player.maxHp;
    this.stamina = T.player.maxStamina;
    this.state = 'idle';
    this.stateT = 0;
    this.recoverT = 0;
    this.staminaHoldT = 0;
    this.iFrameT = 0;
    this.hitFlash = 0;
    this.slashHitPending = false;
    this.aiming = false;
    this.facing = { x: 0, y: 1 };
  }

  // ── 繪製 ────────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.alive) {
      this.drawBody(ctx, 'rgba(90,95,110,0.85)', 0.7);
      return;
    }

    const r = T.player.radius;

    // 影子
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y + r * 0.75, r * 0.95, r * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // 無敵時閃爍
    const inv = this.invulnerable;
    const blink = inv ? 0.45 + 0.55 * Math.abs(Math.sin(performance.now() / 55)) : 1;

    let color = '#e8edf7';
    if (this.hitFlash > 0) color = '#ff6b6b';
    else if (this.state === 'slash') color = '#bfe6ff';

    ctx.globalAlpha = blink;
    this.drawBody(ctx, color, 1);
    ctx.globalAlpha = 1;
  }

  private drawBody(ctx: CanvasRenderingContext2D, color: string, scaleF: number): void {
    const r = T.player.radius * scaleF;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(20,22,30,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 面向指示（劍尖）
    const tip = add(this.pos, scale(this.facing, r + 11));
    const side = { x: -this.facing.y, y: this.facing.x };
    ctx.fillStyle = 'rgba(30,34,44,0.95)';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(this.pos.x + side.x * r * 0.5, this.pos.y + side.y * r * 0.5);
    ctx.lineTo(this.pos.x - side.x * r * 0.5, this.pos.y - side.y * r * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}
