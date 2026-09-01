/**
 * 開始畫面與結束畫面（死亡 / 勝利）。
 *
 * 全部用 Canvas 繪製，不依賴 DOM，方便之後直接搬到其他渲染後端。
 */

import { clamp, lerp, type Vec } from '../core/vec.ts';

const FONT = '"Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';

export type Chapter = 1 | 2;

interface Dust {
  x: number;
  y: number;
  r: number;
  vy: number;
  vx: number;
  a: number;
}

interface ChapterZone {
  chapter: Chapter;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 兩個章節各自的操作說明機制警語——操作三件套本身不變，只有機制警語不同 */
const CHAPTER_CONTENT: Record<Chapter, { label: string; warn1: string; warn2: string }> = {
  1: {
    label: '第一章．石之守衛',
    warn1: '斬擊可累積破壞守衛的部位 —— 破壞處會變成永久弱點',
    warn2: '但每破壞一處，牠也只會更加狂暴',
  },
  2: {
    label: '第二章．傀儡師',
    warn1: '斬擊的位移無敵幀是唯一的閃避——穿過危險地帶，一路逼近本體',
    warn2: '青綠色的特殊傀儡不會攻擊，斬中可以回體力，但靠近太久會延遲爆炸',
  },
};

export class TitleScreen {
  private t = 0;
  private dust: Dust[] = [];
  private seeded = false;

  /** 標題那一道劍痕的掃過進度，每隔幾秒重播一次 */
  private slashT = 0.6;

  /** 目前滑鼠停留（或預設）的章節，操作說明區塊依此顯示 */
  private hovered: Chapter = 1;

  private seed(w: number, h: number): void {
    this.dust = [];
    for (let i = 0; i < 70; i++) {
      this.dust.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.9,
        vy: -4 - Math.random() * 14,
        vx: (Math.random() - 0.5) * 7,
        a: 0.06 + Math.random() * 0.22,
      });
    }
    this.seeded = true;
  }

  /** 標題/章節按鈕的共用版面計算，draw() 與 hitTestChapter() 都靠這個保持一致 */
  private layout(w: number, h: number) {
    const cx = w / 2;
    const titleY = h * 0.36;
    const titleSize = clamp(w * 0.075, 44, 96);
    const zoneW = clamp(w * 0.19, 200, 280);
    const zoneH = 46;
    const gap = 20;
    const zoneY = titleY + titleSize * 0.62;
    return { cx, titleY, titleSize, zoneW, zoneH, gap, zoneY };
  }

  private zonesFor(w: number, h: number): ChapterZone[] {
    const L = this.layout(w, h);
    const totalW = L.zoneW * 2 + L.gap;
    const x0 = L.cx - totalW / 2;
    return [
      { chapter: 1, x: x0, y: L.zoneY, w: L.zoneW, h: L.zoneH },
      { chapter: 2, x: x0 + L.zoneW + L.gap, y: L.zoneY, w: L.zoneW, h: L.zoneH },
    ];
  }

  /** 點擊座標落在哪個章節入口；沒點中任何一個回傳 null */
  hitTestChapter(mx: number, my: number, w: number, h: number): Chapter | null {
    for (const z of this.zonesFor(w, h)) {
      if (mx >= z.x && mx <= z.x + z.w && my >= z.y && my <= z.y + z.h) return z.chapter;
    }
    return null;
  }

  update(dt: number, w: number, h: number, mouse: Vec): void {
    if (!this.seeded) this.seed(w, h);
    this.t += dt;

    this.hovered = this.hitTestChapter(mouse.x, mouse.y, w, h) ?? this.hovered;

    for (const d of this.dust) {
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y < -10) {
        d.y = h + 10;
        d.x = Math.random() * w;
      }
      if (d.x < -10) d.x = w + 10;
      if (d.x > w + 10) d.x = -10;
    }

    // 每 3.4 秒掃一次劍痕
    this.slashT += dt / 3.4;
    if (this.slashT > 1) this.slashT -= 1;
  }

  /** @param touch 觸控裝置：操作說明改寫成手勢版本，並拿掉「按任意鍵」的提示 */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, touch = false): void {
    // 背景漸層
    const g = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.75);
    g.addColorStop(0, '#1a1c26');
    g.addColorStop(0.55, '#101119');
    g.addColorStop(1, '#07070b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // 塵埃
    for (const d of this.dust) {
      ctx.fillStyle = `rgba(220,225,245,${d.a})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const L = this.layout(w, h);
    const cx = L.cx;
    const titleY = L.titleY;
    const titleSize = L.titleSize;

    // 標題底下的暗紅暈，暗示「核心」
    const halo = ctx.createRadialGradient(cx, titleY, 0, cx, titleY, 300);
    halo.addColorStop(0, 'rgba(255,140,60,0.13)');
    halo.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - 300, titleY - 300, 600, 600);

    // 主標題
    ctx.textAlign = 'center';
    ctx.font = `800 ${titleSize}px ${FONT}`;
    ctx.fillStyle = '#f2f5fb';
    ctx.letterSpacing = '10px';
    ctx.fillText('TITAN SLASH', cx, titleY);
    ctx.letterSpacing = '0px';

    // 掃過標題的劍痕
    const sp = this.slashT;
    if (sp < 0.42) {
      const p = sp / 0.42;
      const eased = 1 - Math.pow(1 - p, 3);
      const x0 = cx - titleSize * 4.2;
      const x1 = cx + titleSize * 4.2;
      const sx = lerp(x0, x1, eased);
      const alpha = Math.sin(p * Math.PI) * 0.85;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const sg = ctx.createLinearGradient(sx - 120, 0, sx + 40, 0);
      sg.addColorStop(0, 'rgba(255,180,90,0)');
      sg.addColorStop(0.75, `rgba(255,215,150,${alpha * 0.5})`);
      sg.addColorStop(1, `rgba(255,255,255,${alpha})`);
      ctx.fillStyle = sg;
      ctx.fillRect(sx - 120, titleY - titleSize * 0.85, 160, titleSize * 1.15);
      ctx.restore();
    }

    // 章節入口：兩個可點擊區塊，取代原本單一的副標文字
    for (const z of this.zonesFor(w, h)) {
      const hot = this.hovered === z.chapter;
      ctx.fillStyle = hot ? 'rgba(255,205,140,0.09)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeStyle = hot ? 'rgba(255,205,140,0.55)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = hot ? 1.6 : 1;
      ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);

      ctx.font = `700 14px ${FONT}`;
      ctx.fillStyle = hot ? 'rgba(255,230,190,0.95)' : 'rgba(220,225,240,0.75)';
      ctx.fillText(CHAPTER_CONTENT[z.chapter].label, z.x + z.w / 2, z.y + z.h * 0.42);

      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = hot ? 'rgba(255,210,150,0.85)' : 'rgba(170,178,200,0.55)';
      ctx.letterSpacing = '2px';
      ctx.fillText('點擊進入', z.x + z.w / 2, z.y + z.h * 0.78);
      ctx.letterSpacing = '0px';
    }

    // 操作說明（兩章節共通，只有下方機制警語不同）
    const rows: Array<[string, string]> = touch
      ? [
          ['左半螢幕', '按住即搖桿，往哪推就往哪走'],
          ['右半螢幕（按住）', '瞄準 → 往目標拖 → 放開斬擊'],
          ['　　　', '拖越遠 → 傷害越高、耗力越大'],
          ['只輕點不拖', '取消，不出刀也不耗體力'],
        ]
      : [
          ['W A S D', '移動'],
          ['滑鼠左鍵（長按）', '子彈時間瞄準，放開斬擊 — 位移中無敵，是唯一的閃避手段'],
          ['　　　', '拉得越遠 → 傷害越高，體力消耗越大'],
          ['蓄力中把游標移回自己身上', '放開即取消，不出刀也不耗體力'],
        ];

    // 手機橫向大約 700–900 寬，下限跟著視窗縮，免得說明框超出畫面
    const boxW = clamp(w * 0.52, Math.min(470, w - 40), 660);
    const rowH = 30;
    const boxH = rows.length * rowH + 42;
    const boxX = cx - boxW / 2;
    const boxY = h * 0.55;

    ctx.fillStyle = 'rgba(255,255,255,0.032)';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = 'rgba(255,190,110,0.8)';
    ctx.textAlign = 'left';
    ctx.letterSpacing = '3px';
    ctx.fillText('操 作', boxX + 22, boxY + 26);
    ctx.letterSpacing = '0px';

    // 說明欄的第二欄跟著框寬走，窄視窗（手機橫向）才不會把字寫到框外
    const descX = boxX + clamp(boxW * 0.4, 150, 230);

    rows.forEach((r, i) => {
      const ry = boxY + 52 + i * rowH;
      ctx.font = `600 13px ${FONT}`;
      ctx.fillStyle = 'rgba(235,240,250,0.9)';
      ctx.fillText(r[0], boxX + 22, ry);
      ctx.font = `400 13px ${FONT}`;
      ctx.fillStyle = 'rgba(175,185,205,0.75)';
      ctx.fillText(r[1], descX, ry);
    });

    // 核心機制警語：依目前懸停/預設的章節而不同
    const content = CHAPTER_CONTENT[this.hovered];
    ctx.textAlign = 'center';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = 'rgba(255,140,95,0.82)';
    ctx.fillText(content.warn1, cx, boxY + boxH + 28);
    ctx.fillStyle = 'rgba(255,110,80,0.75)';
    ctx.fillText(content.warn2, cx, boxY + boxH + 48);

    // 開始提示
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.6);
    ctx.font = `600 15px ${FONT}`;
    ctx.fillStyle = `rgba(255,225,170,${0.4 + pulse * 0.55})`;
    ctx.letterSpacing = '4px';
    ctx.fillText(
      touch ? '點擊章節進入' : '點擊章節進入　·　按任意鍵直接開始第一章',
      cx,
      boxY + boxH + 84,
    );
    ctx.letterSpacing = '0px';

    // 角落資訊
    ctx.textAlign = 'left';
    ctx.font = `400 11px ${FONT}`;
    ctx.fillStyle = 'rgba(140,148,168,0.4)';
    ctx.fillText('v0.1.0  ·  prototype', 22, h - 20);

    ctx.textAlign = 'left';
  }
}

/** 結算畫面的按鈕（只有觸控裝置會畫出來，鍵鼠玩家用 R / Esc） */
export type OutcomeButton = 'retry' | 'title';

interface ButtonRect {
  key: OutcomeButton;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 按鈕版面：draw 與 hitTest 共用，保證畫到哪就點得到哪 */
function outcomeButtons(w: number, h: number): ButtonRect[] {
  const bw = clamp(w * 0.2, 150, 210);
  const bh = 52;
  const gap = 18;
  const y = h * 0.42 + 96;
  const x0 = w / 2 - (bw * 2 + gap) / 2;
  return [
    { key: 'retry', label: '重新挑戰', x: x0, y, w: bw, h: bh },
    { key: 'title', label: '回到標題', x: x0 + bw + gap, y, w: bw, h: bh },
  ];
}

/** 點擊座標落在哪顆結算按鈕上；沒點中回傳 null */
export function hitTestOutcomeButton(
  mx: number,
  my: number,
  w: number,
  h: number,
): OutcomeButton | null {
  for (const b of outcomeButtons(w, h)) {
    if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b.key;
  }
  return null;
}

/**
 * 死亡 / 勝利的覆蓋層。fade 為 0..1 的淡入進度。
 * @param touch 觸控裝置：畫可點的按鈕取代「按 R / 按 Esc」的鍵盤提示
 */
export function drawOutcome(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  kind: 'dead' | 'victory',
  fade: number,
  timeSec: number,
  victoryTitle: string,
  defeatSub: string,
  touch = false,
): void {
  const a = clamp(fade, 0, 1);

  ctx.fillStyle =
    kind === 'dead' ? `rgba(24,6,8,${a * 0.72})` : `rgba(10,14,22,${a * 0.66})`;
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h * 0.42;

  ctx.textAlign = 'center';
  ctx.globalAlpha = a;

  const size = clamp(w * 0.055, 38, 72);
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.letterSpacing = '8px';

  if (kind === 'dead') {
    ctx.fillStyle = '#e2565f';
    ctx.fillText('你 已 倒 下', cx, cy);
    ctx.letterSpacing = '0px';
    ctx.font = `400 15px ${FONT}`;
    ctx.fillStyle = 'rgba(215,200,205,0.7)';
    ctx.fillText(defeatSub, cx, cy + 46);
  } else {
    ctx.fillStyle = '#ffd27a';
    ctx.fillText(victoryTitle, cx, cy);
    ctx.letterSpacing = '0px';
    ctx.font = `400 15px ${FONT}`;
    ctx.fillStyle = 'rgba(225,220,205,0.75)';
    ctx.fillText(`耗時 ${timeSec.toFixed(1)} 秒`, cx, cy + 46);
  }

  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 380);

  if (touch) {
    ctx.textBaseline = 'middle';
    for (const b of outcomeButtons(w, h)) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = `rgba(255,215,160,${0.35 + pulse * 0.3})`;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);

      ctx.font = `700 15px ${FONT}`;
      ctx.fillStyle = 'rgba(255,235,205,0.95)';
      ctx.letterSpacing = '2px';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
      ctx.letterSpacing = '0px';
    }
    ctx.textBaseline = 'alphabetic';
  } else {
    ctx.font = `600 14px ${FONT}`;
    ctx.fillStyle = `rgba(240,240,250,${(0.35 + pulse * 0.5) * a})`;
    ctx.letterSpacing = '3px';
    ctx.fillText('按 R 重新挑戰　·　按 Esc 回到標題', cx, cy + 104);
    ctx.letterSpacing = '0px';
  }

  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}
