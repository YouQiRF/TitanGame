/**
 * 俯視鏡頭：跟隨玩家、朝游標微幅前瞻、支援螢幕震動，並夾在競技場邊界內。
 */

import { T } from '../tuning.ts';
import { clamp, damp, len, scale, type Vec } from './vec.ts';

export class Camera {
  /** 鏡頭中心（世界座標） */
  pos: Vec = { x: T.arena.w / 2, y: T.arena.h / 2 };

  private shakeT = 0;
  private shakeDur = 0;
  private shakeMag = 0;
  private shakeOff: Vec = { x: 0, y: 0 };

  /** 目前視窗的邏輯尺寸，由 main 每幀更新 */
  viewW = 0;
  viewH = 0;

  /**
   * 縮放倍率：讓玩家看不到全地圖，逼玩家更依賴讀圖／記位置。
   * 依 `T.camera.visibleFraction` 算出，取兩軸中較大的縮放值，
   * 確保任一軸顯示的場地都不會超過目標比例。
   */
  zoom = 1;

  /**
   * 額外疊加的縮放倍率，預設 1（不影響一般畫面）。
   * 給傀儡師終局處決那種一次性的鏡頭放大演出用，main.ts 直接調這個值，
   * 不影響 `zoom` 本身（`zoom` 是跟隨視窗大小算出來的基準縮放）。
   */
  execZoomMult = 1;

  resize(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    const f = T.camera.visibleFraction;
    const zoomX = w / (T.arena.w * f);
    const zoomY = h / (T.arena.h * f);
    this.zoom = Math.max(zoomX, zoomY);
  }

  /**
   * @param target 要跟隨的目標（玩家）
   * @param aimOffset 游標相對於目標的向量，用來做前瞻
   * @param dt 真實時間（鏡頭不吃子彈時間，否則瞄準時鏡頭會黏住）
   */
  update(target: Vec, aimOffset: Vec, dt: number): void {
    let look = scale(aimOffset, T.camera.lookAhead);
    const l = len(look);
    if (l > T.camera.lookAheadMax) look = scale(look, T.camera.lookAheadMax / l);

    const goalX = target.x + look.x;
    const goalY = target.y + look.y;

    this.pos.x = damp(this.pos.x, goalX, T.camera.followRate, dt);
    this.pos.y = damp(this.pos.y, goalY, T.camera.followRate, dt);

    this.clampToArena();

    // 震動：隨時間線性衰減
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const k = this.shakeDur > 0 ? this.shakeT / this.shakeDur : 0;
      const m = this.shakeMag * k * k;
      const a = Math.random() * Math.PI * 2;
      this.shakeOff.x = Math.cos(a) * m;
      this.shakeOff.y = Math.sin(a) * m;
    } else {
      this.shakeOff.x = 0;
      this.shakeOff.y = 0;
    }
  }

  /** 可視世界範圍比競技場大的時候置中，否則夾住不讓鏡頭看到場外 */
  private clampToArena(): void {
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (T.arena.w <= halfW * 2) {
      this.pos.x = T.arena.w / 2;
    } else {
      this.pos.x = clamp(this.pos.x, halfW, T.arena.w - halfW);
    }
    if (T.arena.h <= halfH * 2) {
      this.pos.y = T.arena.h / 2;
    } else {
      this.pos.y = clamp(this.pos.y, halfH, T.arena.h - halfH);
    }
  }

  shake(magnitude: number, duration: number): void {
    // 取較強者，避免小震動蓋掉正在進行的大震動
    if (magnitude >= this.shakeMag * (this.shakeDur > 0 ? this.shakeT / this.shakeDur : 0)) {
      this.shakeMag = magnitude;
      this.shakeDur = duration;
      this.shakeT = duration;
    }
  }

  /** 套用鏡頭變換（含縮放）；呼叫前請先 ctx.save()。震動維持在螢幕空間，不受縮放影響 */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.translate(
      Math.round(this.viewW / 2 + this.shakeOff.x),
      Math.round(this.viewH / 2 + this.shakeOff.y),
    );
    const z = this.zoom * this.execZoomMult;
    ctx.scale(z, z);
    ctx.translate(-this.pos.x, -this.pos.y);
  }

  screenToWorld(sx: number, sy: number): Vec {
    return {
      x: (sx - this.viewW / 2) / this.zoom + this.pos.x,
      y: (sy - this.viewH / 2) / this.zoom + this.pos.y,
    };
  }

  worldToScreen(w: Vec): Vec {
    return {
      x: (w.x - this.pos.x) * this.zoom + this.viewW / 2,
      y: (w.y - this.pos.y) * this.zoom + this.viewH / 2,
    };
  }

  /** 世界座標點是否落在目前螢幕可視範圍內（含 margin 的容忍範圍） */
  isOnScreen(worldPos: Vec, margin = 0): boolean {
    const s = this.worldToScreen(worldPos);
    return (
      s.x >= -margin && s.x <= this.viewW + margin && s.y >= -margin && s.y <= this.viewH + margin
    );
  }
}
