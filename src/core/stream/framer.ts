import { CHUNK_HEADER_BYTES, readChunkHeader } from '../format.ts';

const INITIAL_CAPACITY = 1 << 20;

export class ChunkFramer {
  private buf: Uint8Array;
  private len = 0;
  private closed = false;

  constructor (initialCapacity = INITIAL_CAPACITY) {
    this.buf = new Uint8Array(initialCapacity);
  }

  get pendingBytes (): number {
    return this.len;
  }

  push (src: Uint8Array): void {
    if (this.closed) throw new Error('framer: 已经结束，不能再 push');

    const need = this.len + src.length;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const grown = new Uint8Array(cap);
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(src, this.len);
    this.len = need;
  }

  take (): Uint8Array[] {
    const out: Uint8Array[] = [];
    let pos = 0;

    while (this.len - pos >= CHUNK_HEADER_BYTES) {
      const header = new DataView(this.buf.buffer, this.buf.byteOffset + pos, CHUNK_HEADER_BYTES);
      const total = CHUNK_HEADER_BYTES + readChunkHeader(header).byteLen;
      if (this.len - pos < total) break;

      out.push(this.buf.slice(pos, pos + total));
      pos += total;
    }

    if (pos > 0) {
      this.buf.copyWithin(0, pos, this.len);
      this.len -= pos;
    }
    return out;
  }

  finish (): void {
    this.closed = true;
    if (this.len !== 0) {
      throw new Error(`数据流在块中间截断：还剩 ${this.len} 字节`);
    }
  }
}
