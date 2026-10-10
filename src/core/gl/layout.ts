
export const POINT_STRIDE = 6;

export const MEASURE_STRIDE = 8;

export const SEGMENT_STRIDE = 12;

export const INSTANCE_STRIDE = 8;

export const SIDE = {
  P0_LEFT: 0,
  P0_RIGHT: 1,
  P1_LEFT: 2,
  P1_RIGHT: 3,
} as const;

export const SIDE_JOINT = 4;

export interface StrokeGeometry {
  segments: Uint8Array;
  segmentVertexCount: number;
  joints: Uint8Array;
  jointCount: number;
}

export interface FillGeometry {
  vertices: Uint8Array;
  vertexCount: number;
  indices: Uint16Array;
  indexCount: number;
}

export interface DecodedChunk {
  features: number;
  direct?: Uint8Array;
  directCount?: number;
  stroke?: StrokeGeometry;
  fill?: FillGeometry;
}
