// Deterministic, serializable RNG (mulberry32). All randomness is server-side.
export interface RngState { seed: number; state: number }

export function newRng(seed: number): RngState {
  return { seed: seed >>> 0, state: seed >>> 0 };
}

export function rand(r: RngState): number {
  r.state = (r.state + 0x6d2b79f5) >>> 0;
  let t = r.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(r: RngState, min: number, max: number): number {
  return min + Math.floor(rand(r) * (max - min + 1));
}

export function pick<T>(r: RngState, list: T[]): T {
  if (list.length === 0) throw new Error("pick from empty list");
  return list[Math.floor(rand(r) * list.length)];
}

export function shuffle<T>(r: RngState, list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(r) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function weightedPick<T>(r: RngState, list: T[], weight: (x: T) => number): T {
  const total = list.reduce((s, x) => s + weight(x), 0);
  let roll = rand(r) * total;
  for (const x of list) {
    roll -= weight(x);
    if (roll <= 0) return x;
  }
  return list[list.length - 1];
}
