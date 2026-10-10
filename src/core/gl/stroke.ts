import { POINT_STRIDE, SEGMENT_STRIDE } from './layout.ts';

export const STROKE_VERTEX_GLSL = `
vec4 strokeVertex (vec2 p0, vec2 p1, float side, float widthCss) {
  vec2 w0 = p0 * u_quantum;
  vec2 w1 = p1 * u_quantum;
  vec2 delta = w1 - w0;
  float len = length(delta);
  vec2 normal = len > 0.0 ? vec2(-delta.y, delta.x) / len : vec2(0.0, 1.0);

  float atEnd = step(1.5, side);
  float lr = mod(side, 2.0) * 2.0 - 1.0;
  float halfWidth = max(widthCss, 0.75) * 0.5 * u_unitsPerPixel;

  vec2 world = mix(w0, w1, atEnd) + normal * (lr * halfWidth);
  return u_mvpMatrix * vec4(world, 0.0, 1.0);
}
`;

export const ROUND_POINT_FRAGMENT_GLSL = `
vec2 d = gl_PointCoord - vec2(0.5);
float r = length(d) * 2.0;
if (r > 1.0) discard;
gl_FragColor = vec4(v_color, smoothstep(1.0, 0.72, r));
`;

export interface StrokeBatch {
  segments: Uint8Array;
  segmentVertexCount: number;
  joints: Uint8Array;
  jointCount: number;
}

export function assertStrokeShape (batch: StrokeBatch): void {
  if (batch.segments.byteLength !== batch.segmentVertexCount * SEGMENT_STRIDE) {
    throw new Error(`线身字节数与顶点数不符：${batch.segments.byteLength} ≠ ${batch.segmentVertexCount} × ${SEGMENT_STRIDE}`);
  }
  if (batch.joints.byteLength !== batch.jointCount * POINT_STRIDE) {
    throw new Error(`接头字节数与个数不符：${batch.joints.byteLength} ≠ ${batch.jointCount} × ${POINT_STRIDE}`);
  }
  if (batch.segmentVertexCount % 6 !== 0) {
    throw new Error(`线身顶点数 ${batch.segmentVertexCount} 不是 6 的整数倍（每个线段 6 个顶点）`);
  }
}
