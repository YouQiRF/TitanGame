/**
 * 向量與數學工具。
 * 全遊戲統一使用 { x, y } 純物件當作向量，函式一律回傳新物件（不就地修改），
 * 避免別名造成的難查 bug。
 */

export interface Vec {
  x: number;
  y: number;
}

export function v(x = 0, y = 0): Vec {
  return { x, y };
}

export function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec, s: number): Vec {
  return { x: a.x * s, y: a.y * s };
}

export function len(a: Vec): number {
  return Math.hypot(a.x, a.y);
}

/** 正規化；零向量回傳零向量（呼叫端需自行判斷是否有方向） */
export function norm(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 反向插值並夾在 0..1，用來把「距離」映射成「威力比例」 */
export function invLerp(a: number, b: number, x: number): number {
  if (Math.abs(b - a) < 1e-9) return 0;
  return clamp((x - a) / (b - a), 0, 1);
}

/** 幀率無關的指數趨近，t 越大追得越快 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** 點到線段的最短距離 —— 斬擊軌跡的命中判定核心 */
export function distPointSeg(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeOutQuint(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}

export function easeInQuad(t: number): number {
  return t * t;
}
