import earcut from 'earcut';

import { GEOM } from '../format.ts';
import {
  MEASURE_STRIDE,
  POINT_STRIDE,
  SEGMENT_STRIDE,
  SIDE,
  type DecodedChunk,
  type FillGeometry,
  type StrokeGeometry,
} from './layout.ts';

interface Ring {
  at: number;
  n: number;
  a: number;
  b: number;
  closed: boolean;
}

const BYTES_PER_VERTEX = 4;

function buildStroke (payload: Uint8Array, rings: Ring[]): StrokeGeometry {
  let segmentCount = 0;
  let jointCount = 0;
  for (const ring of rings) {
    segmentCount += ring.closed ? ring.n : ring.n - 1;
    jointCount += ring.n;
  }

  const segments = new Uint8Array(segmentCount * 6 * SEGMENT_STRIDE);
  const joints = new Uint8Array(jointCount * POINT_STRIDE);
  const src = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const dstSeg = new DataView(segments.buffer);
  const dstJoint = new DataView(joints.buffer);

  let segAt = 0;
  let jointAt = 0;

  for (const ring of rings) {
    const bx = (i: number) => src.getInt16(ring.at + i * BYTES_PER_VERTEX, true);
    const by = (i: number) => src.getInt16(ring.at + i * BYTES_PER_VERTEX + 2, true);

    for (let i = 0; i < ring.n; i++) {
      dstJoint.setInt16(jointAt * POINT_STRIDE, bx(i), true);
      dstJoint.setInt16(jointAt * POINT_STRIDE + 2, by(i), true);
      dstJoint.setUint8(jointAt * POINT_STRIDE + 4, ring.a);
      dstJoint.setUint8(jointAt * POINT_STRIDE + 5, ring.b);
      jointAt += 1;
    }

    const last = ring.closed ? ring.n : ring.n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % ring.n;
      const x0 = bx(i);
      const y0 = by(i);
      const x1 = bx(j);
      const y1 = by(j);
      const sides = [
        SIDE.P0_LEFT, SIDE.P0_RIGHT, SIDE.P1_LEFT,
        SIDE.P0_RIGHT, SIDE.P1_RIGHT, SIDE.P1_LEFT,
      ];

      for (const side of sides) {
        const o = segAt * SEGMENT_STRIDE;
        dstSeg.setInt16(o, x0, true);
        dstSeg.setInt16(o + 2, y0, true);
        dstSeg.setInt16(o + 4, x1, true);
        dstSeg.setInt16(o + 6, y1, true);
        dstSeg.setUint8(o + 8, side);
        dstSeg.setUint8(o + 9, ring.a);
        dstSeg.setUint8(o + 10, ring.b);
        dstSeg.setUint8(o + 11, 0);
        segAt += 1;
      }
    }
  }

  return { segments, segmentVertexCount: segAt, joints, jointCount: jointAt };
}

function buildFill (
  payload: Uint8Array,
  rings: Ring[],
  a: number,
  b: number,
  vertexBase: number,
): FillGeometry {
  const src = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  let total = 0;
  for (const ring of rings) total += ring.n;

  const vertices = new Uint8Array(total * POINT_STRIDE);
  const flat = new Array<number>(total * 2);
  const holes = new Array<number>();

  const dst = new DataView(vertices.buffer);
  let at = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (r > 0) holes.push(at);
    for (let i = 0; i < ring.n; i++) {
      const x = src.getInt16(ring.at + i * BYTES_PER_VERTEX, true);
      const y = src.getInt16(ring.at + i * BYTES_PER_VERTEX + 2, true);
      flat[(at + i) * 2] = x;
      flat[(at + i) * 2 + 1] = y;
      dst.setInt16((at + i) * POINT_STRIDE, x, true);
      dst.setInt16((at + i) * POINT_STRIDE + 2, y, true);
      dst.setUint8((at + i) * POINT_STRIDE + 4, a);
      dst.setUint8((at + i) * POINT_STRIDE + 5, b);
    }
    at += ring.n;
  }

  const triangles = earcut(flat, holes.length > 0 ? holes : null, 2);
  const indices = new Uint16Array(triangles.length);
  for (let i = 0; i < triangles.length; i++) indices[i] = triangles[i] + vertexBase;

  return { vertices, vertexCount: total, indices, indexCount: indices.length };
}

function readLineRings (payload: Uint8Array, count: number): Ring[] {
  const src = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const rings: Ring[] = [];
  let at = 0;
  for (let f = 0; f < count; f++) {
    const n = src.getUint16(at, true);
    const a = src.getUint8(at + 2);
    const b = src.getUint8(at + 3);
    at += 4;
    if (n < 2) throw new Error(`线要素 ${f} 的顶点数 ${n} < 2`);
    rings.push({ at, n, a, b, closed: false });
    at += n * BYTES_PER_VERTEX;
  }
  return rings;
}

function readPolygonFeatures (payload: Uint8Array, count: number): Ring[][] {
  const src = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const features: Ring[][] = [];
  let at = 0;

  for (let f = 0; f < count; f++) {
    const ringCount = src.getUint16(at, true);
    const a = src.getUint8(at + 2);
    const b = src.getUint8(at + 3);
    at += 4;
    if (ringCount < 1) throw new Error(`面要素 ${f} 的环数 ${ringCount} < 1`);

    const sizes: number[] = [];
    for (let r = 0; r < ringCount; r++) {
      const n = src.getUint32(at, true);
      at += 4;
      if (n < 3) throw new Error(`面要素 ${f} 第 ${r} 环顶点数 ${n} < 3`);
      sizes.push(n);
    }

    const rings: Ring[] = [];
    for (let r = 0; r < ringCount; r++) {
      rings.push({ at, n: sizes[r], a, b, closed: true });
      at += sizes[r] * BYTES_PER_VERTEX;
    }
    features.push(rings);
  }
  return features;
}

export function decodeChunk (payload: Uint8Array, geom: number, count: number): DecodedChunk {
  if (geom === GEOM.POINTS || geom === GEOM.INSTANCES) {
    const stride = geom === GEOM.POINTS ? MEASURE_STRIDE : 8;
    if (payload.length !== count * stride) {
      throw new Error(`直通块长度不符：${payload.length} ≠ ${count} × ${stride}`);
    }
    return { features: count, direct: payload, directCount: count };
  }

  if (geom === GEOM.LINES) {
    const rings = readLineRings(payload, count);
    return { features: count, stroke: buildStroke(payload, rings) };
  }

  const features = readPolygonFeatures(payload, count);

  const allRings: Ring[] = [];
  let vertexTotal = 0;
  for (const rings of features) {
    for (const ring of rings) {
      allRings.push(ring);
      vertexTotal += ring.n;
    }
  }
  if (vertexTotal > 0xffff) {
    throw new Error(`面块顶点总数 ${vertexTotal} 超过 u16 索引上限`);
  }

  const vertices = new Uint8Array(vertexTotal * POINT_STRIDE);
  const parts: FillGeometry[] = [];
  let written = 0;

  for (const rings of features) {
    const fill = buildFill(payload, rings, rings[0].a, rings[0].b, written);
    vertices.set(fill.vertices, written * POINT_STRIDE);
    parts.push(fill);
    written += fill.vertexCount;
  }

  let indexTotal = 0;
  for (const part of parts) indexTotal += part.indexCount;
  const indices = new Uint16Array(indexTotal);
  let indexAt = 0;
  for (const part of parts) {
    indices.set(part.indices, indexAt);
    indexAt += part.indexCount;
  }

  return {
    features: count,
    fill: { vertices, vertexCount: written, indices, indexCount: indexTotal },
    stroke: buildStroke(payload, allRings),
  };
}
