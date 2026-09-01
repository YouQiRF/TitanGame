/**
 * Boss 的所有場地危險物：衝擊波、投石、地裂。
 *
 * 共同約定：
 *  - 每個物件自己負責「移動 → 判定 → 標記死亡」，由 Projectiles 統一驅動
 *  - 對同一個玩家只會造成一次傷害（hitPlayer 旗標），避免站在原地被連續打
 *  - 危險物一律畫在實體底下（地面層），玩家才看得清楚自己站在哪
 */

import { T } from '../tuning.ts';
import { Arena } from '../arena.ts';
import { fx } from '../fx.ts';
import type { Camera } from '../core/camera.ts';
import type { Player } from '../player.ts';
import { add, dist, norm, scale, sub, type Vec } from '../core/vec.ts';

/** 兩角度差，正規化到 -π..π */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ── 衝擊波：砸地後擴散的環，只有環上會傷人 ──────────────

class Shockwave {
  origin: Vec;
  r: number;
  hitPlayer = false;
  damage: number;
  maxR: number;

  constructor(origin: Vec, startR: number, damage: number, maxR: number) {
    this.origin = { ...origin };
    this.r = startR;
    this.damage = damage;
    this.maxR = maxR;
  }

  get dead(): boolean {
    return this.r >= this.maxR;
  }

  update(dt: number, player: Player): void {
    this.r += T.guardian.shockwaveSpeed * dt;
    if (this.hitPlayer || !player.alive) return;

    const d = dist(this.origin, player.pos);
    // 只有「環上」才會被打到——衝過去或留在圈內都安全
    if (Math.abs(d - this.r) < T.guardian.shockwaveWidth * 0.5 + T.player.radius) {
      if (player.takeDamage(this.damage, norm(sub(player.pos, this.origin)))) {
        this.hitPlayer = true;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const fade = 1 - this.r / this.maxR;
    ctx.strokeStyle = `rgba(255,150,80,${0.55 * fade})`;
    ctx.lineWidth = T.guardian.shockwaveWidth;
    ctx.beginPath();
    ctx.arc(this.origin.x, this.origin.y, this.r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ── 投石：飛向鎖定點，落地或命中即爆裂 ──────────────────

class Boulder {
  pos: Vec;
  vel: Vec;
  target: Vec;
  damage: number;
  exploded = false;
  /** 爆炸動畫計時 */
  blastT = 0;
  hitPlayer = false;
  spin = 0;
  private trailT = 0;

  constructor(from: Vec, target: Vec, damage: number) {
    this.pos = { ...from };
    this.target = { ...target };
    this.damage = damage;
    this.vel = scale(norm(sub(target, from)), T.guardian.boulderSpeed);
  }

  get dead(): boolean {
    return this.exploded && this.blastT > 0.34;
  }

  update(dt: number, player: Player, camera: Camera): void {
    if (this.exploded) {
      this.blastT += dt;
      return;
    }

    this.spin += dt * 7;
    const prev = { ...this.pos };
    this.pos = add(this.pos, scale(this.vel, dt));

    // 飛行拖尾
    this.trailT -= dt;
    if (this.trailT <= 0) {
      this.trailT = 0.03;
      fx.dust(this.pos, 1, {
        dir: scale(norm(this.vel), -1),
        spread: 0.4,
        speed: 55,
        life: 0.32,
        size: 4,
      });
    }

    // 命中玩家
    if (player.alive && dist(this.pos, player.pos) < T.guardian.boulderRadius + T.player.radius) {
      this.explode(player, camera);
      return;
    }

    // 越過鎖定點（用「是否從目標的一側跨到另一側」判斷，避免高速跳過）
    const toTarget = sub(this.target, this.pos);
    const prevToTarget = sub(this.target, prev);
    if (toTarget.x * prevToTarget.x + toTarget.y * prevToTarget.y <= 0) {
      this.explode(player, camera);
      return;
    }

    // 撞牆
    if (Arena.touchingWall(this.pos, T.guardian.boulderRadius)) {
      this.explode(player, camera);
    }
  }

  private explode(player: Player, camera: Camera): void {
    this.exploded = true;
    this.blastT = 0;
    camera.shake(9, 0.22);

    // 石塊碎裂：碎片 + 火花 + 環 + 閃光
    const BR = T.guardian.boulderBlastRadius;
    fx.debris(this.pos, 16, { speed: 330, life: 0.7, radius: 10 });
    fx.spark(this.pos, 12, { speed: 260, life: 0.4, size: 2.8, col: [255, 170, 90] });
    fx.dust(this.pos, 14, { speed: 170, size: 7, life: 0.5, radius: 18 });
    fx.ring(this.pos, { r0: 12, r1: BR, life: 0.3, width: 8, col: [255, 150, 80], ground: true });
    fx.flash(this.pos, BR * 0.8, 0.18, [255, 160, 90]);

    if (
      player.alive &&
      dist(this.pos, player.pos) < T.guardian.boulderBlastRadius + T.player.radius
    ) {
      const dir = norm(sub(player.pos, this.pos));
      if (player.takeDamage(this.damage, dir.x === 0 && dir.y === 0 ? { x: 0, y: 1 } : dir)) {
        this.hitPlayer = true;
      }
    }
  }

  /** 地面層：落點預警圈與爆炸 */
  drawGround(ctx: CanvasRenderingContext2D): void {
    if (this.exploded) {
      const t = Math.min(1, this.blastT / 0.34);
      const r = T.guardian.boulderBlastRadius * (0.45 + t * 0.7);
      ctx.fillStyle = `rgba(255,140,70,${0.42 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(this.pos.x, this.pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,200,140,${0.7 * (1 - t)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      return;
    }

    // 落點預警
    ctx.strokeStyle = 'rgba(255,130,70,0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.arc(this.target.x, this.target.y, T.guardian.boulderBlastRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 實體層：飛行中的石塊 */
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.exploded) return;
    const r = T.guardian.boulderRadius;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y + r * 0.8, r * 0.9, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.spin);
    ctx.fillStyle = '#6b6f80';
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const rr = r * (i % 2 === 0 ? 1 : 0.78);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(14,15,20,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

// ── 地裂：從 Boss 放射，波前推進，可翻滾閃過 ────────────

class Crack {
  origin: Vec;
  angle: number;
  damage: number;
  len = 0;
  hitPlayer = false;
  /** 波前抵達最遠距離後的殘留時間（純視覺） */
  fade = 0;
  private fxT = 0;

  constructor(origin: Vec, angle: number, damage: number) {
    this.origin = { ...origin };
    this.angle = angle;
    this.damage = damage;
  }

  get dead(): boolean {
    return this.fade > 0.6;
  }

  update(dt: number, player: Player): void {
    if (this.len < T.guardian.quakeMaxLen) {
      this.len += T.guardian.quakeSpeed * dt;

      // 波前持續掀起岩屑，讓「裂縫正在往這裡衝過來」看得見
      this.fxT -= dt;
      if (this.fxT <= 0) {
        this.fxT = 0.045;
        const at = {
          x: this.origin.x + Math.cos(this.angle) * this.len,
          y: this.origin.y + Math.sin(this.angle) * this.len,
        };
        fx.debris(at, 2, {
          dir: { x: Math.cos(this.angle), y: Math.sin(this.angle) },
          spread: 1.2,
          speed: 190,
          life: 0.5,
          gravity: 420,
          size: 3.5,
        });
        fx.spark(at, 2, { speed: 130, life: 0.35, size: 2.6, col: [255, 140, 60] });
      }
    } else {
      this.fade += dt;
    }

    if (this.hitPlayer || !player.alive) return;

    const d = dist(this.origin, player.pos);
    if (d < 1) return;
    const a = Math.atan2(player.pos.y - this.origin.y, player.pos.x - this.origin.x);
    const within = Math.abs(angleDiff(a, this.angle)) < T.guardian.quakeHalfAngle;
    // 只有波前那一段會傷人
    if (within && Math.abs(d - this.len) < 42 + T.player.radius) {
      if (player.takeDamage(this.damage, norm(sub(player.pos, this.origin)))) {
        this.hitPlayer = true;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const half = T.guardian.quakeHalfAngle;
    const a0 = this.angle - half;
    const a1 = this.angle + half;
    const alpha = this.fade > 0 ? Math.max(0, 1 - this.fade / 0.6) : 1;

    // 已裂開的部分：暗色裂縫
    ctx.fillStyle = `rgba(30,16,12,${0.55 * alpha})`;
    ctx.beginPath();
    ctx.moveTo(this.origin.x, this.origin.y);
    ctx.arc(this.origin.x, this.origin.y, this.len, a0, a1);
    ctx.closePath();
    ctx.fill();

    // 波前：發亮的岩漿色
    if (this.fade <= 0) {
      ctx.strokeStyle = `rgba(255,140,60,0.85)`;
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(this.origin.x, this.origin.y, this.len, a0, a1);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255,230,170,0.9)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(this.origin.x, this.origin.y, this.len, a0, a1);
      ctx.stroke();
    }
  }
}

// ── 管理器 ──────────────────────────────────────────────

export class Projectiles {
  private shockwaves: Shockwave[] = [];
  private boulders: Boulder[] = [];
  private cracks: Crack[] = [];

  spawnShockwave(origin: Vec, startR: number, damage: number, maxR: number): void {
    this.shockwaves.push(new Shockwave(origin, startR, damage, maxR));
  }

  spawnBoulder(from: Vec, target: Vec, damage: number): void {
    this.boulders.push(new Boulder(from, target, damage));
  }

  spawnQuake(origin: Vec, baseAngle: number, count: number, damage: number): void {
    for (let i = 0; i < count; i++) {
      this.cracks.push(new Crack(origin, baseAngle + (i / count) * Math.PI * 2, damage));
    }
  }

  update(dt: number, player: Player, camera: Camera): void {
    for (const s of this.shockwaves) s.update(dt, player);
    for (const b of this.boulders) b.update(dt, player, camera);
    for (const c of this.cracks) c.update(dt, player);

    this.shockwaves = this.shockwaves.filter((s) => !s.dead);
    this.boulders = this.boulders.filter((b) => !b.dead);
    this.cracks = this.cracks.filter((c) => !c.dead);
  }

  /** 地面層（畫在所有實體底下） */
  drawGround(ctx: CanvasRenderingContext2D): void {
    for (const c of this.cracks) c.draw(ctx);
    for (const s of this.shockwaves) s.draw(ctx);
    for (const b of this.boulders) b.drawGround(ctx);
  }

  /** 實體層 */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const b of this.boulders) b.draw(ctx);
  }

  clear(): void {
    this.shockwaves = [];
    this.boulders = [];
    this.cracks = [];
  }
}
