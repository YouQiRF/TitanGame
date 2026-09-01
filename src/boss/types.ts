/**
 * Boss 共用型別。獨立成檔案，避免 guardian.ts / puppeteer.ts 互相依賴。
 */

import type { PartId } from './parts.ts';
import type { Vec } from '../core/vec.ts';

export interface HitResult {
  /** 對本體 HP 造成的傷害 */
  damage: number;
  /**
   *  core  = 暴露的核心（最高傷害）；傀儡師的本體命中也回報這個 kind——
   *          兩者在敘事上都是「正確、高回饋的目標」，沿用同一套金色特效與回饋
   *  wound = 已破壞部位留下的裸露傷口（高傷害，永久弱點，只有石之守衛會用到）
   *  part  = 尚未破壞的裝甲部位（低傷害，但累積破壞值，只有石之守衛會用到）
   *  body  = 石殼本體（幾乎無效，只有石之守衛會用到）
   */
  kind: 'core' | 'wound' | 'part' | 'body';
  partId?: PartId;
  partLabel?: string;
  /** 這一擊是否正好打破了部位 */
  broke: boolean;
  point: Vec;
  /** 這一擊是否觸發了傀儡師的終局處決（只有 Puppeteer 會用到，Guardian 不必處理） */
  executed?: boolean;
}
