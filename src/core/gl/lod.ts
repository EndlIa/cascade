
export function lodCounts (perChunk: Uint32Array, target: number): Uint32Array {
  if (!Number.isFinite(target) || target <= 0) return perChunk.slice();

  let total = 0;
  for (let i = 0; i < perChunk.length; i++) total += perChunk[i];
  if (total <= target) return perChunk.slice();

  const ratio = target / total;
  const out = new Uint32Array(perChunk.length);
  for (let i = 0; i < perChunk.length; i++) {
    out[i] = Math.max(1, Math.min(perChunk[i], Math.round(perChunk[i] * ratio)));
  }
  return out;
}

export const LOD_TARGET = {
  POINT: 15000,
  ICON: 2500,
  STROKE: 120000,
} as const;
