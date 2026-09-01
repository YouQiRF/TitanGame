/**
 * 傀儡師召喚的傀儡與危險物（#012 全面重做）。
 *
 * 核心是**特殊傀儡** `SpecialPuppet`：不攻擊、玩家靠近會延遲爆炸，
 * 但被斬中會回復體力——把斬擊變成同時兼顧移動/閃避/輸出/資源回收的單一動作。
 * 其餘三種都是純粹的環境危險物（不可被打中，只有攻擊判定會傷玩家），
 * 沿用「spawn → 傷害（一次性 hitPlayer 旗標）→ dead 清除」的既有模式：
 *  - `RayHazard`  招式 a：從本體向外拉長的放射狀路徑
 *  - `PulsePuppet` 招式 c：定點原地反覆小範圍脈衝
 *  - `OrbitHazard` 招式 d：繞著中心點公轉、觸碰即傷
 */

import { T } from '../tuning.ts';
import { fx } from '../fx.ts';
import type { Player } from '../player.ts';
import { add, clamp, dist, distPointSeg, norm, sub, type Vec } from '../core/vec.ts';

/** 招式 d 的旋轉環：特殊傀儡也可能是其中一格，跟著一起公轉 */
export interface OrbitConfig {
  center: Vec;
  radius: number;
  angularSpeed: number;
  angle: number;
}

// ── 特殊傀儡：不攻擊、靠近延遲爆炸、被斬回體力 ──────────

/** 消失前開始淡出的剩餘秒數 */
const SPECIAL_FADE_TIME = 1.0;

class SpecialPuppet {
  pos: Vec;
  private fuseT = 0;
  private life: number;
  dead = false;
  private orbit?: OrbitConfig;

  constructor(pos: Vec, life: number, orbit?: OrbitConfig) {
    this.pos = { ...pos };
    this.life = life;
    this.orbit = orbit;
  }

  update(dt: number, player: Player): void {
    if (this.dead) return;

    // 沒被斬到也沒炸到的話，活過 life 秒就自己消失——不讓場上一直堆積特殊傀儡
    this.life -= dt;
    if (this.life <= 0) {
      this.despawn();
      return;
    }

    if (this.orbit) {
      this.orbit.angle += this.orbit.angularSpeed * dt;
      this.pos = add(this.orbit.center, {
        x: Math.cos(this.orbit.angle) * this.orbit.radius,
        y: Math.sin(this.orbit.angle) * this.orbit.radius,
      });
    }

    if (!player.alive) return;
    const cfg = T.puppeteer.special;
    const d = dist(this.pos, player.pos);
    if (d < cfg.triggerRadius) {
      this.fuseT += dt;
      if (this.fuseT >= cfg.fuseTime) this.explode(player);
    } else {
      this.fuseT = Math.max(0, this.fuseT - dt * cfg.fuseDecayMult);
    }
  }

  /** 消失前的淡出程度 0..1（1 = 完全不透明） */
  private get fadeAlpha(): number {
    return this.life < SPECIAL_FADE_TIME ? clamp(this.life / SPECIAL_FADE_TIME, 0.12, 1) : 1;
  }

  private despawn(): void {
    this.dead = true;
    fx.dust(this.pos, 8, { speed: 90, life: 0.5, size: 4, col: [140, 220, 195] });
    fx.spark(this.pos, 6, { speed: 120, life: 0.4, size: 2, col: [150, 235, 210] });
  }

  /** 引信進度 0..1，給繪製用 */
  get fuseRatio(): number {
    return clamp(this.fuseT / T.puppeteer.special.fuseTime, 0, 1);
  }

  private explode(player: Player): void {
    this.dead = true;
    const cfg = T.puppeteer.special;
    fx.debris(this.pos, 14, { speed: 300, life: 0.6, radius: 12 });
    fx.spark(this.pos, 16, { speed: 320, life: 0.4, size: 3, col: [255, 140, 90] });
    fx.ring(this.pos, { r0: 8, r1: cfg.explodeRadius, life: 0.3, width: 8, col: [255, 130, 80], ground: true });
    fx.flash(this.pos, cfg.explodeRadius * 0.7, 0.22, [255, 160, 100]);

    if (dist(this.pos, player.pos) < cfg.explodeRadius + T.player.radius) {
      const dir = norm(sub(player.pos, this.pos));
      player.takeDamage(cfg.explodeDamage, dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir);
    }
  }

  /** 被斬擊軌跡命中：消滅、回體力，回傳是否命中 */
  trySlash(a: Vec, b: Vec, player: Player): boolean {
    if (this.dead) return false;
    const cfg = T.puppeteer.special;
    if (distPointSeg(this.pos, a, b) < cfg.radius + T.slash.hitRadius) {
      this.dead = true;
      player.restoreStamina(cfg.staminaRestore);
      fx.ring(this.pos, { r0: 6, r1: 70, life: 0.34, width: 6, col: [140, 235, 205] });
      fx.spark(this.pos, 20, { speed: 280, life: 0.42, size: 3, col: [150, 240, 210] });
      fx.flash(this.pos, 60, 0.2, [170, 245, 220]);
      return true;
    }
    return false;
  }

  drawGround(ctx: CanvasRenderingContext2D): void {
    if (this.dead) return;
    const p = this.fuseRatio;
    if (p <= 0) return;
    ctx.strokeStyle = `rgba(255,150,90,${(0.3 + p * 0.6) * this.fadeAlpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, T.puppeteer.special.triggerRadius, 0, Math.PI * 2);
    ctx.stroke();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.dead) return;
    const r = T.puppeteer.special.radius;
    const alpha = this.fadeAlpha;

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y + r * 0.8, r * 0.85, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#7fe0c9';
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y, r * 0.72, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,50,44,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 引信進度環：越接近爆炸越亮越紅
    const p = this.fuseRatio;
    if (p > 0) {
      ctx.strokeStyle = `rgba(255,${Math.round(200 - p * 120)},${Math.round(120 - p * 90)},0.95)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.stroke();
    }

    ctx.restore();
  }
}

// ── 招式 a：放射狀路徑 ────────────────────────────────

class RayHazard {
  origin: Vec;
  angle: number;
  damage: number;
  len = 0;
  private growing = true;
  private holdT: number;
  private hitPlayer = false;

  constructor(origin: Vec, angle: number, damage: number) {
    this.origin = { ...origin };
    this.angle = angle;
    this.damage = damage;
    this.holdT = T.puppeteer.radial.holdTime;
  }

  get dead(): boolean {
    return !this.growing && this.holdT <= 0;
  }

  private get endPoint(): Vec {
    return {
      x: this.origin.x + Math.cos(this.angle) * this.len,
      y: this.origin.y + Math.sin(this.angle) * this.len,
    };
  }

  update(dt: number, player: Player): void {
    const cfg = T.puppeteer.radial;
    if (this.growing) {
      this.len += (cfg.rayLength / cfg.rayGrow) * dt;
      if (this.len >= cfg.rayLength) {
        this.len = cfg.rayLength;
        this.growing = false;
      }
    } else {
      this.holdT -= dt;
    }

    if (this.hitPlayer || !player.alive) return;
    const d = distPointSeg(player.pos, this.origin, this.endPoint);
    if (d < cfg.rayHalfWidth + T.player.radius) {
      if (player.takeDamage(this.damage, norm(sub(player.pos, this.origin)))) this.hitPlayer = true;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const end = this.endPoint;
    const alpha = this.growing ? 0.85 : clamp(this.holdT / T.puppeteer.radial.holdTime, 0, 1) * 0.7 + 0.15;
    ctx.strokeStyle = `rgba(190,130,210,${alpha})`;
    ctx.lineWidth = T.puppeteer.radial.rayHalfWidth * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.origin.x, this.origin.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    ctx.strokeStyle = `rgba(230,190,240,${alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(this.origin.x, this.origin.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

// ── 招式 c：定點原地反覆脈衝 ──────────────────────────

class PulsePuppet {
  pos: Vec;
  private life: number;
  private t: number;
  dead = false;

  constructor(pos: Vec, life: number) {
    this.pos = { ...pos };
    this.life = life;
    this.t = T.puppeteer.gauntlet.pulseInterval * Math.random();
  }

  update(dt: number, player: Player): void {
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }
    this.t -= dt;
    if (this.t <= 0) {
      this.t = T.puppeteer.gauntlet.pulseInterval;
      this.pulse(player);
    }
  }

  private pulse(player: Player): void {
    const cfg = T.puppeteer.gauntlet;
    fx.ring(this.pos, { r0: 6, r1: cfg.pulseRadius, life: 0.28, width: 6, col: [190, 130, 210], ground: true });
    fx.spark(this.pos, 8, { speed: 220, life: 0.3, size: 2.4, col: [210, 160, 230] });

    if (player.alive && dist(this.pos, player.pos) < cfg.pulseRadius + T.player.radius) {
      const dir = norm(sub(player.pos, this.pos));
      player.takeDamage(cfg.pulseDamage, dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.dead) return;
    drawPuppetBody(ctx, this.pos, 15, 1);
  }
}

// ── 招式 d：公轉危險物 ────────────────────────────────

class OrbitHazard {
  center: Vec;
  radius: number;
  angle: number;
  private angularSpeed: number;
  private damage: number;
  private life: number;
  private hitPlayer = false;

  constructor(center: Vec, radius: number, angle: number, angularSpeed: number, damage: number, life: number) {
    this.center = { ...center };
    this.radius = radius;
    this.angle = angle;
    this.angularSpeed = angularSpeed;
    this.damage = damage;
    this.life = life;
  }

  get dead(): boolean {
    return this.life <= 0;
  }

  get pos(): Vec {
    return add(this.center, { x: Math.cos(this.angle) * this.radius, y: Math.sin(this.angle) * this.radius });
  }

  update(dt: number, player: Player): void {
    this.angle += this.angularSpeed * dt;
    this.life -= dt;
    if (this.life <= 0) return;

    if (this.hitPlayer || !player.alive) return;
    const p = this.pos;
    if (dist(p, player.pos) < T.puppeteer.center.hazardRadius + T.player.radius) {
      const dir = norm(sub(player.pos, p));
      if (player.takeDamage(this.damage, dir)) this.hitPlayer = true;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    drawPuppetBody(ctx, this.pos, 16, 1);
  }
}

/** 一般傀儡的骨白色人形剪影，關節處畫幾道縫線裂痕——跟傀儡師/特殊傀儡的配色都不同 */
function drawPuppetBody(ctx: CanvasRenderingContext2D, pos: Vec, r: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(pos.x, pos.y);

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, r * 0.8, r * 0.85, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#d8cfc0';
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.72, r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(50,42,36,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(70,55,45,0.7)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-r * 0.3, -r * 0.5);
  ctx.lineTo(r * 0.15, -r * 0.1);
  ctx.moveTo(r * 0.15, -r * 0.1);
  ctx.lineTo(-r * 0.1, r * 0.3);
  ctx.moveTo(-r * 0.35, r * 0.15);
  ctx.lineTo(r * 0.3, r * 0.45);
  ctx.stroke();

  ctx.restore();
}

// ── 管理器 ──────────────────────────────────────────────

export class Puppets {
  private specials: SpecialPuppet[] = [];
  private rays: RayHazard[] = [];
  private pulses: PulsePuppet[] = [];
  private orbits: OrbitHazard[] = [];

  spawnSpecial(pos: Vec, life: number, orbit?: OrbitConfig): void {
    this.specials.push(new SpecialPuppet(pos, life, orbit));
  }

  spawnRay(origin: Vec, angle: number, damage: number): void {
    this.rays.push(new RayHazard(origin, angle, damage));
  }

  spawnPulse(pos: Vec, life: number): void {
    this.pulses.push(new PulsePuppet(pos, life));
  }

  /**
   * 一圈公轉的危險物，其中隨機一格改放會公轉的特殊傀儡。
   * @param baseAngle 環的起始角度（隨機化，避免每次都一樣好記）
   */
  spawnOrbitRing(
    center: Vec,
    radius: number,
    count: number,
    angularSpeed: number,
    damage: number,
    life: number,
    baseAngle: number,
  ): void {
    const specialIndex = Math.floor(Math.random() * count);
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (i / count) * Math.PI * 2;
      if (i === specialIndex) {
        const pos = add(center, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
        this.spawnSpecial(pos, life, { center: { ...center }, radius, angularSpeed, angle });
      } else {
        this.orbits.push(new OrbitHazard(center, radius, angle, angularSpeed, damage, life));
      }
    }
  }

  /** 斬擊優先判定特殊傀儡；命中就消滅並回體力，回傳是否命中（main.ts 命中判定用） */
  /** 斬擊路徑上所有特殊傀儡都算數，不是只吃第一個——一斬可以連續回好幾次體力 */
  trySlashHeal(a: Vec, b: Vec, player: Player): boolean {
    let any = false;
    for (const s of this.specials) {
      if (s.trySlash(a, b, player)) any = true;
    }
    return any;
  }

  update(dt: number, player: Player): void {
    for (const s of this.specials) s.update(dt, player);
    for (const r of this.rays) r.update(dt, player);
    for (const p of this.pulses) p.update(dt, player);
    for (const o of this.orbits) o.update(dt, player);

    this.specials = this.specials.filter((s) => !s.dead);
    this.rays = this.rays.filter((r) => !r.dead);
    this.pulses = this.pulses.filter((p) => !p.dead);
    this.orbits = this.orbits.filter((o) => !o.dead);
  }

  /** 地面層：路徑/引信範圍這類貼地的東西 */
  drawGround(ctx: CanvasRenderingContext2D): void {
    for (const r of this.rays) r.draw(ctx);
    for (const s of this.specials) s.drawGround(ctx);
  }

  /** 實體層：傀儡本體 */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.pulses) p.draw(ctx);
    for (const o of this.orbits) o.draw(ctx);
    for (const s of this.specials) s.draw(ctx);
  }

  /** 清空這一招灑出的所有危險物與特殊傀儡（招式結束/中斷時呼叫） */
  clearHazards(): void {
    this.rays = [];
    this.pulses = [];
    this.orbits = [];
    this.specials = [];
  }

  clear(): void {
    this.clearHazards();
  }
}
