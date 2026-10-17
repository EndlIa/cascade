/// <reference lib="webworker" />

import {
  CHUNK_HEADER_BYTES,
  GEOM,
  readChunkHeader,
  type DatasetManifest,
  type GeomCode,
} from '../format.ts';
import { llToMc } from '../geo.ts';
import { decodeChunk } from '../gl/decode.ts';
import { pickNearest, selectInBox, type PointBlock } from '../query/picker.ts';
import { ChunkFramer } from './framer.ts';
import type { ChunkMessage, FromWorker, PickHit, ResourceSummary, ToWorker } from './protocol.ts';

interface RetainedPoints extends PointBlock {
  firstId: number;
  count: number;
  coords: Int16Array;
  attrs: Uint8Array;
}

const SELECT_ID_LIMIT = 5000;

let manifest: DatasetManifest | null = null;
let originMc: [number, number] = [0, 0];
let abort: AbortController | null = null;
let retainPoints = true;

const retained: RetainedPoints[] = [];
let nextId = 0;
let alarmBytes: Uint8Array | null = null;
let alarmIds: Int32Array | null = null;

function post (message: FromWorker, transfer?: Transferable[]): void {
  if (transfer === undefined) self.postMessage(message);
  else self.postMessage(message, transfer);
}

function copyOut (src: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(src.length);
  copy.set(src);
  return copy.buffer;
}

function emitChunk (chunk: Uint8Array, geom: GeomCode, count: number): number {
  const payload = chunk.subarray(CHUNK_HEADER_BYTES);
  const decoded = decodeChunk(payload, geom, count);
  const firstId = nextId;
  nextId += count;

  if (decoded.direct !== undefined) {
    if (geom === GEOM.POINTS && retainPoints) {
      retained.push({
        firstId,
        count,
        coords: new Int16Array(payload.buffer, payload.byteOffset, payload.length / 2),
        attrs: new Uint8Array(payload.buffer, payload.byteOffset, payload.length),
      });
    }
    const forGpu = copyOut(decoded.direct);
    post(
      { type: 'chunk', geom, features: count, direct: forGpu, directCount: count } satisfies ChunkMessage,
      [forGpu],
    );
    return count;
  }

  const message: ChunkMessage = { type: 'chunk', geom, features: count };
  const transfer: Transferable[] = [];

  if (decoded.stroke !== undefined) {
    message.segments = copyOut(decoded.stroke.segments);
    message.joints = copyOut(decoded.stroke.joints);
    message.segmentVertexCount = decoded.stroke.segmentVertexCount;
    message.jointCount = decoded.stroke.jointCount;
    transfer.push(message.segments, message.joints);
  }
  if (decoded.fill !== undefined) {
    message.vertices = copyOut(decoded.fill.vertices);
    message.indices = copyOut(new Uint8Array(
      decoded.fill.indices.buffer,
      decoded.fill.indices.byteOffset,
      decoded.fill.indices.byteLength,
    ));
    message.vertexCount = decoded.fill.vertexCount;
    message.indexCount = decoded.fill.indexCount;
    transfer.push(message.vertices, message.indices);
  }

  post(message, transfer);
  return count;
}

async function run (baseUrl: string, given: DatasetManifest, netBytesPerSecond: number | null): Promise<void> {
  abort = new AbortController();
  const { signal } = abort;

  manifest = given;
  retainPoints = manifest.geometries.points !== undefined;
  originMc = llToMc(manifest.origin[0], manifest.origin[1]);

  post({ type: 'manifest', manifest });

  let received = 0;
  let features = 0;
  const started = performance.now();
  const downloadStarted = performance.now();

  for (const entry of Object.values(manifest.geometries)) {
    if (entry === undefined) continue;
    const response = await fetch(baseUrl + entry.file, { signal });
    if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}`);
    if (response.body === null) throw new Error(`${entry.file}: 响应没有 body，无法流式读取`);

    const framer = new ChunkFramer();
    const reader = response.body.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (netBytesPerSecond !== null && netBytesPerSecond > 0) {
          const behind = (received / netBytesPerSecond) * 1000 - (performance.now() - downloadStarted);
          if (behind > 1) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(behind, 500)));
          }
        }
        framer.push(value);
        for (const chunk of framer.take()) {
          const header = readChunkHeader(new DataView(chunk.buffer, chunk.byteOffset, CHUNK_HEADER_BYTES));
          features += emitChunk(chunk, header.geom, header.count);
        }
        post({ type: 'progress', receivedBytes: received, chunks: features });
      }
      framer.finish();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${entry.file}: ${detail}（content-type: ${response.headers.get('content-type') ?? '未知'}）`);
    }
  }

  post({
    type: 'done',
    receivedBytes: received,
    features,
    elapsedMs: performance.now() - started,
    resource: resourceStats(),
  });

  const alarms = collectAlarms();
  alarmBytes = alarms.bytes;
  alarmIds = alarms.ids;
  post({ type: 'alarms', points: alarms.bytes.buffer as ArrayBuffer });
}

function pickInMeters (x: number, y: number, radiusM: number, ranges: Int32Array): PickHit | null {
  const quantum = manifest?.quantum ?? 1;
  const hit = pickNearest(retained, quantum, x, y, radiusM, ranges);
  if (hit === null) return null;
  return { x: hit.x, y: hit.y, geom: GEOM.POINTS, attrs: hit.attrs };
}

function collectAlarms (): { bytes: Uint8Array; ids: Int32Array } {
  let total = 0;
  for (const block of retained) {
    for (let i = 0; i < block.count; i++) if (block.attrs[i * 8 + 5] === 2) total += 1;
  }

  const out = new Uint8Array(total * 6);
  const ids = new Int32Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const block of retained) {
    for (let i = 0; i < block.count; i++) {
      if (block.attrs[i * 8 + 5] !== 2) continue;
      view.setInt16(at * 6, block.coords[i * 4], true);
      view.setInt16(at * 6 + 2, block.coords[i * 4 + 1], true);
      view.setUint8(at * 6 + 4, block.attrs[i * 8 + 4]);
      view.setUint8(at * 6 + 5, 2);
      ids[at] = block.firstId + i;
      at += 1;
    }
  }
  return { bytes: out, ids };
}

function resourceStats (): ResourceSummary {
  let count = 0;
  let transferSize = 0;
  let encodedBodySize = 0;
  for (const entry of performance.getEntriesByType('resource')) {
    const timing = entry as PerformanceResourceTiming;
    count += 1;
    transferSize += timing.transferSize;
    encodedBodySize += timing.encodedBodySize;
  }
  return { count, transferSize, encodedBodySize };
}

function select (
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
  ranges: Int32Array,
): { count: number; ids: number[]; points: Uint8Array; byStatus: [number, number, number] } {
  const quantum = manifest?.quantum ?? 1;
  const [x0, y0] = llToMc(minLng, minLat);
  const [x1, y1] = llToMc(maxLng, maxLat);
  const loX = Math.min(x0, x1) - originMc[0];
  const loY = Math.min(y0, y1) - originMc[1];
  const hiX = Math.max(x0, x1) - originMc[0];
  const hiY = Math.max(y0, y1) - originMc[1];

  const result = selectInBox(retained, quantum, loX, loY, hiX, hiY, ranges, SELECT_ID_LIMIT);
  if (alarmBytes === null || alarmIds === null) return result;

  const view = new DataView(alarmBytes.buffer, alarmBytes.byteOffset, alarmBytes.byteLength);
  const seen = new Set(result.ids);
  const extra: number[] = [];
  for (let i = 0; i < alarmIds.length; i += 1) {
    const x = view.getInt16(i * 6, true) * quantum;
    const y = view.getInt16(i * 6 + 2, true) * quantum;
    if (x < loX || x > hiX || y < loY || y > hiY) continue;
    if (seen.has(alarmIds[i])) continue;
    result.count += 1;
    result.byStatus[2] += 1;
    result.ids.push(alarmIds[i]);
    extra.push(i);
  }

  if (extra.length > 0) {
    const merged = new Uint8Array(result.points.byteLength + extra.length * 8);
    merged.set(result.points, 0);
    let at = result.points.byteLength;
    for (const i of extra) {
      merged.set(alarmBytes.subarray(i * 6, i * 6 + 6), at);
      at += 8;
    }
    result.points = merged;
  }
  return result;
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      run(message.baseUrl, message.manifest, message.networkBytesPerSecond).catch((error: unknown) => {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (message.type === 'cancel') {
      abort?.abort();
      abort = null;
      retained.length = 0;
      manifest = null;
      return;
    }
    if (message.type === 'pick') {
      const [mx, my] = llToMc(message.lng, message.lat);
      post({
        type: 'pick',
        hit: pickInMeters(mx - originMc[0], my - originMc[1], message.radiusM, message.ranges),
      });
      return;
    }
    if (message.type === 'pickAt') {
      post({
        type: 'pick',
        hit: pickInMeters(message.x, message.y, message.radiusM, message.ranges),
      });
      return;
    }
    const result = select(
      message.minLng,
      message.minLat,
      message.maxLng,
      message.maxLat,
      message.ranges,
    );
    post(
      { type: 'select', count: result.count, ids: result.ids, points: result.points.buffer as ArrayBuffer, byStatus: result.byStatus as unknown as number[] },
      [result.points.buffer as ArrayBuffer],
    );
  } catch (error: unknown) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
