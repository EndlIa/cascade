
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GEOM } from '../src/core/format.ts';
import { decodeChunk } from '../src/core/gl/decode.ts';
import { POINT_STRIDE, SEGMENT_STRIDE } from '../src/core/gl/layout.ts';

function linesPayload (lines, attrs) {
  let size = 0;
  for (const pts of lines) size += 4 + pts.length * 4;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  lines.forEach((pts, i) => {
    view.setUint16(at, pts.length, true);
    view.setUint8(at + 2, attrs[i][0]);
    view.setUint8(at + 3, attrs[i][1]);
    at += 4;
    for (const [x, y] of pts) {
      view.setInt16(at, x, true);
      view.setInt16(at + 2, y, true);
      at += 4;
    }
  });
  return out;
}

function polygonsPayload (features) {
  let size = 0;
  for (const f of features) {
    size += 4;
    for (const ring of f.rings) size += 4 + ring.length * 4;
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of features) {
    view.setUint16(at, f.rings.length, true);
    view.setUint8(at + 2, f.a);
    view.setUint8(at + 3, f.b);
    at += 4;
    for (const ring of f.rings) {
      view.setUint32(at, ring.length, true);
      at += 4;
    }
    for (const ring of f.rings) {
      for (const [x, y] of ring) {
        view.setInt16(at, x, true);
        view.setInt16(at + 2, y, true);
        at += 4;
      }
    }
  }
  return out;
}

function ringArea (ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

function triangleArea (vertices, indices) {
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const px = (i) => view.getInt16(i * POINT_STRIDE, true);
  const py = (i) => view.getInt16(i * POINT_STRIDE + 2, true);
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [i0, i1, i2] = [indices[t], indices[t + 1], indices[t + 2]];
    sum += Math.abs(
      (px(i1) - px(i0)) * (py(i2) - py(i0)) - (px(i2) - px(i0)) * (py(i1) - py(i0)),
    ) / 2;
  }
  return sum;
}

function pointsPayload (pts) {
  const out = new Uint8Array(pts.length * 8);
  const view = new DataView(out.buffer);
  pts.forEach(([x, y, a, b], i) => {
    view.setInt16(i * 8, x, true);
    view.setInt16(i * 8 + 2, y, true);
    view.setUint8(i * 8 + 4, a);
    view.setUint8(i * 8 + 5, b);
  });
  return out;
}

test('拾取通道：传出副本后原件仍可读，且坐标可用跨步视图直接取', () => {
  const pts = [[100, -200, 3, 1], [300, 400, 5, 2], [-500, 600, 7, 0]];
  const payload = pointsPayload(pts);

  const chunked = new Uint8Array(12 + payload.length);
  chunked.set(payload, 12);
  const sliced = chunked.subarray(12);
  assert.equal(sliced.byteOffset, 12);

  const forGpu = sliced.slice();
  structuredClone(forGpu.buffer, { transfer: [forGpu.buffer] });
  assert.equal(forGpu.buffer.byteLength, 0, '副本应当已被 transfer 分离');
  assert.equal(sliced.buffer.byteLength, 12 + payload.length, '原件不该被牵连分离');

  const positions = new Int16Array(sliced.buffer, sliced.byteOffset, sliced.length / 2);
  const attributes = new Uint8Array(sliced.buffer, sliced.byteOffset, sliced.length);

  pts.forEach(([x, y, a, b], i) => {
    assert.equal(positions[i * 4], x, `点 ${i} 的 x`);
    assert.equal(positions[i * 4 + 1], y, `点 ${i} 的 y`);
    assert.equal(attributes[i * 8 + 4], a, `点 ${i} 的属性 a`);
    assert.equal(attributes[i * 8 + 5], b, `点 ${i} 的属性 b`);
  });
});

test('点与实例：直通，返回的就是载荷本身', () => {
  const bytes = new Uint8Array(16);
  const decoded = decodeChunk(bytes, GEOM.POINTS, 2);
  assert.equal(decoded.direct, bytes, '点不应当被复制或改写');
  assert.equal(decoded.directCount, 2);
  assert.equal(decoded.stroke, undefined);

  const inst = decodeChunk(new Uint8Array(16), GEOM.INSTANCES, 2);
  assert.equal(inst.directCount, 2);
});

test('点：长度不符必须报错，不许带着错数据往下走', () => {
  assert.throws(() => decodeChunk(new Uint8Array(11), GEOM.POINTS, 2), /长度不符/);
});

test('线：线段数与接头数符合折线顶点数', () => {
  const payload = linesPayload(
    [[[0, 0], [10, 0]], [[0, 0], [10, 0], [10, 10]]],
    [[1, 0], [2, 0]],
  );
  const decoded = decodeChunk(payload, GEOM.LINES, 2);
  assert.ok(decoded.stroke);
  assert.equal(decoded.stroke.segmentVertexCount, 18);
  assert.equal(decoded.stroke.segments.length, 18 * SEGMENT_STRIDE);
  assert.equal(decoded.stroke.jointCount, 5);
  assert.equal(decoded.stroke.joints.length, 5 * POINT_STRIDE);
});

test('线：每个顶点带着源折线的两端点，side 序列正确', () => {
  const payload = linesPayload([[[11, 22], [33, 44]]], [[7, 9]]);
  const decoded = decodeChunk(payload, GEOM.LINES, 1);
  assert.ok(decoded.stroke);

  const view = new DataView(
    decoded.stroke.segments.buffer,
    decoded.stroke.segments.byteOffset,
    decoded.stroke.segments.byteLength,
  );
  const expectedSides = [0, 1, 2, 1, 3, 2];

  for (let v = 0; v < 6; v++) {
    const o = v * SEGMENT_STRIDE;
    assert.equal(view.getInt16(o, true), 11, `顶点 ${v} 的 x0`);
    assert.equal(view.getInt16(o + 2, true), 22, `顶点 ${v} 的 y0`);
    assert.equal(view.getInt16(o + 4, true), 33, `顶点 ${v} 的 x1`);
    assert.equal(view.getInt16(o + 6, true), 44, `顶点 ${v} 的 y1`);
    assert.equal(view.getUint8(o + 8), expectedSides[v], `顶点 ${v} 的 side`);
    assert.equal(view.getUint8(o + 9), 7, `顶点 ${v} 的属性 a`);
    assert.equal(view.getUint8(o + 10), 9, `顶点 ${v} 的属性 b`);
  }

  const joints = new DataView(
    decoded.stroke.joints.buffer,
    decoded.stroke.joints.byteOffset,
    decoded.stroke.joints.byteLength,
  );
  assert.equal(joints.getInt16(0, true), 11);
  assert.equal(joints.getInt16(2, true), 22);
  assert.equal(joints.getInt16(POINT_STRIDE, true), 33);
  assert.equal(joints.getInt16(POINT_STRIDE + 2, true), 44);
});

test('面：凸多边形的三角化面积守恒', () => {
  const ring = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const decoded = decodeChunk(polygonsPayload([{ rings: [ring], a: 3, b: 1 }]), GEOM.POLYGONS, 1);
  assert.ok(decoded.fill);
  assert.equal(decoded.fill.vertexCount, 4);
  assert.equal(decoded.fill.indexCount, 6, '一个四边形应当切成两个三角形');
  assert.equal(triangleArea(decoded.fill.vertices, decoded.fill.indices), ringArea(ring));
});

test('面：凹多边形（L 形）的面积也守恒', () => {
  const ring = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]];
  const decoded = decodeChunk(polygonsPayload([{ rings: [ring], a: 0, b: 0 }]), GEOM.POLYGONS, 1);
  assert.ok(decoded.fill);
  assert.equal(ringArea(ring), 6400);
  assert.equal(triangleArea(decoded.fill.vertices, decoded.fill.indices), 6400);
});

test('面：带洞多边形的面积是外环减洞', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const hole = [[20, 20], [80, 20], [80, 80], [20, 80]];
  const decoded = decodeChunk(
    polygonsPayload([{ rings: [outer, hole], a: 1, b: 2 }]),
    GEOM.POLYGONS,
    1,
  );
  assert.ok(decoded.fill);
  assert.equal(decoded.fill.vertexCount, 8);
  assert.equal(ringArea(outer) - ringArea(hole), 6400);
  assert.equal(triangleArea(decoded.fill.vertices, decoded.fill.indices), 6400);
});

test('面：多要素的索引偏移正确，不会跨要素串三角形', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[100, 100], [110, 100], [110, 110], [100, 110]];
  const decoded = decodeChunk(
    polygonsPayload([{ rings: [a], a: 0, b: 0 }, { rings: [b], a: 1, b: 1 }]),
    GEOM.POLYGONS,
    2,
  );
  assert.ok(decoded.fill);
  assert.equal(decoded.fill.vertexCount, 8);
  for (const index of decoded.fill.indices) {
    assert.ok(index < 8, `索引 ${index} 越界`);
  }
  for (let t = 6; t < decoded.fill.indexCount; t++) {
    assert.ok(decoded.fill.indices[t] >= 4, `第二个要素用到了第一个要素的顶点`);
  }
  assert.equal(triangleArea(decoded.fill.vertices, decoded.fill.indices), 100 + 100);
});

test('面：描边是闭合环，每边一个线段加一个接头', () => {
  const ring = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const decoded = decodeChunk(polygonsPayload([{ rings: [ring], a: 5, b: 6 }]), GEOM.POLYGONS, 1);
  assert.ok(decoded.stroke);
  assert.equal(decoded.stroke.segmentVertexCount, 24);
  assert.equal(decoded.stroke.jointCount, 4);
});

test('面：顶点数超过 u16 索引上限必须报错', () => {
  const ring = [];
  for (let i = 0; i < 70000; i++) ring.push([i % 1000, (i / 1000) | 0]);
  assert.throws(
    () => decodeChunk(polygonsPayload([{ rings: [ring], a: 0, b: 0 }]), GEOM.POLYGONS, 1),
    /超过 u16 索引上限/,
  );
});
