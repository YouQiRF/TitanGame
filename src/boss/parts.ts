/**
 * Boss 的可破壞部位系統。
 *
 * 每個部位有獨立的「破壞值」(integrity)，斬擊命中會累積扣減；歸零即被破壞。
 *
 * ⚠ 破壞部位「不會」削弱 Boss —— 它會激怒 Boss。
 *   每破壞一個部位，憤怒 +1 級：更快、更痛、招式更多（見 guardian.ts）。
 *
 * 玩家換到的是：
 *   · 破壞瞬間的額外傷害與踉蹌硬直（一個輸出窗口）
 *   · 核心護甲破壞後，核心「永久暴露」——不必再誘導撞牆
 *
 * 所以拆哪個、拆幾個、什麼時候拆，是這場戰鬥真正的策略層。
 */

import { T } from '../tuning.ts';
import { clamp, type Vec } from '../core/vec.ts';

export type PartId = 'coreShell' | 'armL' | 'armR' | 'legs';

export const PART_IDS: PartId[] = ['coreShell', 'armL', 'armR', 'legs'];

export interface PartDef {
  label: string;
  /** 相對 Boss 面向的角度：0 = 正前方，π = 正後方 */
  angle: number;
  dist: number;
  radius: number;
  integrity: number;
  dmgMult: number;
}

export class BodyPart {
  id: PartId;
  def: PartDef;

  integrity: number;
  broken = false;

  /** 受擊閃白，純視覺 */
  hitFlash = 0;
  /** 破壞後計時，用來播碎裂/掉落動畫 */
  breakT = 0;

  constructor(id: PartId, def: PartDef) {
    this.id = id;
    this.def = def;
    this.integrity = def.integrity;
  }

  /** 剩餘完整度 0..1 */
  get ratio(): number {
    return clamp(this.integrity / this.def.integrity, 0, 1);
  }

  /** 部位在世界座標的位置 */
  worldPos(bossPos: Vec, facingAngle: number): Vec {
    const a = facingAngle + this.def.angle;
    return {
      x: bossPos.x + Math.cos(a) * this.def.dist,
      y: bossPos.y + Math.sin(a) * this.def.dist,
    };
  }

  /** 部位在 Boss 局部繪製座標的位置（Boss 已 rotate 成面向 -y） */
  localPos(): Vec {
    const a = this.def.angle - Math.PI / 2;
    return {
      x: Math.cos(a) * this.def.dist,
      y: Math.sin(a) * this.def.dist,
    };
  }

  /** 累積破壞值；回傳「是否在這一擊被破壞」 */
  applyDamage(n: number): boolean {
    if (this.broken) return false;
    this.integrity -= n;
    this.hitFlash = 1;
    if (this.integrity <= 0) {
      this.integrity = 0;
      this.broken = true;
      this.breakT = 0;
      return true;
    }
    return false;
  }

  update(dt: number): void {
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    if (this.broken) this.breakT += dt;
  }

  reset(): void {
    this.integrity = this.def.integrity;
    this.broken = false;
    this.hitFlash = 0;
    this.breakT = 0;
  }
}

export class PartSet {
  readonly list: BodyPart[];
  private map: Map<PartId, BodyPart> = new Map();

  constructor() {
    const defs = T.guardian.parts;
    this.list = [
      new BodyPart('coreShell', { ...defs.coreShell }),
      new BodyPart('armL', { ...defs.armL }),
      new BodyPart('armR', { ...defs.armR }),
      new BodyPart('legs', { ...defs.legs }),
    ];
    for (const p of this.list) this.map.set(p.id, p);
  }

  get(id: PartId): BodyPart {
    return this.map.get(id)!;
  }

  isBroken(id: PartId): boolean {
    return this.get(id).broken;
  }

  get brokenCount(): number {
    return this.list.filter((p) => p.broken).length;
  }

  update(dt: number): void {
    for (const p of this.list) p.update(dt);
  }

  reset(): void {
    for (const p of this.list) p.reset();
  }

  /** 在 Boss 的局部座標系內繪製所有部位（呼叫端已 translate + rotate） */
  draw(ctx: CanvasRenderingContext2D, coreExposed: boolean, time: number): void {
    for (const p of this.list) {
      // 核心護甲破壞後就不畫了，露出底下的核心（核心由 guardian 自己畫）
      if (p.id === 'coreShell' && p.broken) continue;
      this.drawPart(ctx, p, coreExposed, time);
    }
  }

  private drawPart(
    ctx: CanvasRenderingContext2D,
    p: BodyPart,
    coreExposed: boolean,
    time: number,
  ): void {
    const lp = p.localPos();
    const r = p.def.radius;

    if (p.broken) {
      // 殘骸：斷面比原本小且暗
      const t = Math.min(1, p.breakT / 0.5);
      const bx = lp.x * 0.72;
      const by = lp.y * 0.72;

      ctx.fillStyle = '#26282f';
      ctx.beginPath();
      ctx.arc(bx, by, r * (0.5 - t * 0.14), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(12,13,18,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 斷面持續洩出的熾熱能量——既是「牠被激怒了」的證據，
      // 也是「這裡是永久弱點，打這裡」的指示。所以刻意畫得很亮。
      const pulse = 0.55 + 0.45 * Math.sin(time * 7.5 + p.def.angle * 3);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      const g = ctx.createRadialGradient(bx, by, 0, bx, by, r * 1.5);
      g.addColorStop(0, `rgba(255,190,110,${0.72 * pulse})`);
      g.addColorStop(0.35, `rgba(255,120,50,${0.42 * pulse})`);
      g.addColorStop(1, 'rgba(255,70,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, r * 1.5, 0, Math.PI * 2);
      ctx.fill();

      // 弱點標記：一圈持續脈動的細環，與核心的視覺語言一致
      const ringR = r * (0.78 + 0.12 * Math.sin(time * 5 + p.def.angle * 2));
      ctx.strokeStyle = `rgba(255,205,140,${0.55 + 0.3 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, ringR, 0, Math.PI * 2);
      ctx.stroke();

      // 傷口核心的亮點
      ctx.fillStyle = `rgba(255,235,190,${0.7 * pulse})`;
      ctx.beginPath();
      ctx.arc(bx, by, r * 0.26, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      return;
    }

    // 受損程度：越接近破壞越暗紅、裂痕越深
    const dmg = 1 - p.ratio;

    let fill = '#565c6e';
    if (p.id === 'coreShell') fill = coreExposed ? '#7a5f4a' : '#5f5164';
    if (p.hitFlash > 0) fill = '#a8aec2';
    else if (dmg > 0.66) fill = p.id === 'coreShell' ? '#6d4a48' : '#6a4a44';
    else if (dmg > 0.33) fill = p.id === 'coreShell' ? '#6a5658' : '#5f5254';

    ctx.save();
    ctx.translate(lp.x, lp.y);

    // 部位本體：略帶稜角的六邊形，比 Boss 本體小
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const rr = r * (i % 2 === 0 ? 1 : 0.86);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(14,15,20,0.85)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 破壞進度：沿部位外緣畫一圈弧，越接近破壞越紅、越滿
    if (dmg > 0.02) {
      ctx.strokeStyle =
        dmg > 0.75
          ? `rgba(255,110,90,${0.75 + 0.25 * Math.sin(time * 9)})`
          : `rgba(255,190,110,0.72)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r + 4.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dmg);
      ctx.stroke();
    }

    // 裂痕
    if (dmg > 0.3) {
      ctx.strokeStyle = `rgba(16,16,22,${0.4 + dmg * 0.45})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-r * 0.55, -r * 0.2);
      ctx.lineTo(0, r * 0.15);
      ctx.lineTo(r * 0.4, -r * 0.4);
      if (dmg > 0.65) {
        ctx.moveTo(-r * 0.2, r * 0.6);
        ctx.lineTo(r * 0.1, 0);
      }
      ctx.stroke();
    }

    ctx.restore();
  }
}
