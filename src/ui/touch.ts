/**
 * 觸控操作介面（只有在 Input.touchMode 為 true 時才會畫）。
 *
 * 手機沒有游標可以看，所以操作回饋全靠這一層：
 *  - 左手：虛擬搖桿，看得到底座與旋鈕推到哪
 *  - 右手：斬擊拖曳板，看得到從哪按下、拖多遠、目前威力
 *
 * 提示圈在玩家第一次用過該側之後就淡到很低的透明度——
 * 新手看得到，老手不會被擋住畫面。
 */

import { T } from '../tuning.ts';
import { clamp, lerp } from '../core/vec.ts';
import type { Input } from '../core/input.ts';

const FONT = '"Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';

/** 拖到「最遠一斬」所需的螢幕長度；main 換算世界距離時也用這個，確保兩邊一致 */
export function touchMaxDrag(w: number, h: number): number {
  return clamp(Math.min(w, h) * T.touch.maxDragFraction, T.touch.maxDragMin, T.touch.maxDragMax);
}

/** 提示圈的淡出進度：玩家用過之後就不需要再一直提醒 */
const hint = { stick: 1, drag: 1 };

/** 每幀更新提示圈透明度（rawDt，不吃子彈時間） */
export function updateTouchHints(input: Input, rawDt: number): void {
  const fade = (v: number, used: boolean) =>
    used ? Math.max(0.14, v - rawDt * 1.6) : Math.min(1, v + rawDt * 0.8);
  hint.stick = fade(hint.stick, input.stickView !== null);
  hint.drag = fade(hint.drag, input.dragView !== null);
}

function ring(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  width: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, a: number): void {
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = `rgba(220,228,245,${0.55 * a})`;
  ctx.textAlign = 'center';
  ctx.letterSpacing = '2px';
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
}

/**
 * 畫出兩側的觸控操作介面。
 *
 * @param power  目前這一斬的威力 0..1（給拖曳圈上色與畫進度弧）
 * @param cancel 是否落在取消區（拖太短 → 放開不會出刀）
 */
export function drawTouchControls(
  ctx: CanvasRenderingContext2D,
  input: Input,
  w: number,
  h: number,
  power: number,
  cancel: boolean,
): void {
  const inset = T.touch.hintInset;
  const maxDrag = touchMaxDrag(w, h);

  ctx.save();
  ctx.lineCap = 'round';

  // ── 左：虛擬搖桿 ──
  const stick = input.stickView;
  if (stick) {
    const dx = stick.x - stick.ox;
    const dy = stick.y - stick.oy;
    const d = Math.hypot(dx, dy);
    const k = d > T.touch.stickRadius ? T.touch.stickRadius / d : 1;
    const kx = stick.ox + dx * k;
    const ky = stick.oy + dy * k;

    ctx.fillStyle = 'rgba(12,14,20,0.28)';
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, T.touch.stickRadius, 0, Math.PI * 2);
    ctx.fill();
    ring(ctx, stick.ox, stick.oy, T.touch.stickRadius, 'rgba(210,220,245,0.32)', 2);

    ctx.fillStyle = 'rgba(225,232,250,0.5)';
    ctx.beginPath();
    ctx.arc(kx, ky, 22, 0, Math.PI * 2);
    ctx.fill();
    ring(ctx, kx, ky, 22, 'rgba(255,255,255,0.75)', 2);
  } else if (hint.stick > 0.02) {
    const a = hint.stick;
    ctx.setLineDash([6, 7]);
    ring(ctx, inset, h - inset, T.touch.stickRadius, `rgba(210,220,245,${0.3 * a})`, 2);
    ctx.setLineDash([]);
    label(ctx, '移 動', inset, h - inset + 4, a);
  }

  // ── 右：斬擊拖曳板 ──
  const drag = input.dragView;
  if (drag) {
    const dx = drag.x - drag.ox;
    const dy = drag.y - drag.oy;
    const d = Math.hypot(dx, dy);
    const k = d > maxDrag ? maxDrag / d : 1;
    const ex = drag.ox + dx * k;
    const ey = drag.oy + dy * k;

    const g = cancel ? 100 : Math.round(lerp(228, 118, power));
    const b = cancel ? 92 : Math.round(lerp(196, 58, power));
    const main = `rgba(255,${g},${b},`;

    // 按下點：拖曳的原點，也是「威力 0」的位置
    ctx.fillStyle = 'rgba(12,14,20,0.26)';
    ctx.beginPath();
    ctx.arc(drag.ox, drag.oy, 26, 0, Math.PI * 2);
    ctx.fill();
    ring(ctx, drag.ox, drag.oy, 26, `${main}0.5)`, 2);

    // 拖曳線：黑底 + 主色，暗背景與亮特效上都看得見
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(drag.ox, drag.oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    ctx.strokeStyle = `${main}0.9)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(drag.ox, drag.oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // 威力進度弧：繞著按下點長出來，拖滿 = 整圈
    if (!cancel && power > 0.01) {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(drag.ox, drag.oy, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
      ctx.stroke();

      ctx.strokeStyle = `${main}0.95)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(drag.ox, drag.oy, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
      ctx.stroke();
    }

    // 手指端點；取消區內畫叉，明示「現在放開不會出刀」
    ctx.fillStyle = `${main}0.28)`;
    ctx.beginPath();
    ctx.arc(ex, ey, 20, 0, Math.PI * 2);
    ctx.fill();
    ring(ctx, ex, ey, 20, `${main}0.85)`, 2);

    if (cancel) {
      ctx.strokeStyle = `${main}0.9)`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(ex - 7, ey - 7);
      ctx.lineTo(ex + 7, ey + 7);
      ctx.moveTo(ex + 7, ey - 7);
      ctx.lineTo(ex - 7, ey + 7);
      ctx.stroke();
    }
  } else if (hint.drag > 0.02) {
    const a = hint.drag;
    const hx = w - inset;
    const hy = h - inset;
    ctx.setLineDash([6, 7]);
    ring(ctx, hx, hy, 26, `rgba(255,205,150,${0.34 * a})`, 2);
    ctx.setLineDash([]);

    // 往左上比一道短箭頭，暗示「按住往目標方向拖」
    const t = performance.now() / 1000;
    const push = 12 + Math.sin(t * 2.2) * 5;
    ctx.strokeStyle = `rgba(255,205,150,${0.4 * a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx - 6, hy - 6);
    ctx.lineTo(hx - 6 - push, hy - 6 - push);
    ctx.stroke();

    label(ctx, '按住拖曳出刀', hx, hy + 46, a);
  }

  ctx.restore();
}

/**
 * 直向持握時的提示。
 * 場地是 1100×820 的橫向競技場，直握等於自砍一半視野，
 * 與其硬塞版面，不如請玩家轉一下——遊戲照常運作，只是蓋一層提示。
 */
export function drawRotateHint(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(6,7,11,0.82)';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const t = performance.now() / 1000;

  // 一支慢慢轉成橫向的手機
  ctx.save();
  ctx.translate(cx, cy - 30);
  ctx.rotate(lerp(0, Math.PI / 2, clamp((Math.sin(t * 1.4) + 1) / 2, 0, 1)) * 0.9);
  ctx.strokeStyle = 'rgba(235,240,255,0.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(-34, -58, 68, 116, 10);
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.font = `700 17px ${FONT}`;
  ctx.fillStyle = 'rgba(245,248,255,0.95)';
  ctx.letterSpacing = '3px';
  ctx.fillText('請把手機轉成橫向', cx, cy + 82);
  ctx.letterSpacing = '0px';

  ctx.font = `400 13px ${FONT}`;
  ctx.fillStyle = 'rgba(180,190,215,0.8)';
  ctx.fillText('這是一場橫向的競技場戰鬥', cx, cy + 110);
  ctx.textAlign = 'left';
  ctx.restore();
}
