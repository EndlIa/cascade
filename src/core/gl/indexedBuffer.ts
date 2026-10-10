
interface Slot {
  vb: WebGLBuffer | null;
  ib: WebGLBuffer | null;
  vertexBytes: number;
  indexBytes: number;
  safeIndices: number;
}

interface Pending {
  vertices: Uint8Array;
  indices: Uint8Array;
  slot: number;
  vertexOffset: number;
  vertexConsumed: number;
  indexConsumed: number;
}

export interface IndexedChunkedBufferOptions {
  vertexStride: number;
  chunkVertices: number;
}

export class IndexedChunkedBuffer {
  readonly vertexStride: number;
  readonly chunkVertices: number;

  private readonly gl: WebGLRenderingContext;
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];

  private cursorSlot = 0;
  private cursorVertex = 0;
  private queuedBytes = 0;
  private uploadedIndices = 0;

  constructor (gl: WebGLRenderingContext, opts: IndexedChunkedBufferOptions) {
    if (opts.chunkVertices > 0xffff) {
      throw new Error(`每块顶点容量 ${opts.chunkVertices} 超过 u16 索引上限 65535`);
    }
    this.gl = gl;
    this.vertexStride = opts.vertexStride;
    this.chunkVertices = opts.chunkVertices;
  }

  get pendingBytes (): number {
    return this.queuedBytes;
  }

  get uploaded (): number {
    return this.uploadedIndices;
  }

  get uploadedBytes (): number {
    let total = 0;
    for (const slot of this.slots) total += slot.vertexBytes + slot.indexBytes;
    return total;
  }

  get chunkCount (): number {
    return this.slots.length;
  }

  append (vertices: Uint8Array, indices: Uint16Array): void {
    const vertexCount = vertices.byteLength / this.vertexStride;
    if (!Number.isInteger(vertexCount)) {
      throw new Error(`顶点字节数 ${vertices.byteLength} 不是 ${this.vertexStride} 的整数倍`);
    }
    if (vertexCount === 0) return;
    if (vertexCount > this.chunkVertices) {
      throw new Error(`一批 ${vertexCount} 个顶点超过每块容量 ${this.chunkVertices}`);
    }
    if (indices.length % 3 !== 0) {
      throw new Error(`索引数 ${indices.length} 不是 3 的整数倍`);
    }

    if (this.cursorVertex + vertexCount > this.chunkVertices) {
      this.cursorSlot += 1;
      this.cursorVertex = 0;
    }
    while (this.slots.length <= this.cursorSlot) {
      this.slots.push({ vb: null, ib: null, vertexBytes: 0, indexBytes: 0, safeIndices: 0 });
    }

    const slot = this.cursorSlot;
    const vertexOffset = this.cursorVertex;
    this.cursorVertex += vertexCount;

    const rebased = new Uint8Array(indices.length * 2);
    const view = new DataView(rebased.buffer);
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] >= vertexCount) {
        throw new Error(`索引 ${indices[i]} 超出这一批的顶点数 ${vertexCount}`);
      }
      view.setUint16(i * 2, indices[i] + vertexOffset, true);
    }

    this.queue.push({
      vertices,
      indices: rebased,
      slot,
      vertexOffset,
      vertexConsumed: 0,
      indexConsumed: 0,
    });
    this.queuedBytes += vertices.byteLength + rebased.byteLength;
  }

  flush (byteBudget: number): number {
    let written = 0;

    while (this.queue.length > 0) {
      const item = this.queue[0];
      const slot = this.slots[item.slot];
      this.ensureAllocated(slot);

      written += this.writeVertices(item, slot, byteBudget - written);
      written += this.writeIndices(item, slot, byteBudget - written);

      if (item.vertexConsumed < item.vertices.byteLength ||
          item.indexConsumed < item.indices.byteLength) {
        break;
      }

      slot.safeIndices += item.indices.byteLength / 2;
      this.uploadedIndices += item.indices.byteLength / 2;
      this.queue.shift();
    }

    return written;
  }

  drawEachChunk (fn: (vertexBuffer: WebGLBuffer, indexBuffer: WebGLBuffer, indexCount: number) => void): void {
    for (const slot of this.slots) {
      if (slot.vb === null || slot.ib === null || slot.safeIndices <= 0) continue;
      fn(slot.vb, slot.ib, slot.safeIndices);
    }
  }

  dispose (): void {
    for (const slot of this.slots) {
      if (slot.vb !== null) this.gl.deleteBuffer(slot.vb);
      if (slot.ib !== null) this.gl.deleteBuffer(slot.ib);
      slot.vb = null;
      slot.ib = null;
    }
    this.slots.length = 0;
    this.queue.length = 0;
  }

  private ensureAllocated (slot: Slot): void {
    const gl = this.gl;
    if (slot.vb === null) {
      const vb = gl.createBuffer();
      if (vb === null) throw new Error('createBuffer 返回 null');
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, this.chunkVertices * this.vertexStride, gl.DYNAMIC_DRAW);
      slot.vb = vb;
    }
    if (slot.ib === null) {
      const ib = gl.createBuffer();
      if (ib === null) throw new Error('createBuffer 返回 null');
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.chunkVertices * 2 * 2, gl.DYNAMIC_DRAW);
      slot.ib = ib;
    }
  }

  private writeVertices (item: Pending, slot: Slot, budget: number): number {
    const left = item.vertices.byteLength - item.vertexConsumed;
    const take = Math.floor(Math.min(left, budget) / this.vertexStride) * this.vertexStride;
    if (take <= 0) return 0;

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, slot.vb);
    this.gl.bufferSubData(
      this.gl.ARRAY_BUFFER,
      item.vertexOffset * this.vertexStride + item.vertexConsumed,
      item.vertices.subarray(item.vertexConsumed, item.vertexConsumed + take),
    );
    item.vertexConsumed += take;
    slot.vertexBytes += take;
    this.queuedBytes -= take;
    return take;
  }

  private writeIndices (item: Pending, slot: Slot, budget: number): number {
    const left = item.indices.byteLength - item.indexConsumed;
    const take = Math.floor(Math.min(left, budget) / 2) * 2;
    if (take <= 0) return 0;

    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, slot.ib);
    this.gl.bufferSubData(
      this.gl.ELEMENT_ARRAY_BUFFER,
      slot.indexBytes + item.indexConsumed,
      item.indices.subarray(item.indexConsumed, item.indexConsumed + take),
    );
    item.indexConsumed += take;
    slot.indexBytes += take;
    this.queuedBytes -= take;
    return take;
  }
}
