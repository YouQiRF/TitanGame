/**
 * 特效系統（粒子 / 環 / 弧 / 刀光 / 閃光）。
 *
 * 全遊戲共用一個單例 `fx`，任何系統直接 import 使用，不必層層傳參。
 *
 * 分層：
 *   ground — 塵土、地面衝擊環，畫在所有實體底下
 *   over   — 火花、碎石、刀光、閃光，畫在實體之上
 *
 * 更新使用「已套用時間縮放的 dt」，所以子彈時間裡特效也會慢下來，
 * 命中頓幀（dt = 0）時特效會定格——這正是打擊感的一部分。
 */

import { clamp, norm, type Vec } from './core/vec.ts';

type RGB = [number, number, number];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  col: RGB;
  drag: number;
  gravity: number;
  glow: boolean;
  shard: boolean;
  rot: number;
  spin: number;
  ground: boolean;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  width: number;
  col: RGB;
  glow: boolean;
  ground: boolean;
}

interface Arc {
  x: number;
  y: number;
  angle: number;
  half: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  col: RGB;
  /** 掃動方向：+1 從一側掃到另一側，-1 反向，0 = 整段同時出現 */
  sweep: number;
}

interface SlashArc {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  life: number;
  maxLife: number;
  power: number;
  col: RGB;
}

interface Flash {
  x: number;
  y: number;
  r: number;
  life: number;
  maxLife: number;
  col: RGB;
}

export interface BurstOpts {
  /** 噴發方向；省略則為全向 */
  dir?: Vec;
  /** 以 dir 為中心的擴散半角（rad），全向時忽略 */
  spread?: number;
  speed?: number;
  speedVar?: number;
  life?: number;
  lifeVar?: number;
  size?: number;
  sizeVar?: number;
  col?: RGB;
  colVar?: number;
  drag?: number;
  gravity?: number;
  glow?: boolean;
  shard?: boolean;
  ground?: boolean;
  /** 從中心往外偏移的生成半徑 */
  radius?: number;
}

export interface RingOpts {
  r0?: number;
  r1?: number;
  life?: number;
  width?: number;
  col?: RGB;
  glow?: boolean;
  ground?: boolean;
}

const MAX_PARTICLES = 900;

export class FX {
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private arcs: Arc[] = [];
  private slashes: SlashArc[] = [];
  private flashes: Flash[] = [];

  // ── 生成 ────────────────────────────────────────────────

  burst(pos: Vec, count: number, o: BurstOpts = {}): void {
    const speed = o.speed ?? 160;
    const speedVar = o.speedVar ?? 0.6;
    const life = o.life ?? 0.5;
    const lifeVar = o.lifeVar ?? 0.4;
    const size = o.size ?? 3;
    const sizeVar = o.sizeVar ?? 0.5;
    const col = o.col ?? [255, 160, 70];
    const colVar = o.colVar ?? 0;
    const spread = o.spread ?? Math.PI;
    const baseAngle = o.dir ? Math.atan2(o.dir.y, o.dir.x) : 0;
    const radius = o.radius ?? 0;

    for (let i = 0; i < count; i++) {
      const a = o.dir
        ? baseAngle + (Math.random() * 2 - 1) * spread
        : Math.random() * Math.PI * 2;
      const sp = speed * (1 + (Math.random() * 2 - 1) * speedVar);
      const rr = radius * Math.sqrt(Math.random());
      const jitter = colVar > 0 ? (Math.random() * 2 - 1) * colVar : 0;
      const lf = life * (1 + (Math.random() * 2 - 1) * lifeVar);

      this.particles.push({
        x: pos.x + Math.cos(a) * rr,
        y: pos.y + Math.sin(a) * rr,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: lf,
        maxLife: lf,
        size: size * (1 + (Math.random() * 2 - 1) * sizeVar),
        col: [
          clamp(col[0] + jitter, 0, 255),
          clamp(col[1] + jitter, 0, 255),
          clamp(col[2] + jitter, 0, 255),
        ],
        drag: o.drag ?? 2.4,
        gravity: o.gravity ?? 0,
        glow: o.glow ?? false,
        shard: o.shard ?? false,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() * 2 - 1) * 9,
        ground: o.ground ?? false,
      });
    }

    // 超量時丟掉最舊的，避免長時間戰鬥後掉幀
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  /** 發光火花：命中、憤怒、熔岩 */
  spark(pos: Vec, count: number, o: BurstOpts = {}): void {
    this.burst(pos, count, {
      col: [255, 190, 90],
      glow: true,
      speed: 230,
      life: 0.42,
      size: 2.6,
      drag: 3.4,
      ...o,
    });
  }

  /** 地面塵土：踏擊、翻滾、衝撞起步 */
  dust(pos: Vec, count: number, o: BurstOpts = {}): void {
    this.burst(pos, count, {
      col: [126, 122, 116],
      speed: 90,
      life: 0.6,
      size: 5,
      drag: 3.6,
      ground: true,
      ...o,
    });
  }

  /** 碎石：石塊爆裂、部位破壞、撞牆 */
  debris(pos: Vec, count: number, o: BurstOpts = {}): void {
    this.burst(pos, count, {
      col: [104, 108, 122],
      speed: 260,
      life: 0.7,
      size: 4.5,
      drag: 1.9,
      gravity: 420,
      shard: true,
      ...o,
    });
  }

  ring(pos: Vec, o: RingOpts = {}): void {
    const life = o.life ?? 0.34;
    this.rings.push({
      x: pos.x,
      y: pos.y,
      r0: o.r0 ?? 0,
      r1: o.r1 ?? 120,
      life,
      maxLife: life,
      width: o.width ?? 5,
      col: o.col ?? [255, 170, 90],
      glow: o.glow ?? true,
      ground: o.ground ?? false,
    });
  }

  /** 扇形刀光（Boss 橫掃用） */
  arc(
    pos: Vec,
    angle: number,
    half: number,
    r0: number,
    r1: number,
    life: number,
    col: RGB,
    sweep = 1,
  ): void {
    this.arcs.push({
      x: pos.x,
      y: pos.y,
      angle,
      half,
      r0,
      r1,
      life,
      maxLife: life,
      col,
      sweep,
    });
  }

  /** 玩家斬擊的刀光：沿位移軌跡的一道弧形亮痕 */
  slash(a: Vec, b: Vec, power: number, col: RGB = [190, 235, 255]): void {
    this.slashes.push({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      life: 0.26,
      maxLife: 0.26,
      power,
      col,
    });
  }

  flash(pos: Vec, r: number, life = 0.18, col: RGB = [255, 230, 170]): void {
    this.flashes.push({ x: pos.x, y: pos.y, r, life, maxLife: life, col });
  }

  // ── 更新 ────────────────────────────────────────────────

  update(dt: number): void {
    if (dt <= 0) return;

    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.rot += p.spin * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);

    for (const a of this.arcs) a.life -= dt;
    this.arcs = this.arcs.filter((a) => a.life > 0);

    for (const s of this.slashes) s.life -= dt;
    this.slashes = this.slashes.filter((s) => s.life > 0);

    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter((f) => f.life > 0);
  }

  clear(): void {
    this.particles = [];
    this.rings = [];
    this.arcs = [];
    this.slashes = [];
    this.flashes = [];
  }

  // ── 繪製 ────────────────────────────────────────────────

  /** 地面層：塵土與地面衝擊環 */
  drawGround(ctx: CanvasRenderingContext2D): void {
    this.drawRings(ctx, true);
    this.drawParticles(ctx, true);
  }

  /** 實體層：火花、碎石、刀光、閃光 */
  drawOver(ctx: CanvasRenderingContext2D): void {
    this.drawParticles(ctx, false);
    this.drawRings(ctx, false);
    this.drawArcs(ctx);
    this.drawSlashes(ctx);
    this.drawFlashes(ctx);
  }

  private drawParticles(ctx: CanvasRenderingContext2D, ground: boolean): void {
    let glowOpen = false;
    for (const p of this.particles) {
      if (p.ground !== ground) continue;
      const t = clamp(p.life / p.maxLife, 0, 1);

      if (p.glow && !glowOpen) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        glowOpen = true;
      } else if (!p.glow && glowOpen) {
        ctx.restore();
        glowOpen = false;
      }

      const alpha = p.glow ? t * 0.9 : t * 0.62;
      ctx.fillStyle = `rgba(${p.col[0] | 0},${p.col[1] | 0},${p.col[2] | 0},${alpha})`;

      if (p.shard) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const s = p.size * (0.5 + t * 0.5);
        ctx.beginPath();
        ctx.moveTo(-s, -s * 0.6);
        ctx.lineTo(s * 0.9, -s * 0.9);
        ctx.lineTo(s * 0.7, s * 0.8);
        ctx.lineTo(-s * 0.8, s * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * t, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (glowOpen) ctx.restore();
  }

  private drawRings(ctx: CanvasRenderingContext2D, ground: boolean): void {
    for (const r of this.rings) {
      if (r.ground !== ground) continue;
      const t = clamp(r.life / r.maxLife, 0, 1);
      const p = 1 - t;
      // 尾段快、前段慢的擴張，看起來比較有爆發力
      const eased = 1 - Math.pow(1 - p, 2.4);
      const radius = r.r0 + (r.r1 - r.r0) * eased;

      ctx.save();
      if (r.glow) ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(${r.col[0]},${r.col[1]},${r.col[2]},${t * 0.8})`;
      ctx.lineWidth = r.width * t;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.1, radius), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawArcs(ctx: CanvasRenderingContext2D): void {
    for (const a of this.arcs) {
      const t = clamp(a.life / a.maxLife, 0, 1);
      const p = 1 - t;

      // sweep：刀光沿著扇形掃過去，而不是整片同時亮
      let from = a.angle - a.half;
      let to = a.angle + a.half;
      if (a.sweep !== 0) {
        const span = a.half * 2;
        const head = a.sweep > 0 ? from + span * p : to - span * p;
        const tailLen = span * 0.55;
        if (a.sweep > 0) {
          from = Math.max(a.angle - a.half, head - tailLen);
          to = head;
        } else {
          from = head;
          to = Math.min(a.angle + a.half, head + tailLen);
        }
      }
      if (to <= from) continue;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const grad = ctx.createRadialGradient(a.x, a.y, a.r0, a.x, a.y, a.r1);
      grad.addColorStop(0, `rgba(${a.col[0]},${a.col[1]},${a.col[2]},0)`);
      grad.addColorStop(0.7, `rgba(${a.col[0]},${a.col[1]},${a.col[2]},${t * 0.42})`);
      grad.addColorStop(1, `rgba(255,255,255,${t * 0.55})`);
      ctx.fillStyle = grad;

      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r1, from, to);
      ctx.arc(a.x, a.y, a.r0, to, from, true);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSlashes(ctx: CanvasRenderingContext2D): void {
    for (const s of this.slashes) {
      const t = clamp(s.life / s.maxLife, 0, 1);
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;

      const nx = -dy / len;
      const ny = dx / len;
      // 刀光是一枚兩端尖、中段鼓起的柳葉形，比直線有速度感
      const bulge = (5 + s.power * 16) * t;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const mx = (s.ax + s.bx) / 2;
      const my = (s.ay + s.by) / 2;

      ctx.fillStyle = `rgba(${s.col[0]},${s.col[1]},${s.col[2]},${t * 0.55})`;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.quadraticCurveTo(mx + nx * bulge, my + ny * bulge, s.bx, s.by);
      ctx.quadraticCurveTo(mx - nx * bulge, my - ny * bulge, s.ax, s.ay);
      ctx.closePath();
      ctx.fill();

      // 中央高光
      ctx.strokeStyle = `rgba(255,255,255,${t * 0.85})`;
      ctx.lineWidth = 1.5 + s.power * 2.5 * t;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();
      ctx.lineCap = 'butt';

      ctx.restore();
    }
  }

  private drawFlashes(ctx: CanvasRenderingContext2D): void {
    for (const f of this.flashes) {
      const t = clamp(f.life / f.maxLife, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const r = f.r * (1.15 - t * 0.15);
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      g.addColorStop(0, `rgba(255,255,255,${t * 0.85})`);
      g.addColorStop(0.35, `rgba(${f.col[0]},${f.col[1]},${f.col[2]},${t * 0.6})`);
      g.addColorStop(1, `rgba(${f.col[0]},${f.col[1]},${f.col[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 拖尾：給衝撞、投石、翻滾這類持續移動的物件呼叫 */
  trail(pos: Vec, dir: Vec, o: BurstOpts = {}): void {
    const back = norm({ x: -dir.x, y: -dir.y });
    this.burst(pos, 1, {
      dir: back,
      spread: 0.55,
      speed: 60,
      speedVar: 0.7,
      life: 0.35,
      size: 4,
      drag: 3,
      ...o,
    });
  }
}

export const fx = new FX();
