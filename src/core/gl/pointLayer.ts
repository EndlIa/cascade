import { ChunkedBuffer, type AppendResult } from './buffer.ts';
import { LayerBase, type LayerOptions } from './layerBase.ts';
import { MEASURE_STRIDE } from './layout.ts';
import { LOD_TARGET, lodCounts } from './lod.ts';
import { COMPOSE_GLSL, themeGlsl, type Theme } from './theme.ts';

const CHUNK_ELEMENTS = 1 << 20;

function vertexSource (theme: Theme): string {
  return `
precision highp float;

uniform mat4 u_mvpMatrix;
uniform float u_zoom;
uniform float u_pixelRatio;

uniform float u_quantum;

attribute vec2 a_pos;
attribute vec4 a_attr;

varying vec3 v_color;

${themeGlsl(theme)}

${COMPOSE_GLSL}

void main () {
  gl_Position = u_mvpMatrix * vec4(a_pos * u_quantum, 0.0, 1.0);

  float a = a_attr.x;
  float b = a_attr.y;
  v_color = tComposeColor(a, b);

  float boost = clamp((u_zoom - 10.0) * 0.45, 0.75, 2.4);
  gl_PointSize = tComposeSize(a, b) * boost * u_pixelRatio;
}
`;
}

const FRAGMENT_SOURCE = `
precision mediump float;

varying vec3 v_color;

void main () {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(v_color, smoothstep(1.0, 0.72, r));
}
`;

export interface PointLayerOptions extends LayerOptions {
  theme: Theme;
}

export class PointLayer extends LayerBase {
  lodTarget: number = LOD_TARGET.POINT;

  private readonly theme: Theme;
  private buffer: ChunkedBuffer | null = null;
  private lod: Uint32Array | null = null;

  private aPos = -1;
  private aAttr = -1;
  private uQuantum: WebGLUniformLocation | null = null;

  constructor (options: PointLayerOptions) {
    super(options);
    this.theme = options.theme;
  }

  append (bytes: Uint8Array, urgent = false): AppendResult {
    if (this.buffer === null) throw new Error('点图层尚未就绪，不能入队');
    return this.buffer.append(bytes, urgent);
  }

  updateAttributes (
    ids: readonly number[],
    byteOffset: number,
    bytesPerElement: number,
    values: Uint8Array,
  ): number {
    if (this.buffer === null) throw new Error('点图层尚未就绪，不能更新');
    const calls = this.buffer.updateAttributes(ids, byteOffset, bytesPerElement, values);
    if (calls > 0) this.requestRepaint();
    return calls;
  }

  updatePositions (ids: readonly number[], qx: Int16Array, qy: Int16Array): number {
    if (this.buffer === null) throw new Error('点图层尚未就绪，不能更新');
    const calls = this.buffer.updatePositions(ids, qx, qy);
    if (calls > 0) this.requestRepaint();
    return calls;
  }

  reset (): void {
    this.buffer?.dispose();
    this.buffer = null;
    this.lod = null;
    this.lastDrawCalls = 0;
    this.lastDrawn = 0;
    if (this.gl !== null) {
      this.buffer = new ChunkedBuffer(this.gl, { stride: MEASURE_STRIDE, chunkElements: CHUNK_ELEMENTS });
    }
    this.requestRepaint();
  }

  get pendingBytes (): number {
    return this.buffer?.pendingBytes ?? 0;
  }

  override get gpuBytes (): number {
    return this.buffer?.uploadedBytes ?? 0;
  }

  get uploaded (): number {
    return this.buffer?.uploaded ?? 0;
  }

  flush (byteBudget: number): number {
    return this.buffer?.flush(byteBudget) ?? 0;
  }

  drawnRanges (): Int32Array {
    if (this.buffer === null) return new Int32Array(0);
    return this.buffer.drawnIdRanges(this.lod ?? undefined);
  }

  protected override shaders (): { vertex: string; fragment: string } {
    return { vertex: vertexSource(this.theme), fragment: FRAGMENT_SOURCE };
  }

  protected override onReady (gl: WebGLRenderingContext, program: WebGLProgram): void {
    this.buffer = new ChunkedBuffer(gl, { stride: MEASURE_STRIDE, chunkElements: CHUNK_ELEMENTS });
    this.aPos = attribOf(gl, program, 'a_pos');
    this.aAttr = attribOf(gl, program, 'a_attr');
    this.uQuantum = gl.getUniformLocation(program, 'u_quantum');
  }

  protected override onFrame (gl: WebGLRenderingContext): void {
    this.pump(() => this.draw(gl));
  }

  override dispose (): void {
    this.buffer?.dispose();
    this.buffer = null;
    this.lod = null;
  }

  private draw (gl: WebGLRenderingContext): void {
    const buffer = this.buffer;
    if (buffer === null) return;

    this.lod = lodCounts(buffer.drawnPrefixes(), this.lodTarget);

    gl.uniform1f(this.uQuantum, this.coords.quantum);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aAttr);

    const lod = this.lod;
    let chunk = 0;
    let calls = 0;
    let drawn = 0;

    buffer.drawEachChunk((vb, count) => {
      const n = Math.min(count, lod[chunk]);
      chunk += 1;
      if (n <= 0) return;

      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, MEASURE_STRIDE, 0);
      gl.vertexAttribPointer(this.aAttr, 4, gl.UNSIGNED_BYTE, false, MEASURE_STRIDE, 4);
      gl.drawArrays(gl.POINTS, 0, n);
      calls += 1;
      drawn += n;
    });

    this.lastDrawCalls = calls;
    this.lastDrawn = drawn;
  }
}

function attribOf (gl: WebGLRenderingContext, program: WebGLProgram, name: string): number {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`着色器里没有 attribute "${name}"`);
  return location;
}
