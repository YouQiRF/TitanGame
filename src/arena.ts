/**
 * 競技場：一個封閉矩形石室。
 * 牆壁是 Boss 衝撞的關鍵——把 Boss 誘導去撞牆才能打出硬直輸出期。
 */

import { T } from './tuning.ts';
import { clamp, type Vec } from './core/vec.ts';

export const Arena = {
  w: T.arena.w,
  h: T.arena.h,

  /** 把一個半徑為 r 的圓形實體限制在場內，回傳是否撞到牆 */
  confine(pos: Vec, r: number): boolean {
    let hit = false;
    const nx = clamp(pos.x, r, Arena.w - r);
    const ny = clamp(pos.y, r, Arena.h - r);
    if (nx !== pos.x || ny !== pos.y) hit = true;
    pos.x = nx;
    pos.y = ny;
    return hit;
  },

  /** 圓心是否已貼到牆（用於衝撞撞牆判定，留 1px 容差） */
  touchingWall(pos: Vec, r: number): boolean {
    return pos.x <= r + 1 || pos.x >= Arena.w - r - 1 || pos.y <= r + 1 || pos.y >= Arena.h - r - 1;
  },

  draw(ctx: CanvasRenderingContext2D): void {
    // 地板
    ctx.fillStyle = '#15161c';
    ctx.fillRect(0, 0, Arena.w, Arena.h);

    // 地磚網格
    ctx.strokeStyle = 'rgba(255,255,255,0.032)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 70;
    for (let x = step; x < Arena.w; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, Arena.h);
    }
    for (let y = step; y < Arena.h; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(Arena.w, y);
    }
    ctx.stroke();

    // 中央地紋，給場地一個視覺焦點
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(Arena.w / 2, Arena.h / 2, 230, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(Arena.w / 2, Arena.h / 2, 150, 0, Math.PI * 2);
    ctx.stroke();

    // 牆
    const t = T.arena.wallThickness;
    ctx.fillStyle = '#2a2c36';
    ctx.fillRect(0, 0, Arena.w, t);
    ctx.fillRect(0, Arena.h - t, Arena.w, t);
    ctx.fillRect(0, 0, t, Arena.h);
    ctx.fillRect(Arena.w - t, 0, t, Arena.h);

    // 牆的內緣高光，讓邊界更明確
    ctx.strokeStyle = 'rgba(150,160,190,0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(t, t, Arena.w - t * 2, Arena.h - t * 2);
  },
};
