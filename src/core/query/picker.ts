
export interface PointBlock {
  firstId: number;
  count: number;
  coords: Int16Array;
  attrs: Uint8Array;
}

export interface PickResult {
  id: number;
  x: number;
  y: number;
  attrs: [number, number, number, number];
}

export function scanDrawn (
  ranges: Int32Array,
  blocks: readonly PointBlock[],
  visit: (id: number, localIndex: number, block: PointBlock) => void,
): void {
  let blockAt = 0;

  for (let r = 0; r + 1 < ranges.length; r += 2) {
    const from = ranges[r];
    const to = ranges[r + 1];
    if (to <= from) continue;

    while (blockAt < blocks.length && blocks[blockAt].firstId + blocks[blockAt].count <= from) {
      blockAt += 1;
    }

    for (let c = blockAt; c < blocks.length; c++) {
      const block = blocks[c];
      if (block.firstId >= to) break;
      const lo = Math.max(from, block.firstId) - block.firstId;
      const hi = Math.min(to, block.firstId + block.count) - block.firstId;
      for (let i = lo; i < hi; i++) visit(block.firstId + i, i, block);
    }
  }
}

export function pickNearest (
  blocks: readonly PointBlock[],
  quantum: number,
  targetX: number,
  targetY: number,
  radiusM: number,
  ranges: Int32Array,
): PickResult | null {
  const best = {
    id: -1,
    local: -1,
    block: null as PointBlock | null,
    distance: radiusM * radiusM,
  };

  scanDrawn(ranges, blocks, (id, i, block) => {
    const dx = block.coords[i * 4] * quantum - targetX;
    const dy = block.coords[i * 4 + 1] * quantum - targetY;
    const d2 = dx * dx + dy * dy;
    if (d2 < best.distance) {
      best.distance = d2;
      best.id = id;
      best.local = i;
      best.block = block;
    }
  });

  const block = best.block;
  if (block === null || best.local < 0) return null;

  return {
    id: best.id,
    x: block.coords[best.local * 4] * quantum,
    y: block.coords[best.local * 4 + 1] * quantum,
    attrs: [
      block.attrs[best.local * 8 + 4],
      block.attrs[best.local * 8 + 5],
      block.attrs[best.local * 8 + 6],
      block.attrs[best.local * 8 + 7],
    ],
  };
}

export interface BoxResult {
  count: number;
  ids: number[];
  points: Uint8Array;
  byStatus: [number, number, number];
}

export function selectInBox (
  blocks: readonly PointBlock[],
  quantum: number,
  loX: number,
  loY: number,
  hiX: number,
  hiY: number,
  ranges: Int32Array,
  idLimit: number,
): BoxResult {
  let count = 0;
  const ids: number[] = [];
  const points = new Uint8Array(idLimit * 8);
  const byStatus: [number, number, number] = [0, 0, 0];
  let filled = 0;

  scanDrawn(ranges, blocks, (id, i, block) => {
    const x = block.coords[i * 4] * quantum;
    const y = block.coords[i * 4 + 1] * quantum;
    if (x < loX || x > hiX || y < loY || y > hiY) return;
    count += 1;
    byStatus[block.attrs[i * 8 + 5]] += 1;
    if (ids.length < idLimit) {
      ids.push(id);
      points.set(block.attrs.subarray(i * 8, i * 8 + 8), filled * 8);
      filled += 1;
    }
  });

  return { count, ids, points: points.slice(0, filled * 8), byStatus };
}
