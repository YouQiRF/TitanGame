/**
 * 抬頭顯示：血條、體力條（含本次斬擊的耗力預覽）、Boss 血條、
 * 瞄準線與傷害跳字。
 *
 * 設計重點：瞄準時玩家必須「一眼看懂這一斬要花多少體力、換多少傷害」，
 * 所以體力條上直接畫出即將被吃掉的區段。
 */

import { T } from '../tuning.ts';
import type { Player } from '../player.ts';
import { Guardian } from '../boss/guardian.ts';
import type { Puppeteer } from '../boss/puppeteer.ts';
import type { SlashPlan } from '../slash.ts';
import type { Camera } from '../core/camera.ts';
import { add, clamp, lerp, scale, type Vec } from '../core/vec.ts';

/**
 * 兩隻 Boss 在 HUD 上共用 rage/rageRatio 的語意（石之守衛＝憤怒等級，
 * 傀儡師＝目前階段），型別上用聯合型別讓 HUD 能統一呼叫，
 * 只有部位破壞條這類真正 Guardian 專屬的畫面才用 instanceof 分支。
 */
type AnyBoss = Guardian | Puppeteer;

interface Popup {
  pos: Vec;
  text: string;
  color: string;
  life: number;
  vy: number;
  size: number;
}

const FONT = '"Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';

export class HUD {
  private popups: Popup[] = [];
  /** Boss 血條的延遲追尾，讓掉血看得出來 */
  private bossHpGhost = 1;

  addPopup(pos: Vec, text: string, color: string, size = 20): void {
    this.popups.push({
      pos: { x: pos.x, y: pos.y },
      text,
      color,
      life: 1,
      vy: -46,
      size,
    });
  }

  reset(): void {
    this.popups = [];
    this.bossHpGhost = 1;
  }

  update(dt: number, boss: AnyBoss): void {
    for (const p of this.popups) {
      p.life -= dt * 1.15;
      p.pos.y += p.vy * dt;
      p.vy += 42 * dt;
    }
    this.popups = this.popups.filter((p) => p.life > 0);

    const maxHp = boss instanceof Guardian ? T.guardian.maxHp : T.puppeteer.maxHp;
    const target = boss.hp / maxHp;
    this.bossHpGhost += (target - this.bossHpGhost) * Math.min(1, dt * 3.2);
  }

  // ── 世界空間 ────────────────────────────────────────────

  /** 瞄準線：長度 = 實際斬擊距離，顏色 = 威力。同時繪製身上的取消區 */
  drawAim(ctx: CanvasRenderingContext2D, player: Player, plan: SlashPlan): void {
    if (!player.aiming) return;

    const from = player.pos;
    const cr = T.slash.cancelRadius;

    // ── 取消區 ──
    // 游標拉回自己身上 = 放棄這一斬。蓄力時一直顯示這個圈，
    // 讓玩家知道「反悔」隨時都在，不必等到學會才發現。
    if (plan.cancel) {
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 170);

      ctx.fillStyle = `rgba(255,80,75,${0.1 + pulse * 0.07})`;
      ctx.beginPath();
      ctx.arc(from.x, from.y, cr, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(255,105,95,${0.7 + pulse * 0.3})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(from.x, from.y, cr, 0, Math.PI * 2);
      ctx.stroke();

      // 大大的 ✕，一眼就懂
      const s = cr * 0.34;
      ctx.strokeStyle = `rgba(255,130,120,${0.85 + pulse * 0.15})`;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(from.x - s, from.y - s);
      ctx.lineTo(from.x + s, from.y + s);
      ctx.moveTo(from.x + s, from.y - s);
      ctx.lineTo(from.x - s, from.y + s);
      ctx.stroke();
      ctx.lineCap = 'butt';

      ctx.font = `700 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText('放開以取消', from.x + 1, from.y + cr + 19);
      ctx.fillStyle = `rgba(255,150,140,${0.85 + pulse * 0.15})`;
      ctx.fillText('放開以取消', from.x, from.y + cr + 18);
      ctx.textAlign = 'left';

      // 取消時不畫瞄準線——畫面上不該同時出現「要斬」和「不斬」兩種訊號
      return;
    }

    // 未進入取消區：畫一圈低調的虛線，提示這個區域存在
    ctx.setLineDash([4, 7]);
    ctx.strokeStyle = 'rgba(190,205,230,0.26)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(from.x, from.y, cr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!plan.valid) {
      // 體力不足，畫一條斷續的灰線表示揮不動
      ctx.strokeStyle = 'rgba(200,80,80,0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      const end = add(from, scale(plan.dir, T.slash.minDist));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const end = add(from, scale(plan.dir, plan.dist));

    // 威力：白 → 金 → 橙紅
    const r = Math.round(lerp(190, 255, plan.power));
    const g = Math.round(lerp(232, 120, plan.power));
    const b = Math.round(lerp(255, 60, plan.power));
    const col = `rgba(${r},${g},${b},`;

    // 外光暈
    ctx.strokeStyle = `${col}${0.16 + plan.power * 0.2})`;
    ctx.lineWidth = 14 + plan.power * 16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    // 主線
    ctx.strokeStyle = `${col}0.9)`;
    ctx.lineWidth = 2 + plan.power * 3;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // 終點標記
    ctx.strokeStyle = `${col}0.95)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(end.x, end.y, 9 + plan.power * 7, 0, Math.PI * 2);
    ctx.stroke();

    // 被體力裁短時，用虛線把「原本想斬到哪」畫出來，讓玩家知道是體力不夠
    if (plan.capped) {
      ctx.strokeStyle = 'rgba(255,90,90,0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      const wanted = add(from, scale(plan.dir, T.slash.maxDist));
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(wanted.x, wanted.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 傷害數字跟在終點旁
    ctx.font = `bold ${13 + plan.power * 5}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `${col}0.95)`;
    ctx.fillText(`${Math.round(plan.damage)}`, end.x, end.y - 18 - plan.power * 6);
    ctx.textAlign = 'left';
  }

  drawPopups(ctx: CanvasRenderingContext2D): void {
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const a = clamp(p.life, 0, 1);
      ctx.font = `bold ${p.size}px ${FONT}`;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(p.text, p.pos.x + 1.5, p.pos.y + 1.5);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.pos.x, p.pos.y);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  }

  // ── 螢幕空間 ────────────────────────────────────────────

  draw(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    player: Player,
    boss: AnyBoss,
    plan: SlashPlan,
  ): void {
    this.drawPlayerBars(ctx, h, player, plan);
    this.drawBossBar(ctx, w, boss);
  }

  private drawPlayerBars(
    ctx: CanvasRenderingContext2D,
    h: number,
    player: Player,
    plan: SlashPlan,
  ): void {
    const x = 26;
    const y = h - 74;
    const bw = 268;
    const bh = 16;

    // 血量
    this.bar(
      ctx,
      x,
      y,
      bw,
      bh,
      player.hp / T.player.maxHp,
      '#d64550',
      '#ff6b78',
      `HP ${Math.ceil(player.hp)}`,
    );

    // 體力（含耗力預覽）
    const sy = y + bh + 9;
    const sh = 12;
    const ratio = player.stamina / T.player.maxStamina;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 2, sy - 2, bw + 4, sh + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, sy, bw, sh);

    const filled = bw * ratio;
    const grad = ctx.createLinearGradient(x, sy, x + bw, sy);
    grad.addColorStop(0, '#2f9e6e');
    grad.addColorStop(1, '#5fe0a0');
    ctx.fillStyle = grad;
    ctx.fillRect(x, sy, filled, sh);

    // 這一斬會吃掉的區段
    if (player.aiming && plan.valid && plan.cost > 0) {
      const costW = (bw * plan.cost) / T.player.maxStamina;
      const start = Math.max(x, x + filled - costW);
      ctx.fillStyle = plan.capped ? 'rgba(255,90,90,0.85)' : 'rgba(255,214,102,0.85)';
      ctx.fillRect(start, sy, x + filled - start, sh);
    }

    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`STA ${Math.round(player.stamina)}`, x, sy + sh + 15);

    if (player.aiming && plan.cancel) {
      ctx.fillStyle = '#ff8f86';
      ctx.fillText('放開以取消　不消耗體力', x + 84, sy + sh + 15);
    } else if (player.aiming && plan.valid) {
      ctx.fillStyle = plan.capped ? '#ff8a8a' : '#ffd666';
      ctx.fillText(
        `−${Math.round(plan.cost)}  →  ${Math.round(plan.damage)} DMG${plan.capped ? '  (體力不足，已縮短)' : ''}`,
        x + 84,
        sy + sh + 15,
      );
    }
  }

  private drawBossBar(ctx: CanvasRenderingContext2D, w: number, boss: AnyBoss): void {
    const bw = Math.min(560, w - 120);
    const x = (w - bw) / 2;
    const y = 34;
    const bh = 14;
    const rage = boss.rage;
    const isGuardian = boss instanceof Guardian;
    const maxHp = isGuardian ? T.guardian.maxHp : T.puppeteer.maxHp;
    // 憤怒/階段指示的菱形顆數：石之守衛對應部位數(4)，傀儡師固定對應 3 個階段
    const totalDots = isGuardian ? boss.parts.list.length : 3;
    const exposed = isGuardian ? boss.coreExposed : false;

    // 名稱：等級越高越紅、越亮
    const nameCol =
      rage > 0
        ? `rgb(255,${Math.round(200 - rage * 34)},${Math.round(190 - rage * 42)})`
        : 'rgba(230,235,245,0.8)';
    ctx.font = `600 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = nameCol;
    ctx.fillText(boss.name, w / 2, y - 9);
    ctx.textAlign = 'left';

    // 等級指示：名稱右側的菱形
    const dotR = 4.5;
    const dotGap = 13;
    const nameW = ctx.measureText(boss.name).width;
    const dx0 = w / 2 + nameW / 2 + 16;
    for (let i = 0; i < totalDots; i++) {
      const on = i < rage;
      const px = dx0 + i * dotGap;
      const py = y - 13;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      if (on) {
        const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 220 + i);
        ctx.fillStyle = `rgba(255,90,50,${pulse})`;
        ctx.fillRect(-dotR, -dotR, dotR * 2, dotR * 2);
      } else {
        ctx.strokeStyle = 'rgba(200,205,220,0.28)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-dotR, -dotR, dotR * 2, dotR * 2);
      }
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 2, y - 2, bw + 4, bh + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, y, bw, bh);

    // 延遲追尾的白色殘影
    const real = boss.hp / maxHp;
    if (this.bossHpGhost > real) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x + bw * real, y, bw * (this.bossHpGhost - real), bh);
    }

    const grad = ctx.createLinearGradient(x, y, x + bw, y);
    if (rage > 0) {
      grad.addColorStop(0, '#8d3a2a');
      grad.addColorStop(1, `rgb(${Math.round(217 + rage * 8)},${Math.round(154 - rage * 22)},${Math.round(84 - rage * 12)})`);
    } else {
      grad.addColorStop(0, '#8d5a3a');
      grad.addColorStop(1, '#d99a54');
    }
    ctx.fillStyle = exposed ? '#ffcf6b' : grad;
    ctx.fillRect(x, y, bw * real, bh);

    ctx.strokeStyle = rage > 0 ? `rgba(255,120,80,${0.2 + rage * 0.12})` : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, bw, bh);

    // 部位破壞條——只有石之守衛有這套系統，傀儡師沒有部位
    if (isGuardian) this.drawPartBars(ctx, w, boss, y + bh + 10);

    // 等級的具體影響，讓玩家知道自己換到了什麼代價
    if (rage > 0) {
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,${Math.round(150 - rage * 18)},110,0.82)`;
      if (isGuardian) {
        const dmgPct = Math.round(rage * T.guardian.rage.damagePerLevel * 100);
        const spdPct = Math.round(rage * T.guardian.rage.speedPerLevel * 100);
        ctx.fillText(`憤怒 ${rage}　傷害 +${dmgPct}%　速度 +${spdPct}%`, w / 2, y + bh + 62);
      } else {
        const dmgPct = Math.round((T.puppeteer.dmgMultByPhase[rage] - 1) * 100);
        ctx.fillText(`階段 ${rage + 1}　傷害 +${dmgPct}%　出招更頻繁`, w / 2, y + bh + 24);
      }
      ctx.textAlign = 'left';
    }
  }

  /** Boss 血條下方的部位破壞條 */
  private drawPartBars(
    ctx: CanvasRenderingContext2D,
    w: number,
    boss: Guardian,
    y: number,
  ): void {
    const list = boss.parts.list;
    const cellW = Math.min(112, (w - 140) / list.length - 8);
    const gap = 8;
    const totalW = list.length * cellW + (list.length - 1) * gap;
    const x0 = (w - totalW) / 2;
    const barH = 5;

    list.forEach((p, i) => {
      const x = x0 + i * (cellW + gap);

      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'center';

      if (p.broken) {
        // 破壞後的部位是永久弱點，UI 要講清楚這是「可以打的地方」而不只是壞掉了
        const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 260 + i);
        ctx.fillStyle = `rgba(255,190,110,${0.7 + pulse * 0.3})`;
        ctx.fillText(`${p.def.label}・弱點`, x + cellW / 2, y + 9);

        const grad = ctx.createLinearGradient(x, y, x + cellW, y);
        grad.addColorStop(0, `rgba(255,120,50,${0.5 + pulse * 0.25})`);
        grad.addColorStop(1, `rgba(255,205,140,${0.5 + pulse * 0.25})`);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y + 14, cellW, barH);
      } else {
        const dmg = 1 - p.ratio;
        ctx.fillStyle = 'rgba(205,212,228,0.62)';
        ctx.fillText(p.def.label, x + cellW / 2, y + 9);

        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x - 1, y + 13, cellW + 2, barH + 2);
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.fillRect(x, y + 14, cellW, barH);

        // 已累積的破壞值：接近破壞時轉紅並閃爍
        const nearBreak = dmg > 0.75;
        ctx.fillStyle = nearBreak
          ? `rgba(255,110,80,${0.75 + 0.25 * Math.sin(performance.now() / 110)})`
          : 'rgba(255,190,110,0.8)';
        ctx.fillRect(x, y + 14, cellW * dmg, barH);
      }
    });

    ctx.textAlign = 'left';
  }

  /**
   * 場外提示：鏡頭縮小後 Boss 可能不在畫面內，在螢幕邊緣畫一個指向她的箭頭。
   * 顏色依 `boss.isThreatening` 切換——平常冷色，讀招/攻擊中轉警示色並加快脈動，
   * 讓玩家知道「她不在畫面裡」跟「她不在畫面裡而且正在打我」是兩回事。
   */
  drawOffscreenBossIndicator(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    boss: AnyBoss,
    viewW: number,
    viewH: number,
  ): void {
    if (!boss.alive) return;
    const margin = 60;
    if (camera.isOnScreen(boss.pos, margin)) return;

    const screenPos = camera.worldToScreen(boss.pos);
    const cx = viewW / 2;
    const cy = viewH / 2;
    const dx = screenPos.x - cx;
    const dy = screenPos.y - cy;
    const angle = Math.atan2(dy, dx);

    // 把箭頭夾在畫面邊緣內縮的矩形上——上方留大一點的邊界，
    // 避開 Boss 血條／部位條那塊 UI，不要疊在上面
    const pad = 46;
    const topPad = 110;
    const left = pad;
    const right = viewW - pad;
    const top = topPad;
    const bottom = viewH - pad;

    let t = Infinity;
    if (dx > 0) t = Math.min(t, (right - cx) / dx);
    else if (dx < 0) t = Math.min(t, (left - cx) / dx);
    if (dy > 0) t = Math.min(t, (bottom - cy) / dy);
    else if (dy < 0) t = Math.min(t, (top - cy) / dy);

    const ax = cx + dx * t;
    const ay = cy + dy * t;

    const hot = boss.isThreatening;
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / (hot ? 110 : 260));
    const col = hot ? `rgba(255,90,70,${0.75 + pulse * 0.25})` : `rgba(190,205,230,${0.45 + pulse * 0.2})`;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -9);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private bar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    ratio: number,
    c0: string,
    c1: string,
    label: string,
  ): void {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, y, w, h);

    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, c0);
    grad.addColorStop(1, c1);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w * clamp(ratio, 0, 1), h);

    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(label, x + w + 10, y + h - 3);
  }

  /**
   * 準心：一個旋轉的四段弧瞄準環 + 內指標 + 中心菱形。
   *
   * 為了在任何背景（暗地板、亮火花、紅色預警）上都看得見，
   * 每一層都先描一次深色外框再畫主色，最後疊一層柔光。
   * 蓄力時：環收縮、旋轉加快、顏色隨威力由白轉金再轉橙紅，
   * 並在環上長出一圈威力進度弧。
   */
  drawCursor(
    ctx: CanvasRenderingContext2D,
    mouse: Vec,
    aiming: boolean,
    power: number,
    cancel = false,
  ): void {
    const t = performance.now() / 1000;
    const cx = mouse.x;
    const cy = mouse.y;

    const r = 255;
    const g = cancel ? 100 : aiming ? Math.round(lerp(228, 118, power)) : 240;
    const b = cancel ? 92 : aiming ? Math.round(lerp(196, 58, power)) : 250;
    const main = `rgba(${r},${g},${b},`;

    // 蓄力時環收縮、轉得更快，像在「上膛」；進入取消區則放大並反向轉
    const outer = cancel ? 22 : aiming ? 21 - power * 5 : 17;
    const rot = cancel ? -t * 1.2 : t * (aiming ? 1.5 + power * 3.6 : 0.5);
    const pulse = 0.85 + 0.15 * Math.sin(t * (aiming ? 9 : 3));

    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineCap = 'round';

    // ── 柔光底 ──
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, outer * 1.7);
    glow.addColorStop(0, `rgba(${r},${g},${b},${(aiming ? 0.24 : 0.12) * pulse})`);
    glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, outer * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ── 四段旋轉弧（先深色描邊，再主色）──
    const arcGap = 0.36;
    const drawArcs = (radius: number, width: number, style: string) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      for (let i = 0; i < 4; i++) {
        const base = rot + (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.arc(0, 0, radius, base + arcGap, base + Math.PI / 2 - arcGap);
        ctx.stroke();
      }
    };
    drawArcs(outer, 5.5, 'rgba(0,0,0,0.5)');
    drawArcs(outer, 2.6, `${main}${0.96 * pulse})`);

    // ── 威力進度弧：蓄力時繞著環長出來（取消區內不顯示威力）──
    if (aiming && !cancel && power > 0.01) {
      const pr = outer - 5.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(0, 0, pr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
      ctx.stroke();

      ctx.strokeStyle = `${main}0.95)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, pr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
      ctx.stroke();
    }

    // ── 四條內指標：蓄力時往中心收緊 ──
    const inner = aiming ? 4.5 : 6.5;
    const tick = aiming ? 5.5 - power * 1.5 : 5;
    const drawTicks = (width: number, style: string) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        ctx.moveTo(dx * inner, dy * inner);
        ctx.lineTo(dx * (inner + tick), dy * (inner + tick));
      }
      ctx.stroke();
    };
    drawTicks(5, 'rgba(0,0,0,0.5)');
    drawTicks(2.2, `${main}0.96)`);

    if (cancel) {
      // ── 取消狀態：中心換成 ✕ ──
      const s = 6;
      const drawX = (width: number, style: string) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(-s, -s);
        ctx.lineTo(s, s);
        ctx.moveTo(s, -s);
        ctx.lineTo(-s, s);
        ctx.stroke();
      };
      drawX(6, 'rgba(0,0,0,0.5)');
      drawX(3, `${main}1)`);
    } else {
      // ── 中心菱形 ──
      const ds = aiming ? 3.4 : 2.6;
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(-ds - 1.2, -ds - 1.2, (ds + 1.2) * 2, (ds + 1.2) * 2);
      ctx.fillStyle = `${main}1)`;
      ctx.fillRect(-ds, -ds, ds * 2, ds * 2);
    }

    ctx.lineCap = 'butt';
    ctx.restore();
  }
}
