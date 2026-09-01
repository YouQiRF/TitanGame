/**
 * 進入點：場景管理 + 遊戲主迴圈。
 *
 * 場景：title → playing →（outcome: dead / victory）→ 重開或回標題
 *
 * 時間流：
 *   rawDt  真實時間，用於鏡頭、UI、子彈時間的過渡
 *   dt     rawDt × timeScale，用於玩家、Boss 等所有遊戲實體
 *   瞄準時 timeScale 會平滑降到 T.slash.bulletTimeScale，
 *   命中時插入短暫的 hitstop（dt = 0）製造打擊感。
 *
 * 繪製分層（由下而上）：
 *   場地 → Boss 預警與危險物 → 玩家 → Boss → 飛行物 → 瞄準線 → 跳字
 *   → 螢幕效果（子彈時間暗角、低血量警示）→ HUD → 結果覆蓋層 → 準心
 */

import { T } from './tuning.ts';
import { Arena } from './arena.ts';
import { fx } from './fx.ts';
import { Camera } from './core/camera.ts';
import { Input } from './core/input.ts';
import { Player } from './player.ts';
import { Guardian } from './boss/guardian.ts';
import { Puppeteer } from './boss/puppeteer.ts';
import { HUD } from './ui/hud.ts';
import { TitleScreen, drawOutcome, hitTestOutcomeButton, type Chapter } from './ui/screens.ts';
import { drawRotateHint, drawTouchControls, touchMaxDrag, updateTouchHints } from './ui/touch.ts';
import { planSlash, type SlashPlan } from './slash.ts';
import { add, clamp, damp, len, scale, sub, type Vec } from './core/vec.ts';

type Scene = 'title' | 'playing';
type Outcome = 'none' | 'dead' | 'victory';
type AnyBoss = Guardian | Puppeteer;

/** 兩個章節的勝負文案——傷害模型不同，敘事上的「贏/輸」講法也不同 */
const OUTCOME_TEXT: Record<Chapter, { victoryTitle: string; defeatSub: string }> = {
  1: { victoryTitle: '守 衛 崩 解', defeatSub: '守衛仍然佇立在原地。' },
  2: { victoryTitle: '傀 儡 瓦 解', defeatSub: '傀儡師仍在遠處看著你。' },
};

const FONT = '"Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

const input = new Input(canvas);
const camera = new Camera();
const hud = new HUD();
const title = new TitleScreen();

const PLAYER_SPAWN: Vec = { x: T.arena.w / 2, y: T.arena.h - 150 };
const BOSS_SPAWN: Vec = { x: T.arena.w / 2, y: 250 };

const player = new Player(PLAYER_SPAWN);
let boss: AnyBoss = new Guardian(BOSS_SPAWN);
let chapter: Chapter = 1;

let scene: Scene = 'title';
let outcome: Outcome = 'none';
let outcomeT = 0;
let runTime = 0;

let timeScale = 1;
let hitStopT = 0;

/** 傀儡師終局處決的演出倒數（>0 時強制壓低時間縮放、鏡頭放大） */
let executionT = 0;

/** 部位破壞的橫幅提示 */
let bannerText = '';
let bannerSub = '';
let bannerT = 0;

let viewW = 0;
let viewH = 0;
let dpr = 1;

// ── 畫布尺寸 ──────────────────────────────────────────────

function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.max(1, Math.floor(viewW * dpr));
  canvas.height = Math.max(1, Math.floor(viewH * dpr));
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  camera.resize(viewW, viewH);
}
window.addEventListener('resize', resize);
// 手機轉向：resize 有時比方向變更早一步觸發，補一次延遲重算才拿得到最終尺寸。
// visualViewport 則負責網址列收合造成的高度變化。
window.addEventListener('orientationchange', () => window.setTimeout(resize, 150));
window.visualViewport?.addEventListener('resize', resize);
resize();

// ── 場景切換 ──────────────────────────────────────────────

function startRun(nextChapter: Chapter): void {
  chapter = nextChapter;
  if (chapter === 1) {
    if (!(boss instanceof Guardian)) boss = new Guardian(BOSS_SPAWN);
  } else {
    if (!(boss instanceof Puppeteer)) boss = new Puppeteer(BOSS_SPAWN);
  }

  player.reset(PLAYER_SPAWN);
  boss.reset(BOSS_SPAWN);
  hud.reset();
  fx.clear();
  camera.pos = { x: PLAYER_SPAWN.x, y: PLAYER_SPAWN.y };
  camera.execZoomMult = 1;
  // 在標題畫面按下的那個鍵可能還按著，別讓它一進場就變成蓄力
  input.resetCharge();
  scene = 'playing';
  outcome = 'none';
  outcomeT = 0;
  runTime = 0;
  timeScale = 1;
  hitStopT = 0;
  executionT = 0;
  bannerText = '';
  bannerSub = '';
  bannerT = 0;
}

function toTitle(): void {
  scene = 'title';
  outcome = 'none';
  outcomeT = 0;
}

// ── 瞄準向量 ──────────────────────────────────────────────

/**
 * 瞄準向量（世界距離單位）。
 *
 *  觸控：右半屏的拖曳量 × 換算比例。手指按在哪裡不重要，只看往哪拖、拖多遠——
 *        「拖滿 touchMaxDrag 的長度」= 最遠的一斬（T.slash.maxDist）。
 *  cursor：角色 → 游標（距離由兩者間距決定）
 *  drag  ：按下點 → 目前游標（螢幕相對量，與鏡頭無關）
 */
function aimVector(aimWorld: Vec): Vec {
  if (input.touchMode) {
    return scale(input.dragVector(), T.slash.maxDist / touchMaxDrag(viewW, viewH));
  }
  if (T.slash.aimMode === 'drag') {
    return {
      x: input.mouse.x - input.chargeStartAt.x,
      y: input.mouse.y - input.chargeStartAt.y,
    };
  }
  return sub(aimWorld, player.pos);
}

/**
 * 玩家與 Boss 不可重疊——重疊時玩家會被 Boss 蓋住，等於看不到自己。
 * 斬擊位移期間例外：那是「穿越攻擊」，而且只有 0.13 秒。
 */
/** 蓄力被取消時的回饋：一圈向內收的冷色環，和「斬出去」的外擴刀光相反 */
function cancelFx(): void {
  fx.ring(player.pos, { r0: T.slash.cancelRadius, r1: 8, life: 0.24, width: 3, col: [160, 178, 205] });
  fx.spark(player.pos, 6, {
    speed: 60,
    life: 0.28,
    size: 2.2,
    col: [160, 180, 210],
    radius: 18,
  });
}

function separatePlayerFromBoss(): void {
  if (!boss.alive || !player.alive) return;
  if (player.state === 'slash') return;

  const bossRadius = boss instanceof Guardian ? T.guardian.radius : T.puppeteer.radius;
  const minD = bossRadius + T.player.radius;
  const dx = player.pos.x - boss.pos.x;
  const dy = player.pos.y - boss.pos.y;
  const d = Math.hypot(dx, dy);
  if (d >= minD) return;

  // 完全重合時給一個預設方向，避免除以零
  const nx = d > 0.001 ? dx / d : 0;
  const ny = d > 0.001 ? dy / d : 1;
  player.pos.x = boss.pos.x + nx * minD;
  player.pos.y = boss.pos.y + ny * minD;
  Arena.confine(player.pos, T.player.radius);
}

// ── 主迴圈 ────────────────────────────────────────────────

let last = performance.now();

function frame(now: number): void {
  const rawDt = clamp((now - last) / 1000, 0, 1 / 30);
  last = now;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 選單類畫面沒有「移動」可言，整個螢幕都當滑鼠用，
  // 章節入口與結算按鈕才不會因為落在左半屏而被虛擬搖桿吃掉。
  input.uiPointerMode = scene === 'title' || outcome !== 'none';

  if (scene === 'title') {
    updateTitle(rawDt);
  } else {
    updatePlaying(rawDt);
  }

  // 直向持握時蓋一層轉向提示：場地是橫向的，直握等於自砍一半視野
  if (input.touchMode && viewH > viewW) drawRotateHint(ctx, viewW, viewH);

  input.endFrame();
  requestAnimationFrame(frame);
}

function updateTitle(rawDt: number): void {
  title.update(rawDt, viewW, viewH, input.mouse);
  title.draw(ctx, viewW, viewH, input.touchMode);
  // 觸控沒有游標可以畫，手指本身就是游標
  if (!input.touchMode) hud.drawCursor(ctx, input.mouse, false, 0);

  // 「放開」才開始，避免這一下按住被當成瞄準帶進戰鬥。
  // 滑鼠放開時依點擊座標判斷選了哪個章節入口；鍵盤按任意鍵固定進第一章。
  if (input.consumeChargeRelease()) {
    const picked = title.hitTestChapter(input.mouse.x, input.mouse.y, viewW, viewH);
    if (picked) startRun(picked);
  } else if (input.consumeAnyKeyPress()) {
    startRun(1);
  }
}

function updatePlaying(rawDt: number): void {
  const touch = input.touchMode;
  if (touch) updateTouchHints(input, rawDt);

  const cursorWorld = camera.screenToWorld(input.mouse.x, input.mouse.y);
  const aimVec = aimVector(cursorWorld);

  // 角色面向與鏡頭前瞻要的是「瞄準的那一點」。
  // 觸控的瞄準跟手指的螢幕座標無關，得從拖曳向量反推回世界座標。
  const aimWorld = touch ? add(player.pos, aimVec) : cursorWorld;

  // 取消區判定：鍵鼠看游標離角色多遠，觸控看拖了多遠（＝輕點不出刀）
  const cursorDist = touch
    ? len(aimVec)
    : Math.hypot(cursorWorld.x - player.pos.x, cursorWorld.y - player.pos.y);

  const finished = outcome !== 'none';

  if (finished && outcomeT > 0.5) {
    if (input.consumeKeyPress('r')) {
      startRun(chapter);
      return;
    }
    if (input.consumeKeyPress('escape')) {
      toTitle();
      return;
    }
    // 觸控沒有鍵盤，改點結算畫面上的兩顆按鈕
    if (touch && input.consumeChargeRelease()) {
      const picked = hitTestOutcomeButton(input.mouse.x, input.mouse.y, viewW, viewH);
      if (picked === 'retry') {
        startRun(chapter);
        return;
      }
      if (picked === 'title') {
        toTitle();
        return;
      }
    }
  }

  const wantAim = input.chargeDown && player.canAct && !finished;
  player.aiming = wantAim;

  const plan: SlashPlan = wantAim
    ? player.plan(aimVec, cursorDist)
    : planSlash(player.stamina, { x: 0, y: 0 }, Infinity);

  if (!finished) {
    // 放開左鍵 → 斬擊，除非游標停在取消區內
    if (input.consumeChargeRelease() && player.canAct) {
      const p = player.plan(aimVec, cursorDist);
      if (p.cancel) cancelFx();
      else player.doSlash(aimVec, cursorDist);
    }
  } else {
    input.consumeChargeRelease();
  }

  // ── 時間縮放 ──
  // 處決演出期間強制壓到比一般子彈時間更慢，蓋過瞄準狀態的判斷
  const targetScale =
    executionT > 0 ? T.puppeteer.execute.cinematicTimeScale : wantAim ? T.slash.bulletTimeScale : 1;
  timeScale = damp(timeScale, targetScale, 1 / Math.max(0.016, T.slash.bulletTimeBlend), rawDt);

  let dt = rawDt * timeScale;
  if (hitStopT > 0) {
    hitStopT = Math.max(0, hitStopT - rawDt);
    dt = 0;
  }

  // 處決演出：用真實時間倒數（不受 timeScale 影響），鏡頭放大倍率沿正弦曲線先放大再收回
  if (executionT > 0) {
    executionT = Math.max(0, executionT - rawDt);
    const p = clamp(1 - executionT / T.puppeteer.execute.cinematicTime, 0, 1);
    camera.execZoomMult = 1 + Math.sin(p * Math.PI) * (T.puppeteer.execute.cinematicZoomPeak - 1);
  } else {
    camera.execZoomMult = 1;
  }

  if (!finished) runTime += rawDt;
  if (bannerT > 0) bannerT = Math.max(0, bannerT - rawDt);

  // ── 更新 ──
  // 特效吃已縮放的 dt：子彈時間裡會慢下來，命中頓幀時會定格
  fx.update(dt);
  player.update(dt, input.moveAxis(), aimWorld);
  boss.update(dt, player, camera);
  separatePlayerFromBoss();

  // 斬擊命中結算：用完整軌跡線段做一次性判定，避免高速位移穿透
  if (player.slashHitPending) {
    const seg = player.slashSegment;

    // 斬擊路徑上的目標全部算數，不是只打一個：特殊傀儡（回體力）跟本體（傷害）
    // 同一斬可以一起命中，只要幾何上都在軌跡線段範圍內
    const healedSpecial =
      boss instanceof Puppeteer && boss.puppets.trySlashHeal(seg.a, seg.b, player);

    const hit = boss.tryHit(seg.a, seg.b, player.slashDamage, player.pos);
    player.markSlashResolved();

    if (healedSpecial) {
      hud.addPopup(player.pos, '+體力', '#8ff0d0', 22);
    }
    if (hit) {
      // 命中方向：用斬擊軌跡的方向，火花才會往「刀走的方向」噴
      const sdx = seg.b.x - seg.a.x;
      const sdy = seg.b.y - seg.a.y;
      const sl = Math.hypot(sdx, sdy) || 1;
      const sdir = { x: sdx / sl, y: sdy / sl };

      if (hit.executed) {
        // 傀儡師終局處決：整場最戲劇性的一擊，觸發專屬的放大/慢動作演出。
        // 她的死亡由 Puppeteer 內部的 executing 狀態延遲一小段時間才真正生效，
        // 這裡只負責觸發演出本身，既有的 !boss.alive → victory 判斷會自然接手
        executionT = T.puppeteer.execute.cinematicTime;
        hitStopT = Math.max(hitStopT, 0.16);
        camera.shake(34, 0.6);
        hud.addPopup(hit.point, '處決', '#ffe6a8', 40);
        fx.spark(hit.point, 40, {
          dir: sdir,
          spread: Math.PI,
          speed: 420,
          life: 0.7,
          size: 4,
          col: [255, 220, 150],
        });
        fx.ring(hit.point, { r0: 8, r1: 160, life: 0.5, width: 10, col: [255, 210, 140] });
        fx.ring(hit.point, { r0: 4, r1: 70, life: 0.3, width: 5, col: [255, 250, 220] });
        fx.flash(hit.point, 150, 0.35, [255, 220, 160]);
      } else if (hit.broke) {
        // 部位破壞：最強的回饋，同時提醒玩家守衛被激怒了
        bannerText = `${hit.partLabel} 破壞`;
        bannerSub = '弱點暴露 —— 但守衛更加憤怒了';
        bannerT = 1.8;
        camera.shake(26, 0.55);
        hitStopT = 0.15;
        hud.addPopup(hit.point, `${Math.round(hit.damage)}`, '#ff9a4a', 34);
        // 破壞本身的爆發由 Boss 端負責，這裡只補一道沿刀路的橫向火花
        fx.spark(hit.point, 20, {
          dir: sdir,
          spread: 1.5,
          speed: 380,
          life: 0.5,
          size: 3.4,
          col: [255, 190, 110],
        });
      } else if (hit.kind === 'core') {
        hud.addPopup(hit.point, `${Math.round(hit.damage)}`, '#ffd76b', 30);
        camera.shake(15, 0.3);
        hitStopT = 0.085;
        // 核心命中：金色爆裂，整場最漂亮的一擊
        fx.spark(hit.point, 26, {
          dir: sdir,
          spread: 1.35,
          speed: 400,
          life: 0.5,
          size: 3.6,
          col: [255, 225, 140],
        });
        fx.ring(hit.point, { r0: 6, r1: 105, life: 0.32, width: 7, col: [255, 220, 130] });
        fx.ring(hit.point, { r0: 2, r1: 46, life: 0.2, width: 4, col: [255, 255, 220] });
        fx.flash(hit.point, 95, 0.22, [255, 210, 120]);
      } else if (hit.kind === 'wound') {
        // 打進破壞後的裸露傷口：僅次於核心的高傷害，回饋也要僅次於核心
        hud.addPopup(hit.point, `${Math.round(hit.damage)}`, '#ffb066', 27);
        camera.shake(13, 0.27);
        hitStopT = 0.075;
        fx.spark(hit.point, 22, {
          dir: sdir,
          spread: 1.3,
          speed: 370,
          life: 0.46,
          size: 3.3,
          col: [255, 175, 95],
        });
        fx.ring(hit.point, { r0: 5, r1: 92, life: 0.3, width: 6.5, col: [255, 165, 90] });
        fx.ring(hit.point, { r0: 2, r1: 40, life: 0.18, width: 3.5, col: [255, 235, 190] });
        fx.flash(hit.point, 80, 0.2, [255, 160, 85]);
      } else if (hit.kind === 'part') {
        hud.addPopup(hit.point, `${Math.round(hit.damage)}`, '#ffc074', 21);
        camera.shake(8, 0.18);
        hitStopT = 0.05;
        // 打在裝甲部位：石屑 + 橘色火花
        fx.spark(hit.point, 14, {
          dir: sdir,
          spread: 1.2,
          speed: 300,
          life: 0.38,
          size: 2.8,
          col: [255, 185, 105],
        });
        fx.debris(hit.point, 8, { dir: sdir, spread: 1.3, speed: 240, life: 0.5, size: 3.5 });
        fx.flash(hit.point, 46, 0.14, [255, 180, 100]);
      } else {
        hud.addPopup(hit.point, `${Math.round(hit.damage)}`, '#9aa4b8', 17);
        camera.shake(5, 0.14);
        hitStopT = 0.035;
        // 砍在石殼上：幾乎彈開，火花冷而稀疏——視覺上就在說「這裡打不動」
        fx.spark(hit.point, 8, {
          dir: sdir,
          spread: 1.4,
          speed: 210,
          life: 0.26,
          size: 2.2,
          col: [190, 205, 225],
        });
      }
    }
  }

  // ── 結果判定 ──
  if (outcome === 'none') {
    if (!boss.alive) {
      outcome = 'victory';
      camera.shake(30, 0.8);
      // 守衛崩解：整場最大的一次爆發
      fx.debris(boss.pos, 48, { speed: 470, life: 1.2, radius: 55, gravity: 380 });
      fx.spark(boss.pos, 44, { speed: 400, life: 0.8, size: 4, col: [255, 190, 100], radius: 40 });
      fx.dust(boss.pos, 34, { speed: 250, size: 11, life: 0.9, radius: 60 });
      fx.ring(boss.pos, { r0: 30, r1: 320, life: 0.6, width: 16, col: [255, 180, 100] });
      fx.ring(boss.pos, { r0: 10, r1: 150, life: 0.36, width: 8, col: [255, 240, 200] });
      fx.flash(boss.pos, 280, 0.4, [255, 200, 120]);
      hitStopT = 0.2;
    } else if (!player.alive) {
      outcome = 'dead';
      camera.shake(18, 0.5);
      fx.spark(player.pos, 22, { speed: 300, life: 0.7, size: 3.4, col: [255, 90, 80] });
      fx.ring(player.pos, { r0: 8, r1: 130, life: 0.45, width: 7, col: [255, 90, 80] });
    }
  } else {
    outcomeT += rawDt;
  }

  camera.update(player.pos, sub(aimWorld, player.pos), rawDt);
  hud.update(rawDt, boss);

  render(plan);
}

function render(plan: SlashPlan): void {
  ctx.fillStyle = '#08080a';
  ctx.fillRect(0, 0, viewW, viewH);

  ctx.save();
  camera.apply(ctx);

  Arena.draw(ctx);
  boss.drawGround(ctx);
  fx.drawGround(ctx);
  boss.draw(ctx);
  boss.drawProjectiles(ctx);
  // 玩家畫在 Boss 之上：即使斬擊穿越造成短暫重疊，玩家也絕不會被蓋住
  player.draw(ctx);
  fx.drawOver(ctx);
  hud.drawAim(ctx, player, plan);
  hud.drawPopups(ctx);

  ctx.restore();

  // 子彈時間：暗角 + 邊緣冷色
  const bt = clamp((1 - timeScale) / (1 - T.slash.bulletTimeScale), 0, 1);
  if (bt > 0.01) {
    const g = ctx.createRadialGradient(
      viewW / 2,
      viewH / 2,
      Math.min(viewW, viewH) * 0.18,
      viewW / 2,
      viewH / 2,
      Math.max(viewW, viewH) * 0.72,
    );
    g.addColorStop(0, 'rgba(10,14,30,0)');
    g.addColorStop(1, `rgba(8,12,28,${0.62 * bt})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // Boss 憤怒時，畫面邊緣持續泛紅——玩家不必看 UI 也感覺得到壓力
  if (boss.alive && boss.rage > 0) {
    const k = boss.rageRatio * (0.55 + 0.45 * Math.sin(performance.now() / 420));
    const g = ctx.createRadialGradient(
      viewW / 2,
      viewH / 2,
      Math.min(viewW, viewH) * 0.36,
      viewW / 2,
      viewH / 2,
      Math.max(viewW, viewH) * 0.75,
    );
    g.addColorStop(0, 'rgba(200,40,20,0)');
    g.addColorStop(1, `rgba(200,40,20,${0.3 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // 低血量的紅色警示邊框
  const hpRatio = player.hp / T.player.maxHp;
  if (player.alive && hpRatio < 0.35) {
    const k = (1 - hpRatio / 0.35) * (0.5 + 0.5 * Math.sin(performance.now() / 260));
    const g = ctx.createRadialGradient(
      viewW / 2,
      viewH / 2,
      Math.min(viewW, viewH) * 0.3,
      viewW / 2,
      viewH / 2,
      Math.max(viewW, viewH) * 0.7,
    );
    g.addColorStop(0, 'rgba(180,20,30,0)');
    g.addColorStop(1, `rgba(180,20,30,${0.4 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  hud.draw(ctx, viewW, viewH, player, boss, plan);
  // 場外提示要畫在 Boss 血條之上，不然 Boss 在正上方時箭頭會被血條的底色蓋住
  hud.drawOffscreenBossIndicator(ctx, camera, boss, viewW, viewH);

  drawBanner();

  if (outcome !== 'none') {
    const text = OUTCOME_TEXT[chapter];
    drawOutcome(
      ctx,
      viewW,
      viewH,
      outcome,
      clamp(outcomeT / 0.7, 0, 1),
      runTime,
      text.victoryTitle,
      text.defeatSub,
      input.touchMode,
    );
  }

  // 觸控畫搖桿與拖曳板，鍵鼠畫準心——手指底下畫游標是看不到的
  if (input.touchMode) {
    drawTouchControls(
      ctx,
      input,
      viewW,
      viewH,
      plan.valid ? plan.power : 0,
      player.aiming && plan.cancel,
    );
  } else {
    hud.drawCursor(
      ctx,
      input.mouse,
      player.aiming,
      plan.valid ? plan.power : 0,
      player.aiming && plan.cancel,
    );
  }
}

/** 部位破壞的橫幅：淡入後停留、再淡出 */
function drawBanner(): void {
  if (bannerT <= 0) return;

  const a = bannerT > 1.5 ? (1.8 - bannerT) / 0.3 : Math.min(1, bannerT / 0.45);
  const y = viewH * 0.3;

  ctx.textAlign = 'center';
  ctx.globalAlpha = clamp(a, 0, 1);

  ctx.font = `800 ${clamp(viewW * 0.036, 28, 46)}px ${FONT}`;
  ctx.letterSpacing = '6px';
  ctx.fillStyle = '#ff8f4a';
  ctx.fillText(bannerText, viewW / 2, y);
  ctx.letterSpacing = '0px';

  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = 'rgba(255,200,160,0.85)';
  ctx.fillText(bannerSub, viewW / 2, y + 30);

  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

requestAnimationFrame(frame);
