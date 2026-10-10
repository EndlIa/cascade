
interface Slot {
  buffer: WebGLBuffer | null;
  count: number;
}

interface Placement {
  slot: number;
  element: number;
  count: number;
}

interface Pending {
  bytes: Uint8Array;
  placements: Placement[];
  consumed: number;
  at: number;
  inPlace: number;
}

interface Run {
  firstId: number;
  lane: number;
  slot: number;
  element: number;
  length: number;
}

export interface AppendResult {
  firstId: number;
  count: number;
}

export interface ChunkedBufferOptions {
  stride: number;
  chunkElements: number;
}

const BULK = 0;
const URGENT = 1;
const DRAIN_ORDER = [URGENT, BULK] as const;
const DRAW_ORDER = [BULK, URGENT] as const;

export interface Location {
  buffer: WebGLBuffer;
  lane: number;
  slot: number;
  element: number;
}

export class ChunkedBuffer {
  readonly stride: number;
  readonly chunkElements: number;

  private readonly gl: WebGLRenderingContext;
  private readonly target: number;

  private readonly slots: Slot[][] = [[], []];
  private readonly queue: Pending[][] = [[], []];
  private readonly cursor: Array<{ slot: number; element: number }> = [
    { slot: 0, element: 0 },
    { slot: 0, element: 0 },
  ];
  private readonly queuedBytes: number[] = [0, 0];

  private runs: Run[] = [];
  private nextId = 0;
  private uploadedElements = 0;

  private scratch: Uint8Array = new Uint8Array(0);

  constructor (gl: WebGLRenderingContext, opts: ChunkedBufferOptions) {
    this.gl = gl;
    this.target = gl.ARRAY_BUFFER;
    this.stride = opts.stride;
    this.chunkElements = opts.chunkElements;
  }

  get uploaded (): number {
    return this.uploadedElements;
  }

  get uploadedBytes (): number {
    return this.uploadedElements * this.stride;
  }

  get pendingBytes (): number {
    return this.queuedBytes[BULK] + this.queuedBytes[URGENT];
  }

  get chunkCount (): number {
    return this.slots[BULK].length + this.slots[URGENT].length;
  }

  get capacity (): number {
    return this.chunkCount * this.chunkElements;
  }

  get runCount (): number {
    return this.runs.length;
  }

  append (bytes: Uint8Array, urgent = false): AppendResult {
    if (bytes.length % this.stride !== 0) {
      throw new Error(`append: ${bytes.length} 字节不是 ${this.stride} 的整数倍`);
    }
    const lane = urgent ? URGENT : BULK;
    const count = bytes.length / this.stride;
    const firstId = this.nextId;

    if (count > 0) {
      const placements = this.plan(lane, firstId, count);
      this.nextId += count;
      this.queue[lane].push({ bytes, placements, consumed: 0, at: 0, inPlace: 0 });
      this.queuedBytes[lane] += bytes.length;
    }
    return { firstId, count };
  }

  flush (byteBudget: number): number {
    let written = 0;
    for (const lane of DRAIN_ORDER) {
      written += this.flushLane(lane, byteBudget - written);
      if (written >= byteBudget) break;
    }
    return written;
  }

  drawEachChunk (fn: (buffer: WebGLBuffer, count: number) => void): void {
    for (const lane of DRAW_ORDER) {
      for (const slot of this.slots[lane]) {
        if (slot.buffer !== null && slot.count > 0) fn(slot.buffer, slot.count);
      }
    }
  }

  drawnPrefixes (): Uint32Array {
    const out = new Uint32Array(this.chunkCount);
    let i = 0;
    for (const lane of DRAW_ORDER) {
      for (const slot of this.slots[lane]) out[i++] = slot.count;
    }
    return out;
  }

  locate (id: number): Location | null {
    const run = this.runOf(id);
    if (run === null) return null;
    const slot = this.slots[run.lane][run.slot];
    if (slot === undefined || slot.buffer === null) return null;
    return {
      buffer: slot.buffer,
      lane: run.lane,
      slot: run.slot,
      element: run.element + (id - run.firstId),
    };
  }

  updateAttributes (
    ids: readonly number[],
    byteOffset: number,
    bytesPerElement: number,
    values: Uint8Array,
  ): number {
    const contiguousAcrossElements = byteOffset === 0 && bytesPerElement === this.stride;
    let calls = 0;
    let i = 0;

    while (i < ids.length) {
      const id = ids[i];
      const run = this.runOf(id);
      if (run === null) {
        i += 1;
        continue;
      }
      const slot = this.slots[run.lane][run.slot];
      if (slot.buffer === null) {
        throw new Error(`updateAttributes: id ${id} 所在块尚未上传`);
      }

      const offsetInRun = id - run.firstId;
      let n = 1;
      if (contiguousAcrossElements) {
        while (
          i + n < ids.length &&
          ids[i + n] === id + n &&
          offsetInRun + n < run.length
        ) {
          n += 1;
        }
      }

      const element = run.element + offsetInRun;
      this.gl.bindBuffer(this.target, slot.buffer);
      this.gl.bufferSubData(
        this.target,
        element * this.stride + byteOffset,
        values.subarray(i * bytesPerElement, (i + n) * bytesPerElement),
      );
      calls += 1;
      i += n;
    }
    return calls;
  }

  updatePositions (ids: readonly number[], qx: Int16Array, qy: Int16Array): number {
    const need = ids.length;
    if (qx.length < need || qy.length < need) {
      throw new Error('updatePositions: 坐标数组比 id 数组短');
    }
    if (this.scratch.length < need * 4) this.scratch = new Uint8Array(need * 4);

    const view = new DataView(this.scratch.buffer, 0, need * 4);
    for (let i = 0; i < need; i++) {
      view.setInt16(i * 4, qx[i], true);
      view.setInt16(i * 4 + 2, qy[i], true);
    }
    return this.updateAttributes(ids, 0, 4, this.scratch.subarray(0, need * 4));
  }

  drawnIdRanges (lod?: Uint32Array): Int32Array {
    const bulkSlots = this.slots[BULK].length;
    const out: number[] = [];
    let start = -1;
    let end = -1;

    for (const run of this.runs) {
      const drawIndex = (run.lane === BULK ? 0 : bulkSlots) + run.slot;
      const slot = this.slots[run.lane][run.slot];
      const limit = lod === undefined ? slot.count : Math.min(slot.count, lod[drawIndex] ?? 0);
      const drawn = Math.min(run.length, limit - run.element);
      if (drawn <= 0) continue;

      const a = run.firstId;
      const b = a + drawn;
      if (start < 0) {
        start = a;
        end = b;
      } else if (a <= end) {
        end = Math.max(end, b);
      } else {
        out.push(start, end);
        start = a;
        end = b;
      }
    }
    if (start >= 0) out.push(start, end);
    return Int32Array.from(out);
  }

  dispose (): void {
    for (const lane of this.slots) {
      for (const slot of lane) {
        if (slot.buffer !== null) this.gl.deleteBuffer(slot.buffer);
        slot.buffer = null;
      }
      lane.length = 0;
    }
    for (const lane of this.queue) lane.length = 0;
    this.runs.length = 0;
  }

  private plan (lane: number, firstId: number, count: number): Placement[] {
    const cur = this.cursor[lane];
    const placements: Placement[] = [];
    let left = count;
    let id = firstId;

    while (left > 0) {
      while (this.slots[lane].length <= cur.slot) {
        this.slots[lane].push({ buffer: null, count: 0 });
      }
      const take = Math.min(this.chunkElements - cur.element, left);
      placements.push({ slot: cur.slot, element: cur.element, count: take });
      this.runs.push({ firstId: id, lane, slot: cur.slot, element: cur.element, length: take });

      id += take;
      left -= take;
      cur.element += take;
      if (cur.element >= this.chunkElements) {
        cur.slot += 1;
        cur.element = 0;
      }
    }
    return placements;
  }

  private flushLane (lane: number, byteBudget: number): number {
    const queue = this.queue[lane];
    let written = 0;

    while (queue.length > 0) {
      const budgetLeft = Math.floor((byteBudget - written) / this.stride);
      if (budgetLeft <= 0) break;

      const item = queue[0];
      const totalElements = item.bytes.length / this.stride;
      let left = budgetLeft;

      while (left > 0 && item.at < item.placements.length) {
        const place = item.placements[item.at];
        const take = Math.min(left, place.count - item.inPlace);
        if (take <= 0) {
          item.at += 1;
          item.inPlace = 0;
          continue;
        }

        const slot = this.slots[lane][place.slot];
        if (slot.buffer === null) {
          const buffer = this.gl.createBuffer();
          if (buffer === null) throw new Error('createBuffer 返回 null');
          this.gl.bindBuffer(this.target, buffer);
          this.gl.bufferData(this.target, this.chunkElements * this.stride, this.gl.DYNAMIC_DRAW);
          slot.buffer = buffer;
        }

        const element = place.element + item.inPlace;
        const sourceAt = item.consumed * this.stride;
        this.gl.bindBuffer(this.target, slot.buffer);
        this.gl.bufferSubData(
          this.target,
          element * this.stride,
          item.bytes.subarray(sourceAt, sourceAt + take * this.stride),
        );

        slot.count = Math.max(slot.count, element + take);
        item.consumed += take;
        item.inPlace += take;
        left -= take;
        written += take * this.stride;
        this.queuedBytes[lane] -= take * this.stride;
        this.uploadedElements += take;

        if (item.inPlace >= place.count) {
          item.at += 1;
          item.inPlace = 0;
        }
      }

      if (item.consumed >= totalElements) queue.shift();
      else break;
    }

    return written;
  }

  private runOf (id: number): Run | null {
    let lo = 0;
    let hi = this.runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const run = this.runs[mid];
      if (id < run.firstId) hi = mid - 1;
      else if (id >= run.firstId + run.length) lo = mid + 1;
      else return run;
    }
    return null;
  }
}
