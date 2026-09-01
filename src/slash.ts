/**
 * 斬擊解算 —— 本作的核心機制。
 *
 * 「距離越遠 → 傷害越高 → 體力消耗越高」。
 * 這裡是唯一的計算來源：HUD 的預覽與實際執行都呼叫 planSlash()，
 * 保證玩家看到的傷害/耗力數字，就是放手後真正發生的事。
 */

import { T } from './tuning.ts';
import { clamp, invLerp, len, lerp, norm, type Vec } from './core/vec.ts';

export interface SlashPlan {
  /** 體力是否足夠揮出最小的一斬 */
  valid: boolean;
  /**
   * 游標落在角色身上的取消區內 → 放手不會出刀、不耗體力。
   * 這是給玩家的「反悔」機制：蓄力到一半發現時機不對，把游標拉回自己身上即可。
   */
  cancel: boolean;
  /** 斬擊方向（單位向量）；沒有有效方向時為零向量 */
  dir: Vec;
  /** 實際位移距離（已套用上下限與體力裁切） */
  dist: number;
  damage: number;
  cost: number;
  /** 威力比例 0..1，供 UI 上色 */
  power: number;
  /** 是否因體力不足而被裁短（玩家想斬更遠但撐不住） */
  capped: boolean;
}

/** 指定距離所需的體力 */
function costAtDist(d: number): number {
  return lerp(T.slash.minCost, T.slash.maxCost, invLerp(T.slash.minDist, T.slash.maxDist, d));
}

/**
 * @param stamina    目前體力
 * @param aimVec     瞄準向量（由呼叫端依 aimMode 算好：
 *                   cursor 模式 = 游標 - 角色；drag 模式 = 目前游標 - 按下點）
 * @param cursorDist 游標到角色的實際距離，用於取消區判定。
 *                   必須獨立傳入——drag 模式下 aimVec 是拖曳量，長度不代表游標離角色多遠。
 */
export function planSlash(stamina: number, aimVec: Vec, cursorDist: number): SlashPlan {
  const dir = norm(aimVec);
  const rawLen = len(aimVec);

  const invalid: SlashPlan = {
    valid: false,
    cancel: false,
    dir,
    dist: 0,
    damage: 0,
    cost: 0,
    power: 0,
    capped: false,
  };

  // 取消區優先於一切判定：游標拉回自己身上就是「我不打了」
  if (cursorDist < T.slash.cancelRadius) return { ...invalid, cancel: true };

  // 沒有方向 → 無法決定斬向
  if (dir.x === 0 && dir.y === 0) return invalid;
  // 連最小的一斬都揮不動
  if (stamina < T.slash.minCost) return { ...invalid, capped: true };

  const want = clamp(rawLen, T.slash.minDist, T.slash.maxDist);

  let dist = want;
  let capped = false;
  if (costAtDist(want) > stamina) {
    // 反解目前體力所能負擔的最遠距離
    const t = invLerp(T.slash.minCost, T.slash.maxCost, stamina);
    dist = clamp(lerp(T.slash.minDist, T.slash.maxDist, t), T.slash.minDist, want);
    capped = true;
  }

  const power = invLerp(T.slash.minDist, T.slash.maxDist, dist);

  return {
    valid: true,
    cancel: false,
    dir,
    dist,
    damage: lerp(T.slash.minDmg, T.slash.maxDmg, power),
    cost: costAtDist(dist),
    power,
    capped,
  };
}
