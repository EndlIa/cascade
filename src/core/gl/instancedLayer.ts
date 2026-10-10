import { ChunkedBuffer, type AppendResult } from './buffer.ts';
import { LayerBase, type LayerOptions } from './layerBase.ts';
import { INSTANCE_STRIDE } from './layout.ts';
import { LOD_TARGET, lodCounts } from './lod.ts';
import { COMPOSE_GLSL, themeGlsl, type Theme } from './theme.ts';

const CHUNK_INSTANCES = 1 << 16;

interface InstancedArrays {
  vertexAttribDivisorANGLE (index: number, divisor: number): void;
  drawArraysInstancedANGLE (mode: number, first: number, count: number, primcount: number): void;
}

const UNIT_ARROW = new Float32Array([
  1.0, 0.0,
  -0.55, 0.62,
  -0.55, -0.62,
]);

function vertexSource (theme: Theme): string {
  return `
precision highp float;

uniform mat4 u_mvpMatrix;
uniform float u_zoom;
uniform float u_pixelRatio;
uniform float u_unitsPerPixel;

uniform float u_quantum;

attribute vec2 a_corner;
attribute vec2 a_pos;
attribute float a_heading;
attribute vec2 a_attr;

varying vec3 v_color;

${themeGlsl(theme)}

${COMPOSE_GLSL}

void main () {
  float a = a_attr.x;
  float b = a_attr.y;
  v_color = tComposeColor(a, b);

  float sizeWorld = max(tComposeSize(a, b), 0.75) * u_unitsPerPixel;

  float angle = a_heading * 6.283185307179586;
  float s = sin(angle);
  float c = cos(angle);
  vec2 local = vec2(c * a_corner.x - s * a_corner.y, s * a_corner.x + c * a_corner.y);

  vec2 world = a_pos * u_quantum + local * sizeWorld;
  gl_Position = u_mvpMatrix * vec4(world, 0.0, 1.0);
}
`;
}

const FRAGMENT_SOURCE = `
precision mediump float;

varying vec3 v_color;

void main () {
  gl_FragColor = vec4(v_color, 1.0);
}
`;

export interface InstancedLayerOptions extends LayerOptions {
  theme: Theme;
}

export class InstancedLayer extends LayerBase {
  lodTarget: number = LOD_TARGET.ICON;

  private readonly theme: Theme;
  private buffer: ChunkedBuffer | null = null;
  private ext: InstancedArrays | null = null;
  private cornerBuffer: WebGLBuffer | null = null;
  private lod: Uint32Array | null = null;

  private aCorner = -1;
  private aPos = -1;
  private aHeading = -1;
  private aAttr = -1;
  private uQuantum: WebGLUniformLocation | null = null;

  constructor (options: InstancedLayerOptions) {
    super(options);
    this.theme = options.theme;
  }

  get available (): boolean {
    return this.ext !== null;
  }

  append (bytes: Uint8Array, urgent = false): AppendResult {
    if (this.buffer === null) throw new Error('实例图层尚未就绪，不能入队');
    return this.buffer.append(bytes, urgent);
  }

  updateAttributes (
    ids: readonly number[],
    byteOffset: number,
    bytesPerElement: number,
    values: Uint8Array,
  ): number {
    if (this.buffer === null) throw new Error('实例图层尚未就绪，不能更新');
    const calls = this.buffer.updateAttributes(ids, byteOffset, bytesPerElement, values);
    if (calls > 0) this.requestRepaint();
    return calls;
  }

  updatePositions (ids: readonly number[], qx: Int16Array, qy: Int16Array): number {
    if (this.buffer === null) throw new Error('实例图层尚未就绪，不能更新');
    const calls = this.buffer.updatePositions(ids, qx, qy);
    if (calls > 0) this.requestRepaint();
    return calls;
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
    const ext = gl.getExtension('ANGLE_instanced_arrays');
    if (ext === null) {
      this.report('缺少 ANGLE_instanced_arrays，实例图层不渲染');
      return;
    }
    this.ext = ext as unknown as InstancedArrays;
    this.buffer = new ChunkedBuffer(gl, { stride: INSTANCE_STRIDE, chunkElements: CHUNK_INSTANCES });

    const corner = gl.createBuffer();
    if (corner === null) throw new Error('createBuffer 返回 null');
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_ARROW, gl.STATIC_DRAW);
    this.cornerBuffer = corner;

    this.aCorner = attribOf(gl, program, 'a_corner');
    this.aPos = attribOf(gl, program, 'a_pos');
    this.aHeading = attribOf(gl, program, 'a_heading');
    this.aAttr = attribOf(gl, program, 'a_attr');
    this.uQuantum = gl.getUniformLocation(program, 'u_quantum');
  }

  protected override onFrame (gl: WebGLRenderingContext): void {
    if (this.ext === null) return;
    this.pump(() => this.draw(gl));
  }

  override dispose (): void {
    this.buffer?.dispose();
    this.buffer = null;
    if (this.cornerBuffer !== null && this.gl !== null) this.gl.deleteBuffer(this.cornerBuffer);
    this.cornerBuffer = null;
    this.lod = null;
  }

  private draw (gl: WebGLRenderingContext): void {
    const buffer = this.buffer;
    const ext = this.ext;
    const corner = this.cornerBuffer;
    if (buffer === null || ext === null || corner === null) return;

    this.lod = lodCounts(buffer.drawnPrefixes(), this.lodTarget);

    gl.uniform1f(this.uQuantum, this.coords.quantum);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.enableVertexAttribArray(this.aCorner);
    gl.vertexAttribPointer(this.aCorner, 2, gl.FLOAT, false, 0, 0);
    ext.vertexAttribDivisorANGLE(this.aCorner, 0);

    gl.enableVertexAttribArray(this.aPos);
    gl.enableVertexAttribArray(this.aHeading);
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
      gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, INSTANCE_STRIDE, 0);
      gl.vertexAttribPointer(this.aHeading, 1, gl.UNSIGNED_BYTE, true, INSTANCE_STRIDE, 4);
      gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, INSTANCE_STRIDE, 5);
      ext.vertexAttribDivisorANGLE(this.aPos, 1);
      ext.vertexAttribDivisorANGLE(this.aHeading, 1);
      ext.vertexAttribDivisorANGLE(this.aAttr, 1);

      ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 3, n);
      calls += 1;
      drawn += n;
    });

    ext.vertexAttribDivisorANGLE(this.aCorner, 0);
    ext.vertexAttribDivisorANGLE(this.aPos, 0);
    ext.vertexAttribDivisorANGLE(this.aHeading, 0);
    ext.vertexAttribDivisorANGLE(this.aAttr, 0);

    this.lastDrawCalls = calls;
    this.lastDrawn = drawn;
  }
}

function attribOf (gl: WebGLRenderingContext, program: WebGLProgram, name: string): number {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`着色器里没有 attribute "${name}"`);
  return location;
}
