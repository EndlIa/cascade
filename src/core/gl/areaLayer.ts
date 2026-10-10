import { ChunkedBuffer } from './buffer.ts';
import { IndexedChunkedBuffer } from './indexedBuffer.ts';
import { LayerBase, type LayerOptions } from './layerBase.ts';
import { POINT_STRIDE, SEGMENT_STRIDE, SIDE_JOINT } from './layout.ts';
import { assertStrokeShape, ROUND_POINT_FRAGMENT_GLSL, STROKE_VERTEX_GLSL, type StrokeBatch } from './stroke.ts';
import { COMPOSE_GLSL, themeGlsl, type Theme } from './theme.ts';

const CHUNK_VERTICES = 0xffff;
const CHUNK_SEGMENT_VERTICES = 1 << 18;
const CHUNK_JOINTS = 1 << 18;

const PASS_FILL = 0;
const PASS_STROKE = 1;
const PASS_JOINT = 2;

function vertexSource (theme: Theme): string {
  return `
precision highp float;

uniform mat4 u_mvpMatrix;
uniform float u_zoom;
uniform float u_pixelRatio;
uniform float u_unitsPerPixel;

uniform float u_quantum;
uniform float u_pass;

attribute vec2 a_pos;
attribute vec2 a_attr;
attribute vec2 a_p0;
attribute vec2 a_p1;
attribute float a_side;

varying vec3 v_color;
varying float v_pass;

${themeGlsl(theme)}

${COMPOSE_GLSL}

${STROKE_VERTEX_GLSL}

void main () {
  float a = a_attr.x;
  float b = a_attr.y;
  float widthCss = tComposeSize(a, b);
  v_color = tComposeColor(a, b);
  v_pass = u_pass;

  if (u_pass < 0.5) {
    gl_Position = u_mvpMatrix * vec4(a_pos * u_quantum, 0.0, 1.0);
  } else if (u_pass < 1.5) {
    gl_Position = strokeVertex(a_p0, a_p1, a_side, widthCss);
  } else {
    gl_Position = u_mvpMatrix * vec4(a_pos * u_quantum, 0.0, 1.0);
    gl_PointSize = max(widthCss, 0.75) * u_pixelRatio;
  }
}
`;
}

const FRAGMENT_SOURCE = `
precision mediump float;

uniform float u_fillAlpha;

varying vec3 v_color;
varying float v_pass;

void main () {
  if (v_pass > 1.5) {
    ${ROUND_POINT_FRAGMENT_GLSL}
  } else if (v_pass > 0.5) {
    gl_FragColor = vec4(v_color, 1.0);
  } else {
    gl_FragColor = vec4(v_color, u_fillAlpha);
  }
}
`;

export interface AreaLayerOptions extends LayerOptions {
  theme: Theme;
  fillAlpha?: number;
}

export class AreaLayer extends LayerBase {
  private readonly theme: Theme;
  private readonly fillAlpha: number;

  private fill: IndexedChunkedBuffer | null = null;
  private readonly queuedFill: Array<{ vertices: Uint8Array; indices: Uint16Array }> = [];
  private segments: ChunkedBuffer | null = null;
  private joints: ChunkedBuffer | null = null;

  private aPos = -1;
  private aAttr = -1;
  private aP0 = -1;
  private aP1 = -1;
  private aSide = -1;
  private uQuantum: WebGLUniformLocation | null = null;
  private uPass: WebGLUniformLocation | null = null;
  private uFillAlpha: WebGLUniformLocation | null = null;

  constructor (options: AreaLayerOptions) {
    super(options);
    this.theme = options.theme;
    this.fillAlpha = options.fillAlpha ?? 0.42;
  }

  appendFill (vertices: Uint8Array, indices: Uint16Array): void {
    if (this.fill === null) {
      this.queuedFill.push({ vertices, indices });
      return;
    }
    this.fill.append(vertices, indices);
  }

  appendStroke (batch: StrokeBatch): void {
    if (this.segments === null || this.joints === null) {
      throw new Error('面图层尚未就绪，不能入队');
    }
    assertStrokeShape(batch);
    if (batch.segmentVertexCount > 0) this.segments.append(batch.segments);
    if (batch.jointCount > 0) this.joints.append(batch.joints);
  }

  get pendingBytes (): number {
    return (this.fill?.pendingBytes ?? 0)
      + (this.segments?.pendingBytes ?? 0)
      + (this.joints?.pendingBytes ?? 0);
  }

  override get gpuBytes (): number {
    return (this.fill?.uploadedBytes ?? 0) + (this.segments?.uploadedBytes ?? 0) + (this.joints?.uploadedBytes ?? 0);
  }

  get uploaded (): number {
    return (this.fill?.uploaded ?? 0) + (this.segments?.uploaded ?? 0) + (this.joints?.uploaded ?? 0);
  }

  flush (byteBudget: number): number {
    let written = 0;
    if (this.fill !== null) written += this.fill.flush(byteBudget - written);
    if (this.segments !== null) written += this.segments.flush(byteBudget - written);
    if (this.joints !== null) written += this.joints.flush(byteBudget - written);
    return written;
  }

  protected override shaders (): { vertex: string; fragment: string } {
    return { vertex: vertexSource(this.theme), fragment: FRAGMENT_SOURCE };
  }

  protected override onReady (gl: WebGLRenderingContext, program: WebGLProgram): void {
    this.fill = new IndexedChunkedBuffer(gl, {
      vertexStride: POINT_STRIDE,
      chunkVertices: CHUNK_VERTICES,
    });
    this.segments = new ChunkedBuffer(gl, { stride: SEGMENT_STRIDE, chunkElements: CHUNK_SEGMENT_VERTICES });
    for (const queued of this.queuedFill) this.fill.append(queued.vertices, queued.indices);
    this.queuedFill.length = 0;
    this.joints = new ChunkedBuffer(gl, { stride: POINT_STRIDE, chunkElements: CHUNK_JOINTS });

    this.aPos = attribOf(gl, program, 'a_pos');
    this.aAttr = attribOf(gl, program, 'a_attr');
    this.aP0 = attribOf(gl, program, 'a_p0');
    this.aP1 = attribOf(gl, program, 'a_p1');
    this.aSide = attribOf(gl, program, 'a_side');
    this.uQuantum = gl.getUniformLocation(program, 'u_quantum');
    this.uPass = gl.getUniformLocation(program, 'u_pass');
    this.uFillAlpha = gl.getUniformLocation(program, 'u_fillAlpha');
  }

  protected override onFrame (gl: WebGLRenderingContext): void {
    this.pump(() => this.draw(gl));
  }

  override dispose (): void {
    this.fill?.dispose();
    this.segments?.dispose();
    this.joints?.dispose();
    this.fill = null;
    this.segments = null;
    this.joints = null;
  }

  private draw (gl: WebGLRenderingContext): void {
    const fill = this.fill;
    const segments = this.segments;
    const joints = this.joints;
    if (fill === null || segments === null || joints === null) return;

    gl.uniform1f(this.uQuantum, this.coords.quantum);
    gl.uniform1f(this.uFillAlpha, this.fillAlpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    let calls = 0;
    let drawn = 0;

    if (fill.uploaded > 0) {
      gl.uniform1f(this.uPass, PASS_FILL);
      gl.enableVertexAttribArray(this.aPos);
      gl.enableVertexAttribArray(this.aAttr);
      gl.disableVertexAttribArray(this.aP0);
      gl.disableVertexAttribArray(this.aP1);
      gl.disableVertexAttribArray(this.aSide);

      fill.drawEachChunk((vb, ib, indexCount) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, POINT_STRIDE, 0);
        gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, POINT_STRIDE, 4);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        calls += 1;
        drawn += indexCount / 3;
      });
    }

    if (segments.uploaded > 0) {
      gl.uniform1f(this.uPass, PASS_STROKE);
      gl.enableVertexAttribArray(this.aP0);
      gl.enableVertexAttribArray(this.aP1);
      gl.enableVertexAttribArray(this.aSide);
      gl.enableVertexAttribArray(this.aAttr);
      gl.disableVertexAttribArray(this.aPos);

      segments.drawEachChunk((vb, count) => {
        if (count <= 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.vertexAttribPointer(this.aP0, 2, gl.SHORT, false, SEGMENT_STRIDE, 0);
        gl.vertexAttribPointer(this.aP1, 2, gl.SHORT, false, SEGMENT_STRIDE, 4);
        gl.vertexAttribPointer(this.aSide, 1, gl.UNSIGNED_BYTE, false, SEGMENT_STRIDE, 8);
        gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, SEGMENT_STRIDE, 9);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        calls += 1;
      });
    }

    if (joints.uploaded > 0) {
      gl.uniform1f(this.uPass, PASS_JOINT);
      gl.enableVertexAttribArray(this.aPos);
      gl.enableVertexAttribArray(this.aAttr);
      gl.disableVertexAttribArray(this.aP0);
      gl.disableVertexAttribArray(this.aP1);
      gl.disableVertexAttribArray(this.aSide);
      gl.vertexAttrib1f(this.aSide, SIDE_JOINT);

      joints.drawEachChunk((vb, count) => {
        if (count <= 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, POINT_STRIDE, 0);
        gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, POINT_STRIDE, 4);
        gl.drawArrays(gl.POINTS, 0, count);
        calls += 1;
      });
    }

    this.lastDrawCalls = calls;
    this.lastDrawn = drawn;
  }
}

function attribOf (gl: WebGLRenderingContext, program: WebGLProgram, name: string): number {
  const location = gl.getAttribLocation(program, name);
  if (location < 0) throw new Error(`着色器里没有 attribute "${name}"`);
  return location;
}
