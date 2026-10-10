
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChunkedBuffer } from '../src/core/gl/buffer.ts';
import { IndexedChunkedBuffer } from '../src/core/gl/indexedBuffer.ts';

class FakeGL {
  ARRAY_BUFFER = 0x8892;
  ELEMENT_ARRAY_BUFFER = 0x8893;
  DYNAMIC_DRAW = 0x88e8;

  buffers = new Map();
  uploads = [];
  #next = 1;
  #bound = 0;

  createBuffer () {
    const id = this.#next++;
    this.buffers.set(id, new Uint8Array(0));
    return id;
  }

  bindBuffer (_target, buffer) {
    this.#bound = buffer;
  }

  bufferData (_target, size) {
    this.buffers.set(this.#bound, new Uint8Array(size));
  }

  bufferSubData (_target, offset, src) {
    const store = this.buffers.get(this.#bound);
    if (store === undefined) throw new Error('写到未分配的缓冲');
    store.set(src, offset);
    this.uploads.push({ buffer: this.#bound, offset, length: src.length });
  }

  deleteBuffer (buffer) {
    this.buffers.delete(buffer);
  }

  read (bufferId) {
    return this.buffers.get(bufferId);
  }
}

function payload (firstId, count) {
  const out = new Uint8Array(count * 6);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    view.setUint32(i * 6, firstId + i, true);
    view.setUint16(i * 6 + 4, 0xbeef, true);
  }
  return out;
}

function setup (chunkElements) {
  const gl = new FakeGL();
  const buffer = new ChunkedBuffer(/** @type {any} */ (gl), { stride: 6, chunkElements });
  return { gl, buffer };
}

test('落点：append 后 flush，显存内容与入队顺序逐字节一致', () => {
  const { gl, buffer } = setup(4);
  const a = payload(0, 5);
  const b = payload(5, 7);
  buffer.append(a);
  buffer.append(b);
  buffer.flush(1 << 20);

  const prefixes = buffer.drawnPrefixes();
  const per = [];
  buffer.drawEachChunk((_buf, count) => per.push(count));
  assert.deepEqual(per, Array.from(prefixes));
  assert.deepEqual(Array.from(prefixes), [4, 4, 4]);
  assert.equal(buffer.uploaded, 12);
  assert.equal(buffer.pendingBytes, 0);

  const expected = new Uint8Array(12 * 6);
  expected.set(a, 0);
  expected.set(b, a.length);

  const actual = new Uint8Array(12 * 6);
  const buffers = [];
  buffer.drawEachChunk((buf) => buffers.push(buf));
  for (let i = 0; i < buffers.length; i++) {
    actual.set(gl.read(buffers[i]).subarray(0, 4 * 6), i * 4 * 6);
  }
  assert.deepEqual(Array.from(actual), Array.from(expected));
});

test('落点：一次 append 跨多个块也能正确切开', () => {
  const { gl, buffer } = setup(3);
  const a = payload(0, 8); // 跨 3 块：3 + 3 + 2
  buffer.append(a);
  buffer.flush(1 << 20);

  assert.deepEqual(Array.from(buffer.drawnPrefixes()), [3, 3, 2]);

  const buffers = [];
  buffer.drawEachChunk((buf) => buffers.push(buf));
  const actual = new Uint8Array(8 * 6);
  const counts = [3, 3, 2];
  for (let i = 0; i < buffers.length; i++) {
    actual.set(gl.read(buffers[i]).subarray(0, counts[i] * 6), i * 3 * 6);
  }
  assert.deepEqual(Array.from(actual), Array.from(a));
});

test('额度：flush 按字节预算分批写，单次不超预算', () => {
  const { gl, buffer } = setup(100);
  buffer.append(payload(0, 50)); // 300 字节
  assert.equal(buffer.pendingBytes, 300);

  const once = buffer.flush(60); // 60 / 6 = 10 个要素
  assert.equal(once, 60);
  assert.equal(buffer.pendingBytes, 240);
  assert.equal(buffer.uploaded, 10);
  assert.equal(gl.uploads.at(-1)?.offset, 0, '一次 flush 内应当是单次连续写入');
  assert.equal(gl.uploads.at(-1)?.length, 60);

  const rest = buffer.flush(1 << 20);
  assert.equal(rest, 240);
  assert.equal(buffer.pendingBytes, 0);
  assert.equal(buffer.uploaded, 50);
  assert.equal(gl.uploads.at(-1)?.offset, 10 * 6, '续写应当从上次的位置之后开始');
  assert.equal(gl.uploads.at(-1)?.length, 240);
});

test('额度：不足一个要素时不写任何东西', () => {
  const { gl, buffer } = setup(100);
  buffer.append(payload(0, 10));
  const before = gl.uploads.length;
  assert.equal(buffer.flush(5), 0);
  assert.equal(gl.uploads.length, before);
  assert.equal(buffer.pendingBytes, 60);
});

test('车道：urgent 先于 bulk 排空', () => {
  const { gl, buffer } = setup(1000);
  buffer.append(payload(0, 20)); // bulk
  buffer.append(payload(20, 5), true); // urgent
  assert.equal(buffer.pendingBytes, 25 * 6);

  buffer.flush(5 * 6);
  assert.equal(buffer.uploaded, 5, 'urgent 应当先被排空');
  assert.equal(buffer.pendingBytes, 20 * 6, 'bulk 应当仍在排队');

  const offsets = gl.uploads.map((u) => u.offset);
  assert.deepEqual(offsets, [0], 'urgent 的 5 个要素应当落在自己那一块的开头');
});

test('定位：locate 能把 id 映射回正确的块与偏移', () => {
  const { gl, buffer } = setup(4);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(buffer.append(payload(i * 4, 4)).firstId);
  buffer.flush(1 << 20);

  for (const id of [0, 3, 4, 7, 8, 11]) {
    const loc = buffer.locate(id);
    assert.ok(loc, `id ${id} 应当能定位`);
    const chunk = Math.floor(id / 4);
    const element = id % 4;
    assert.equal(loc.element, element, `id ${id} 的块内偏移`);
    assert.equal(loc.buffer, buffer.locate(chunk * 4).buffer, `id ${id} 应当与同块要素共用一个 buffer`);
  }

  assert.equal(buffer.locate(12), null, '越界 id 应当定位失败');
  void gl;
});

test('定位：尚未上传的 id 返回 null，不许写到不存在的缓冲上', () => {
  const { buffer } = setup(4);
  buffer.append(payload(0, 4));
  assert.equal(buffer.locate(0), null);
  assert.throws(() => buffer.updateAttributes([0], 0, 2, new Uint8Array([1, 2])), /尚未上传/);
});

test('就地改写：盖住整个要素时才合并，只改一两个字节时不合并', () => {
  const { gl, buffer } = setup(4);
  buffer.append(payload(0, 10));
  buffer.flush(1 << 20);

  const ids = [0, 1, 2, 3, 4, 5, 6, 7, 9];

  const before = gl.uploads.length;
  const partial = buffer.updateAttributes(ids, 5, 1, new Uint8Array(ids.length));
  assert.equal(partial, ids.length, '不覆盖整个要素时每个 id 一次');
  assert.equal(gl.uploads.length - before, ids.length);

  const whole = buffer.updateAttributes(ids, 0, 6, new Uint8Array(ids.length * 6));
  assert.equal(whole, 3, '0-3 一块 / 4-7 一块 / 9 单独 —— 共三次');
});

test('就地改写：部分改写不会污染相邻要素', () => {
  const { gl, buffer } = setup(4);
  buffer.append(payload(0, 4));
  buffer.flush(1 << 20);

  const loc = buffer.locate(0);
  assert.ok(loc);
  const store = gl.read(loc.buffer);
  const coordOf = (i) => {
    const view = new DataView(store.buffer, store.byteOffset + i * 6, 4);
    return view.getUint32(0, true);
  };
  const coordsBefore = [0, 1, 2, 3].map(coordOf);

  buffer.updateAttributes([1], 4, 2, new Uint8Array([0xaa, 0xbb]));

  assert.deepEqual([0, 1, 2, 3].map(coordOf), coordsBefore, '坐标一个都不该被动');
  assert.equal(store[1 * 6 + 4], 0xaa);
  assert.equal(store[1 * 6 + 5], 0xbb);
  assert.equal(store[2 * 6 + 4], 0xef, 'id 2 的属性低字节不该被动');
  assert.equal(store[2 * 6 + 5], 0xbe, 'id 2 的属性高字节不该被动');
});

test('就地改写：值确实落在正确的字节上', () => {
  const { gl, buffer } = setup(4);
  buffer.append(payload(0, 6));
  buffer.flush(1 << 20);

  const buffers = [];
  buffer.drawEachChunk((buf) => buffers.push(buf));

  const loc1 = buffer.locate(1);
  const loc5 = buffer.locate(5);
  assert.ok(loc1 && loc5);

  buffer.updateAttributes([1, 5], 4, 2, new Uint8Array([0x11, 0x11, 0x22, 0x22]));

  assert.equal(gl.read(loc1.buffer)[1 * 6 + 4], 0x11, 'id 1 的低字节');
  assert.equal(gl.read(loc1.buffer)[1 * 6 + 5], 0x11, 'id 1 的高字节');
  assert.equal(gl.read(loc5.buffer)[1 * 6 + 4], 0x22, 'id 5 在第二块的开头');
  void buffers;
});

test('就地改写：updatePositions 只写坐标的 4 个字节', () => {
  const { gl, buffer } = setup(4);
  buffer.append(payload(0, 3));
  buffer.flush(1 << 20);

  const loc = buffer.locate(2);
  assert.ok(loc);
  const before = Array.from(gl.read(loc.buffer).subarray(2 * 6, 2 * 6 + 6));

  buffer.updatePositions([2], new Int16Array([-1234]), new Int16Array([5678]));

  const after = Array.from(gl.read(loc.buffer).subarray(2 * 6, 2 * 6 + 6));
  assert.notDeepEqual(after, before);
  assert.equal(after[4], before[4], '属性字节不该被动');
  assert.equal(after[5], before[5], '属性字节不该被动');

  const view = new DataView(gl.read(loc.buffer).buffer, 2 * 6, 6);
  assert.equal(view.getInt16(0, true), -1234);
  assert.equal(view.getInt16(2, true), 5678);
});

test('车道：id 是全局稠密的，跨车道也连续', () => {
  const { buffer } = setup(1000);
  const a = buffer.append(payload(0, 10));
  const b = buffer.append(payload(0, 3), true);
  const c = buffer.append(payload(0, 5));
  assert.deepEqual([a.firstId, a.count], [0, 10]);
  assert.deepEqual([b.firstId, b.count], [10, 3]);
  assert.deepEqual([c.firstId, c.count], [13, 5]);
});

test('回收：dispose 之后块被清空', () => {
  const { gl, buffer } = setup(4);
  buffer.append(payload(0, 10));
  buffer.flush(1 << 20);
  assert.equal(buffer.chunkCount, 3);
  buffer.dispose();
  assert.equal(buffer.chunkCount, 0);
  void gl;
});

test('已绘制区间：还没上传的要素不在区间里', () => {
  const { buffer } = setup(4);
  buffer.append(payload(0, 10)); // 三块：4 / 4 / 2
  buffer.flush(6 * 6); // 只传了 6 个

  assert.deepEqual(Array.from(buffer.drawnIdRanges()), [0, 6]);
});

test('已绘制区间：空缓冲给出空区间', () => {
  const { buffer } = setup(4);
  assert.deepEqual(Array.from(buffer.drawnIdRanges()), []);
  buffer.append(payload(0, 4));
  assert.deepEqual(Array.from(buffer.drawnIdRanges()), [], '还没上传就不该有区间');
});

test('已绘制区间：LOD 前缀会让区间按块断开', () => {
  const { buffer } = setup(4);
  buffer.append(payload(0, 10)); // 三块：ids 0-3 / 4-7 / 8-9
  buffer.flush(1 << 20);

  const ranges = buffer.drawnIdRanges(new Uint32Array([2, 2, 2]));
  assert.deepEqual(Array.from(ranges), [0, 2, 4, 6, 8, 10]);
});

test('已绘制区间：两条车道交错时，LOD 下标仍然对得上', () => {
  const { buffer } = setup(4);

  buffer.append(payload(0, 4)); // 批量块 0：ids 0-3
  buffer.append(payload(0, 4), true); // 实时块 0：ids 4-7
  buffer.append(payload(0, 4)); // 批量块 1：ids 8-11
  buffer.flush(1 << 20);

  assert.equal(buffer.chunkCount, 3);
  assert.deepEqual(Array.from(buffer.drawnPrefixes()), [4, 4, 4]);

  const ranges = buffer.drawnIdRanges(new Uint32Array([2, 4, 2]));
  assert.deepEqual(
    Array.from(ranges),
    [0, 2, 4, 6, 8, 12],
    '实时块（绘制顺序第 3）应当拿 lod[2]，而不是 lod[1]',
  );
});

test('已绘制区间：区间按 id 升序且相邻时合并', () => {
  const { buffer } = setup(4);
  buffer.append(payload(0, 12));
  buffer.flush(1 << 20);
  assert.deepEqual(Array.from(buffer.drawnIdRanges()), [0, 12]);
});

function setupIndexed (chunkVertices) {
  const gl = new FakeGL();
  const buffer = new IndexedChunkedBuffer(
    (gl),
    { vertexStride: 6, chunkVertices },
  );
  return { gl, buffer };
}

function indicesOf (gl, buffer, which) {
  const chunks = [];
  buffer.drawEachChunk((vb, ib, indexCount) => chunks.push({ vb, ib, indexCount }));
  const entry = chunks[which];
  const store = gl.read(entry.ib);
  const view = new DataView(store.buffer, store.byteOffset, store.byteLength);
  const out = [];
  for (let i = 0; i < entry.indexCount; i++) out.push(view.getUint16(i * 2, true));
  return out;
}

test('索引缓冲：同块内第二批的索引被整体重基', () => {
  const { gl, buffer } = setupIndexed(16);
  buffer.append(payload(0, 3), Uint16Array.from([0, 1, 2]));
  buffer.append(payload(3, 3), Uint16Array.from([0, 1, 2]));
  buffer.flush(1 << 20);

  assert.equal(buffer.chunkCount, 1, '两批应当落在同一块里');
  assert.deepEqual(indicesOf(gl, buffer, 0), [0, 1, 2, 3, 4, 5]);
  assert.equal(buffer.uploaded, 6);
});

test('索引缓冲：装不下就开新块，绝不把一批拆到两块', () => {
  const { gl, buffer } = setupIndexed(4);
  buffer.append(payload(0, 3), Uint16Array.from([0, 1, 2]));
  buffer.append(payload(3, 3), Uint16Array.from([0, 1, 2])); // 只剩 1 个位置，装不下
  buffer.flush(1 << 20);

  assert.equal(buffer.chunkCount, 2);
  assert.deepEqual(indicesOf(gl, buffer, 0), [0, 1, 2], '第一块不该被拆');
  assert.deepEqual(indicesOf(gl, buffer, 1), [0, 1, 2], '新块里的索引从 0 重新开始');
});

test('索引缓冲：顶点与索引没同时就位时，那批索引不算可绘制', () => {
  const { gl, buffer } = setupIndexed(16);
  buffer.append(payload(0, 3), Uint16Array.from([0, 1, 2]));

  buffer.flush(3 * 6);
  assert.equal(buffer.uploaded, 0, '索引未就位就不能画 —— 否则会引用没上传的顶点');

  buffer.flush(1 << 20);
  assert.equal(buffer.uploaded, 3);
  assert.deepEqual(indicesOf(gl, buffer, 0), [0, 1, 2]);
});

test('索引缓冲：索引数不是 3 的倍数必须拒绝', () => {
  const { buffer } = setupIndexed(16);
  assert.throws(
    () => buffer.append(payload(0, 3), Uint16Array.from([0, 1])),
    /不是 3 的整数倍/,
  );
});

test('索引缓冲：一批超过每块容量必须拒绝', () => {
  const { buffer } = setupIndexed(4);
  assert.throws(
    () => buffer.append(payload(0, 5), Uint16Array.from([0, 1, 2])),
    /超过每块容量/,
  );
});

test('索引缓冲：每块容量超过 u16 上限必须拒绝', () => {
  const gl = new FakeGL();
  assert.throws(
    () => new IndexedChunkedBuffer(/** @type {any} */ (gl), { vertexStride: 6, chunkVertices: 70000 }),
    /超过 u16 索引上限/,
  );
});

test('索引缓冲：索引指向本批之外的顶点必须拒绝', () => {
  const { buffer } = setupIndexed(16);
  assert.throws(
    () => buffer.append(payload(0, 3), Uint16Array.from([0, 1, 3])),
    /超出这一批的顶点数/,
  );
});

test('索引缓冲：容量顶到 u16 上限时最大索引仍正确', () => {
  const { gl, buffer } = setupIndexed(65535);
  buffer.append(payload(0, 65535), Uint16Array.from([0, 65534, 1]));
  buffer.flush(1 << 20);
  assert.equal(buffer.chunkCount, 1);
  assert.deepEqual(indicesOf(gl, buffer, 0), [0, 65534, 1], '65534 是能表示的最大顶点序号');
  assert.equal(buffer.uploaded, 3);
});

test('索引缓冲：一块装满后，下一批开新块', () => {
  const { gl, buffer } = setupIndexed(4);
  buffer.append(payload(0, 4), Uint16Array.from([0, 1, 2]));
  buffer.append(payload(4, 4), Uint16Array.from([0, 1, 2]));
  buffer.flush(1 << 20);

  assert.equal(buffer.chunkCount, 2);
  assert.deepEqual(indicesOf(gl, buffer, 0), [0, 1, 2]);
  assert.deepEqual(indicesOf(gl, buffer, 1), [0, 1, 2]);
});

test('索引缓冲：一批没有索引时什么都不用画', () => {
  const { gl, buffer } = setupIndexed(16);
  buffer.append(payload(0, 3), Uint16Array.from([]));
  buffer.flush(1 << 20);

  const chunks = [];
  buffer.drawEachChunk((vb, ib, indexCount) => chunks.push({ vb, ib, indexCount }));
  assert.equal(chunks.length, 0, '没有索引的块不该产生绘制调用');
  assert.equal(buffer.uploaded, 0);
  void gl;
});
