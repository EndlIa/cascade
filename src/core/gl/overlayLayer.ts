import { LayerBase, type LayerOptions } from './layerBase.ts';
import { POINT_STRIDE } from './layout.ts';
import { COMPOSE_GLSL, themeGlsl, type Theme } from './theme.ts';

const PULSE_PERIOD_MS = 1500;
const PULSE_CYCLES = 3;
const PULSE_DURATION_MS = PULSE_PERIOD_MS * PULSE_CYCLES;

function vertexSource (theme: Theme): string {
  return `
precision highp float;

uniform mat4 u_mvpMatrix;
uniform float u_zoom;
uniform float u_pixelRatio;
uniform float u_unitsPerPixel;

uniform float u_quantum;
uniform float u_pointPx;

attribute vec2 a_pos;
attribute vec2 a_attr;

varying vec3 v_color;
varying float v_seed;

${themeGlsl(theme)}

${COMPOSE_GLSL}

void main () {
  gl_Position = u_mvpMatrix * vec4(a_pos * u_quantum, 0.0, 1.0);
  v_color = tComposeColor(a_attr.x, a_attr.y);
  gl_PointSize = u_pointPx * u_pixelRatio;

  v_seed = fract(sin(dot(a_pos, vec2(12.9898, 78.233))) * 43758.5453);
}
`;
}

const FRAGMENT_SOURCE = `
precision mediump float;

uniform float u_phase;

varying vec3 v_color;
varying float v_seed;

void main () {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;

  float t = fract(u_phase + v_seed);
  float radius = mix(0.15, 1.0, t);
  float ring = 1.0 - smoothstep(0.0, 0.16, abs(r - radius));
  float alpha = ring * (1.0 - t);
  if (alpha <= 0.01) discard;

  gl_FragColor = vec4(v_color, alpha);
}
`;

export interface OverlayLayerOptions extends LayerOptions {
  theme: Theme;
  pointPx?: number;
  persistent?: boolean;
}

export class OverlayLayer extends LayerBase {
  private readonly theme: Theme;
  private readonly pointPx: number;
  private readonly persistent: boolean;

  private buffer: WebGLBuffer | null = null;
  private count = 0;
  private pending: Uint8Array | null = null;
  private pendingCount = 0;
  private pulseUntil = 0;

  private aPos = -1;
  private aAttr = -1;
  private uQuantum: WebGLUniformLocation | null = null;
  private uPointPx: WebGLUniformLocation | null = null;
  private uPhase: WebGLUniformLocation | null = null;

  constructor (options: OverlayLayerOptions) {
    super(options);
    this.theme = options.theme;
    this.pointPx = options.pointPx ?? 30;
    this.persistent = options.persistent ?? false;
  }

  set (points: Uint8Array): void {
    if (points.byteLength % POINT_STRIDE !== 0) {
      throw new Error(`叠加层数据长度 ${points.byteLength} 不是 ${POINT_STRIDE} 的整数倍`);
    }
    this.pending = points;
    this.pendingCount = points.byteLength / POINT_STRIDE;
    if (this.pendingCount > 0) {
      this.pulseUntil = this.persistent ? Infinity : performance.now() + PULSE_DURATION_MS;
    }
    this.requestRepaint();
  }

  get pendingBytes (): number {
    return 0;
  }

  override get gpuBytes (): number {
    return this.pendingCount * POINT_STRIDE;
  }

  get uploaded (): number {
    return this.count;
  }

  flush (_byteBudget: number): number {
    return 0;
  }

  protected override shaders (): { vertex: string; fragment: string } {
    return { vertex: vertexSource(this.theme), fragment: FRAGMENT_SOURCE };
  }

  protected override onReady (gl: WebGLRenderingContext, program: WebGLProgram): void {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('createBuffer 返回 null');
    this.buffer = buffer;

    this.aPos = attribOf(gl, program, 'a_pos');
    this.aAttr = attribOf(gl, program, 'a_attr');
    this.uQuantum = gl.getUniformLocation(program, 'u_quantum');
    this.uPointPx = gl.getUniformLocation(program, 'u_pointPx');
    this.uPhase = gl.getUniformLocation(program, 'u_phase');
  }

  protected override onFrame (gl: WebGLRenderingContext): void {
    this.pump(() => this.draw(gl));
  }

  override dispose (): void {
    if (this.buffer !== null && this.gl !== null) this.gl.deleteBuffer(this.buffer);
    this.buffer = null;
    this.count = 0;
    this.pending = null;
  }

  private draw (gl: WebGLRenderingContext): void {
    const buffer = this.buffer;
    if (buffer === null) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (this.pending !== null) {
      gl.bufferData(gl.ARRAY_BUFFER, this.pending, gl.DYNAMIC_DRAW);
      this.count = this.pendingCount;
      this.pending = null;
    }

    if (this.count === 0) {
      this.lastDrawCalls = 0;
      this.lastDrawn = 0;
      return;
    }

    gl.uniform1f(this.uQuantum, this.coords.quantum);
    gl.uniform1f(this.uPointPx, this.pointPx);
    gl.uniform1f(this.uPhase, (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aAttr);
    gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, POINT_STRIDE, 0);
    gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, POINT_STRIDE, 4);
    gl.drawArrays(gl.POINTS, 0, this.count);

    this.lastDrawCalls = 1;
    this.lastDrawn = this.count;

    if (performance.now() < this.pulseUntil) this.requestRepaint();
  }
}

function attribOf (gl: WebGLRenderingContext, program: WebGLProgram, name: string): number {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`着色器里没有 attribute "${name}"`);
  return location;
}
