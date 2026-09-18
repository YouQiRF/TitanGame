/**
 * 全螢幕暗角（vignette）快取。
 *
 * 子彈時間、Boss 憤怒、低血量警示這三層都是「整個畫面一張徑向漸層」。
 * 原本每幀 `createRadialGradient()` + `fillRect(0,0,viewW,viewH)`——
 * 漸層物件無法重用，等於每幀要 CPU 逐像素算滿整張畫布，
 * 而且 DPR=2 的螢幕像素量是四倍。三層疊起來就是每幀數千萬像素的填色。
 *
 * 實際上這些漸層**形狀固定、只有強度在變**，所以：
 *  1. 以 alpha=1 預先渲染到一張離屏 canvas（只在視窗尺寸變化時重建）
 *  2. 每幀只做 `globalAlpha = k` + 一次 `drawImage` 縮放貼上
 *
 * 離屏畫布刻意用 `DOWNSCALE` 倍的低解析度：內容是平滑漸層，
 * 放大回來看不出差別，但要算的像素少了兩個數量級。
 */

type RGB = [number, number, number];

/** 離屏畫布相對實際畫面的縮小倍率 */
const DOWNSCALE = 6;

export class Vignette {
  private cv: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;

  /**
   * @param innerFrac 透明區半徑，佔 min(w,h) 的比例
   * @param outerFrac 完全不透明處的半徑，佔 max(w,h) 的比例
   * @param col       顏色
   * @param peak      這張圖本身的最大不透明度（每幀再乘上傳入的強度）
   */
  constructor(
    private innerFrac: number,
    private outerFrac: number,
    private col: RGB,
    private peak: number,
  ) {}

  private rebuild(viewW: number, viewH: number): void {
    const w = Math.max(2, Math.ceil(viewW / DOWNSCALE));
    const h = Math.max(2, Math.ceil(viewH / DOWNSCALE));
    if (this.cv && this.w === w && this.h === h) return;

    const cv = this.cv ?? document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d');
    if (!c) return;

    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * this.innerFrac,
      w / 2,
      h / 2,
      Math.max(w, h) * this.outerFrac,
    );
    const [r, gr, b] = this.col;
    g.addColorStop(0, `rgba(${r},${gr},${b},0)`);
    g.addColorStop(1, `rgba(${r},${gr},${b},${this.peak})`);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    this.cv = cv;
    this.w = w;
    this.h = h;
  }

  /** @param strength 0..1，這一幀的強度；<= 0 時直接跳過 */
  draw(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, strength: number): void {
    if (strength <= 0.01) return;
    this.rebuild(viewW, viewH);
    if (!this.cv) return;

    ctx.save();
    ctx.globalAlpha = Math.min(1, strength);
    ctx.drawImage(this.cv, 0, 0, viewW, viewH);
    ctx.restore();
  }
}
