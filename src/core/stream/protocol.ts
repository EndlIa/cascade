import type { DatasetManifest, GeomCode } from '../format.ts';

export type ToWorker =
  | { type: 'start'; baseUrl: string; manifest: DatasetManifest; networkBytesPerSecond: number | null }
  | { type: 'cancel' }
  | { type: 'pick'; lng: number; lat: number; radiusM: number; ranges: Int32Array }
  | { type: 'pickAt'; x: number; y: number; radiusM: number; ranges: Int32Array }
  | {
    type: 'select';
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
    ranges: Int32Array;
    countOnly: boolean;
  };

export interface ChunkMessage {
  type: 'chunk';
  geom: GeomCode;
  features: number;

  direct?: ArrayBuffer;
  directCount?: number;

  segments?: ArrayBuffer;
  segmentVertexCount?: number;
  joints?: ArrayBuffer;
  jointCount?: number;

  vertices?: ArrayBuffer;
  vertexCount?: number;
  indices?: ArrayBuffer;
  indexCount?: number;
}

export interface PickHit {
  x: number;
  y: number;
  geom: GeomCode;
  attrs: number[];
}

export type FromWorker =
  | { type: 'manifest'; manifest: DatasetManifest }
  | { type: 'progress'; receivedBytes: number; chunks: number }
  | ChunkMessage
  | { type: 'done'; receivedBytes: number; features: number; elapsedMs: number; resource: ResourceSummary }
  | { type: 'pick'; hit: PickHit | null }
  | { type: 'select'; count: number; ids: number[]; points: ArrayBuffer }
  | { type: 'alarms'; points: ArrayBuffer }
  | { type: 'error'; message: string };

export interface ResourceSummary {
  count: number;
  transferSize: number;
  encodedBodySize: number;
}
