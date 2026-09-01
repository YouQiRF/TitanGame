/**
 * 輸入層。
 *
 * 設計原則：
 *  - 持續狀態（WASD、蓄力鍵按住）用查詢式 API
 *  - 一次性事件（蓄力放開）用「邊緣觸發 + consume」，
 *    確保一個事件只會被邏輯層處理一次，不受幀率影響。
 *  - 滑鼠座標存 CSS 像素（= 邏輯座標），渲染端已用 dpr 縮放過。
 *  - 觸控與鍵鼠共用同一組對外 API（chargeDown / moveAxis / consumeChargeRelease），
 *    邏輯層不需要知道玩家用的是什麼裝置。
 *
 * ── 輸入配置（鍵鼠）────────────────────────────────────
 *  蓄力（斬擊）：**滑鼠左鍵**長按，放開沿方向位移斬擊——
 *  沒有獨立的翻滾/閃避鍵，斬擊位移期間的無敵幀就是唯一的閃避手段。
 *
 * ── 輸入配置（觸控）────────────────────────────────────
 *  左半屏 = 虛擬搖桿（按下處即為底座中心，往哪推就往哪走）
 *  右半屏 = 斬擊拖曳板（按住進入子彈時間，往目標方向拖，放開出刀）
 *  兩邊可以同時按，也就是「邊走邊瞄」。
 *
 *  標題／結算畫面時 main 會打開 uiPointerMode，
 *  此時不分左右半屏，整個畫面就是一支滑鼠，讓既有的點擊判定原封不動可用。
 *
 * ── 蓄力取消 ────────────────────────────────────────────
 *  鍵鼠：放開左鍵時游標落在角色身上的取消區內即取消（判定在 slash.ts）。
 *  觸控：拖曳距離太短（≈ 輕點）就落在取消區內，等同「點錯了不出刀」。
 */

import { T } from '../tuning.ts';

/** 觸控指標：一根被遊戲接管的手指 */
interface TouchPointer {
  id: number;
  /** 按下位置（CSS 像素，相對 canvas） */
  ox: number;
  oy: number;
  /** 目前位置 */
  x: number;
  y: number;
}

export class Input {
  private keys = new Set<string>();

  /** 游標位置（螢幕 / CSS 像素）；觸控時是「斬擊那根手指」的位置 */
  mouse = { x: 0, y: 0 };

  /** 這次蓄力開始時的游標位置，'drag' 瞄準模式會用到 */
  chargeStartAt = { x: 0, y: 0 };

  /**
   * 是否已切換成觸控操作。第一次 touchstart 後為 true 且不再變回去——
   * 混合裝置（觸控筆電）上跟著「最後用過的裝置」切換太容易閃爍，
   * 碰過螢幕就固定顯示觸控 UI 比較穩定。
   */
  touchMode = false;

  /**
   * UI 指標模式：標題／結算畫面時由 main 打開。
   * 開啟時觸控不分左右半屏，整個畫面都當滑鼠用。
   */
  uiPointerMode = false;

  /** 左半屏的虛擬搖桿；null = 沒有手指在推 */
  private stick: TouchPointer | null = null;

  /** 右半屏的斬擊拖曳板；null = 沒有手指在蓄力 */
  private drag: TouchPointer | null = null;

  private leftDown = false;

  /** 是否正在蓄力（左鍵按住 / 右半屏按住） */
  private chargeActive = false;

  private chargeReleasedEdge = false;
  private keyPressedEdge = new Set<string>();

  constructor(canvas: HTMLCanvasElement) {
    const rect = () => canvas.getBoundingClientRect();

    const setMouse = (e: MouseEvent) => {
      const r = rect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    };

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const isNew = !this.keys.has(k);
      if (isNew) this.keyPressedEdge.add(k);
      this.keys.add(k);

      // 避免空白鍵捲動頁面（空白鍵目前沒有綁定任何遊戲功能）
      if (k === ' ') e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });

    // 視窗失焦時清空所有狀態，避免「回來後角色還在自己走 / 還在蓄力」
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.leftDown = false;
      this.chargeActive = false;
      this.stick = null;
      this.drag = null;
    });

    // ── 滑鼠 ────────────────────────────────────────────
    // 一旦進入觸控模式就整組忽略：部分行動瀏覽器仍會在 touchend 之後
    // 補送一輪合成滑鼠事件，不擋掉的話會多出一次假的蓄力。

    canvas.addEventListener('mousemove', (e) => {
      if (this.touchMode) return;
      setMouse(e);
    });

    canvas.addEventListener('mousedown', (e) => {
      if (this.touchMode) return;
      setMouse(e);
      if (e.button === 0) {
        this.leftDown = true;
        this.chargeActive = true;
        this.chargeStartAt.x = this.mouse.x;
        this.chargeStartAt.y = this.mouse.y;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.touchMode) return;
      if (e.button === 0) {
        this.leftDown = false;
        if (this.chargeActive) {
          this.chargeActive = false;
          this.chargeReleasedEdge = true;
        }
      }
    });

    // 右鍵目前沒有綁定遊戲功能，但畫布上仍擋掉瀏覽器的右鍵選單，避免打斷遊戲
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── 觸控 ────────────────────────────────────────────
    // 全部 preventDefault：擋掉捲動、雙擊縮放、長按選字與合成滑鼠事件。
    // 必須 passive: false，否則瀏覽器會忽略 preventDefault。

    const startCharge = (p: TouchPointer) => {
      this.drag = p;
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      this.chargeStartAt.x = p.ox;
      this.chargeStartAt.y = p.oy;
      this.leftDown = true;
      this.chargeActive = true;
    };

    canvas.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.touchMode = true;
        const r = rect();

        for (const t of Array.from(e.changedTouches)) {
          const x = t.clientX - r.left;
          const y = t.clientY - r.top;
          const p: TouchPointer = { id: t.identifier, ox: x, oy: y, x, y };

          // UI 模式：任何一根手指都是滑鼠，不切左右半屏
          if (this.uiPointerMode) {
            if (!this.drag) startCharge(p);
            continue;
          }

          if (x < r.width / 2) {
            if (!this.stick) this.stick = p;
          } else if (!this.drag) {
            startCharge(p);
          }
        }
      },
      { passive: false },
    );

    canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        const r = rect();

        for (const t of Array.from(e.changedTouches)) {
          const x = t.clientX - r.left;
          const y = t.clientY - r.top;

          if (this.stick && t.identifier === this.stick.id) {
            this.stick.x = x;
            this.stick.y = y;
          }
          if (this.drag && t.identifier === this.drag.id) {
            this.drag.x = x;
            this.drag.y = y;
            this.mouse.x = x;
            this.mouse.y = y;
          }
        }
      },
      { passive: false },
    );

    /** @param release 手指是正常放開（true）還是被系統中斷（false，不該出刀） */
    const endTouches = (e: TouchEvent, release: boolean) => {
      e.preventDefault();

      for (const t of Array.from(e.changedTouches)) {
        if (this.stick && t.identifier === this.stick.id) this.stick = null;

        if (this.drag && t.identifier === this.drag.id) {
          this.drag = null;
          this.leftDown = false;
          if (this.chargeActive) {
            this.chargeActive = false;
            if (release) this.chargeReleasedEdge = true;
          }
        }
      }
    };

    canvas.addEventListener('touchend', (e) => endTouches(e, true), { passive: false });
    canvas.addEventListener('touchcancel', (e) => endTouches(e, false), { passive: false });
  }

  /** 強制清掉蓄力狀態（例如標題畫面按下的鍵可能還按著，別讓它一進場就變成蓄力） */
  resetCharge(): void {
    this.chargeActive = false;
    this.leftDown = false;
    // 把還按著的那根手指從追蹤中移除：它的 touchend 就不會再被當成一次出刀，
    // 玩家必須重新按下才會開始新的蓄力。
    this.drag = null;
  }

  /** 是否正在蓄力（左鍵按住 / 右半屏按住） */
  get chargeDown(): boolean {
    return this.chargeActive;
  }

  /** 取用「蓄力鍵剛放開」事件 —— 這才是真正要斬出去的訊號 */
  consumeChargeRelease(): boolean {
    const r = this.chargeReleasedEdge;
    this.chargeReleasedEdge = false;
    return r;
  }

  // ── 觸控狀態（給 ui/touch.ts 畫操作介面用）──────────────

  /** 虛擬搖桿的底座中心與旋鈕位置；沒人在推時回傳 null */
  get stickView(): { ox: number; oy: number; x: number; y: number } | null {
    return this.stick && { ox: this.stick.ox, oy: this.stick.oy, x: this.stick.x, y: this.stick.y };
  }

  /** 斬擊拖曳板的按下點與目前位置；沒在蓄力時回傳 null */
  get dragView(): { ox: number; oy: number; x: number; y: number } | null {
    return this.drag && { ox: this.drag.ox, oy: this.drag.oy, x: this.drag.x, y: this.drag.y };
  }

  /** 斬擊拖曳向量（螢幕 CSS 像素）；main 會換算成世界距離 */
  dragVector(): { x: number; y: number } {
    if (!this.drag) return { x: 0, y: 0 };
    return { x: this.drag.x - this.drag.ox, y: this.drag.y - this.drag.oy };
  }

  // ── 一般查詢 ────────────────────────────────────────────

  isDown(key: string): boolean {
    return this.keys.has(key);
  }

  /**
   * 移動的原始方向（未正規化，呼叫端會自行 norm）。
   * 觸控時回傳搖桿位移（死區內視為沒有輸入），否則回傳 WASD 的方向。
   */
  moveAxis(): { x: number; y: number } {
    if (this.touchMode && this.stick) {
      const dx = this.stick.x - this.stick.ox;
      const dy = this.stick.y - this.stick.oy;
      if (Math.hypot(dx, dy) < T.touch.stickDeadzone) return { x: 0, y: 0 };
      return { x: dx, y: dy };
    }

    let x = 0;
    let y = 0;
    if (this.isDown('a') || this.isDown('arrowleft')) x -= 1;
    if (this.isDown('d') || this.isDown('arrowright')) x += 1;
    if (this.isDown('w') || this.isDown('arrowup')) y -= 1;
    if (this.isDown('s') || this.isDown('arrowdown')) y += 1;
    return { x, y };
  }

  /** 取用「某鍵剛按下」事件；回傳後即清除 */
  consumeKeyPress(key: string): boolean {
    const r = this.keyPressedEdge.has(key);
    if (r) this.keyPressedEdge.delete(key);
    return r;
  }

  /** 這一幀有沒有任何按鍵被按下（開始畫面的「按任意鍵」）；取用後即清除 */
  consumeAnyKeyPress(): boolean {
    const r = this.keyPressedEdge.size > 0;
    this.keyPressedEdge.clear();
    return r;
  }

  /** 每幀結尾呼叫，清掉沒被取用的邊緣事件，避免事件累積跨幀觸發 */
  endFrame(): void {
    this.keyPressedEdge.clear();
  }
}
