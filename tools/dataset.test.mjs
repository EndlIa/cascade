
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { CHUNK_HEADER_BYTES, GEOM, parseManifest, readChunkHeader } from '../src/core/format.ts';
import { llToMc } from '../src/core/geo.ts';
import { ChunkFramer } from '../src/core/stream/framer.ts';

const run = promisify(execFile);

function frameInPieces (bytes, pieceSize) {
  const framer = new ChunkFramer(16);
  const out = [];
  for (let at = 0; at < bytes.length; at += pieceSize) {
    framer.push(bytes.subarray(at, Math.min(at + pieceSize, bytes.length)));
    out.push(...framer.take());
  }
  framer.finish();
  return out;
}

function walkPayload (payload, geom, count) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let at = 0;

  if (geom === GEOM.POINTS) {
    at = count * 8;
  } else if (geom === GEOM.INSTANCES) {
    at = count * 8;
  } else if (geom === GEOM.LINES) {
    for (let i = 0; i < count; i++) {
      const n = dv.getUint16(at, true);
      if (n < 2) return { ok: false, why: `线要素 ${i} 的顶点数 ${n} < 2` };
      at += 4 + n * 4;
    }
  } else if (geom === GEOM.POLYGONS) {
    for (let i = 0; i < count; i++) {
      const rings = dv.getUint16(at, true);
      at += 4;
      if (rings < 1) return { ok: false, why: `面要素 ${i} 的环数 ${rings} < 1` };
      for (let r = 0; r < rings; r++) {
        const n = dv.getUint32(at, true);
        at += 4;
        if (n < 3) return { ok: false, why: `面要素 ${i} 第 ${r} 环顶点数 ${n} < 3` };
        at += n * 4;
      }
    }
  } else {
    return { ok: false, why: `未知几何类型 ${geom}` };
  }

  return at === payload.length
    ? { ok: true, features: count }
    : { ok: false, why: `载荷长度不符：走到 ${at}，声明 ${payload.length}` };
}

function readChunks (bytes) {
  const framer = new ChunkFramer(16);
  framer.push(bytes);
  const chunks = framer.take();
  framer.finish();
  return chunks;
}

async function makeDataset (out, extra = []) {
  await run('node', [
    'tools/make-dataset.mjs',
    '--out', out,
    '--points', '3000',
    '--lines', '40',
    '--polygons', '12',
    '--instances', '30',
    ...extra,
  ]);
  return parseManifest(JSON.parse(await readFile(join(out, 'dataset.json'), 'utf8')));
}

test('投影：与 JSAPI 参考值一致，且逐位可复现', () => {
  const [x, y] = llToMc(116.404, 39.915);
  assert.ok(Math.abs(x - 12958175.0) < 0.01, `x = ${x}`);
  assert.ok(Math.abs(y - 4825923.77) < 0.01, `y = ${y}`);

  assert.equal(llToMc(116.404, 39.915)[0], x);
  assert.equal(llToMc(116.506, 39.795)[0], llToMc(116.506, 39.795)[0]);
});

test('投影：南北、东西半球镜像严格相等', () => {
  const [x, y] = llToMc(116.404, 39.915);
  const [xn, yn] = llToMc(-116.404, -39.915);
  assert.equal(xn, -x);
  assert.equal(yn, -y);
});

test('投影：纬度分段边界取严格大于（|lat| === 15 落到第 6 行）', () => {
  const at15 = llToMc(116.4, 15);
  const justUnder = llToMc(116.4, 14.999999);
  const justOver = llToMc(116.4, 15.000001);
  assert.notEqual(at15[1], justOver[1]);
  assert.ok(Math.abs(at15[1] - justUnder[1]) < 1, `at15=${at15[1]} under=${justUnder[1]}`);
});

test('分块：取出的块与字节流怎么切分无关', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cascade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manifest = await makeDataset(dir);

  for (const key of ['points', 'lines', 'polygons', 'instances']) {
    const entry = manifest.geometries[key];
    assert.ok(entry, `manifest 缺少 ${key}`);

    const bytes = new Uint8Array(await readFile(join(dir, entry.file)));
    const reference = readChunks(bytes);
    assert.ok(reference.length > 0, `${key}: 一块都没读到`);

    for (const piece of [1, 2, 3, 7, 13, 64, 997, bytes.length - 1]) {
      if (piece < 1) continue;
      const framed = frameInPieces(bytes, piece);
      assert.equal(framed.length, reference.length, `${key} @piece=${piece}: 块数不同`);
      for (let i = 0; i < framed.length; i++) {
        assert.deepEqual(
          Array.from(framed[i]),
          Array.from(reference[i]),
          `${key} @piece=${piece}: 第 ${i} 块内容不同`,
        );
      }
    }
  }
});

test('分块：每块的载荷长度与声明的要素数严格自洽', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cascade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manifest = await makeDataset(dir);

  for (const key of ['points', 'lines', 'polygons', 'instances']) {
    const entry = manifest.geometries[key];
    if (!entry) continue;

    const bytes = new Uint8Array(await readFile(join(dir, entry.file)));
    const chunks = readChunks(bytes);

    let counted = 0;
    for (const chunk of chunks) {
      const header = readChunkHeader(
        new DataView(chunk.buffer, chunk.byteOffset, CHUNK_HEADER_BYTES),
      );
      const payload = chunk.subarray(CHUNK_HEADER_BYTES);
      assert.equal(payload.length, header.byteLen, `${key}: 载荷长度与块头不符`);

      const walked = walkPayload(payload, header.geom, header.count);
      assert.ok(walked.ok, `${key}: ${walked.why}`);
      counted += header.count;
    }

    assert.equal(counted, entry.count, `${key}: 累计要素数与 manifest 不符`);
  }
});

test('分块：截断的流必须报错，而不是静默丢尾巴', () => {
  const framer = new ChunkFramer(16);
  framer.push(new Uint8Array([GEOM.POINTS, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 1, 2, 3]));
  assert.equal(framer.take().length, 0, '块还没凑齐，不应该交出来');
  assert.throws(() => framer.finish(), /截断/);
});

test('分块：块头保留字段非零必须拒绝', () => {
  const bad = new Uint8Array(CHUNK_HEADER_BYTES);
  bad[1] = 1; // flags
  const framer = new ChunkFramer(16);
  framer.push(bad);
  assert.throws(() => framer.take(), /保留字段非零/);
});

test('分块：荒谬的载荷长度必须拒绝，而不是无限等下去', () => {
  const bad = new Uint8Array(CHUNK_HEADER_BYTES);
  const dv = new DataView(bad.buffer);
  dv.setUint32(8, 0xffffffff, true);
  const framer = new ChunkFramer(16);
  framer.push(bad);
  assert.throws(() => framer.take(), /超过上限/);
});

test('确定性：同参数两次运行字节完全一致', async (t) => {
  const a = await mkdtemp(join(tmpdir(), 'cascade-a-'));
  const b = await mkdtemp(join(tmpdir(), 'cascade-b-'));
  t.after(() => Promise.all([
    rm(a, { recursive: true, force: true }),
    rm(b, { recursive: true, force: true }),
  ]));

  const [ma, mb] = await Promise.all([makeDataset(a), makeDataset(b)]);
  assert.equal(ma.quantum, mb.quantum);

  for (const key of ['points', 'lines', 'polygons', 'instances']) {
    const ea = ma.geometries[key];
    const eb = mb.geometries[key];
    assert.ok(ea && eb);
    const [ba, bb] = await Promise.all([
      readFile(join(a, ea.file)),
      readFile(join(b, eb.file)),
    ]);
    assert.ok(ba.equals(bb), `${key}: 两次运行字节不同`);
  }
});

test('确定性：改点数不影响其余几何的字节', async (t) => {
  const a = await mkdtemp(join(tmpdir(), 'cascade-c-'));
  const b = await mkdtemp(join(tmpdir(), 'cascade-d-'));
  t.after(() => Promise.all([
    rm(a, { recursive: true, force: true }),
    rm(b, { recursive: true, force: true }),
  ]));

  await makeDataset(a, ['--points', '1000']);
  await makeDataset(b, ['--points', '8000']);

  for (const key of ['lines', 'polygons']) {
    const [ba, bb] = await Promise.all([
      readFile(join(a, `${key}.bin`)),
      readFile(join(b, `${key}.bin`)),
    ]);
    assert.ok(ba.equals(bb), `${key}: 改点数后字节变了`);
  }
});
