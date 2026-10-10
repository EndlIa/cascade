import { ChunkedBuffer } from './buffer.ts';
import { LayerBase, type LayerOptions } from './layerBase.ts';
import { POINT_STRIDE, SEGMENT_STRIDE, SIDE_JOINT } from './layout.ts';
import { assertStrokeShape, ROUND_POINT_FRAGMENT_GLSL, STROKE_VERTEX_GLSL, type StrokeBatch } from './stroke.ts';
import { COMPOSE_GLSL, themeGlsl, type Theme } from './theme.ts';

const CHUNK_SEGMENT_VERTICES = 1 << 18;
const CHUNK_JOINTS = 1 << 18;

const PASS_STROKE = 0;
const PASS_JOINT = 1;

function vertexSource (theme: Theme): string {
  return `
precision highp float;

uniform mat4 u_mvpMatrix;
uniform float u_zoom;
uniform float u_pixelRatio;
uniform float u_unitsPerPixel;

uniform float u_quantum;
uniform float u_pass;

attribute vec2 a_p0;
attribute vec2 a_p1;
attribute float a_side;
attribute vec2 a_attr;
attribute vec2 a_pos;

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

  if (u_pass > 0.5) {
    gl_Position = u_mvpMatrix * vec4(a_pos * u_quantum, 0.0, 1.0);
    gl_PointSize = max(widthCss, 0.75) * u_pixelRatio;
  } else {
    gl_Position = strokeVertex(a_p0, a_p1, a_side, widthCss);
  }
}
`;
}

const FRAGMENT_SOURCE = `
precision mediump float;

varying vec3 v_color;
varying float v_pass;

void main () {
  if (v_pass > 0.5) {
    ${ROUND_POINT_FRAGMENT_GLSL}
  } else {
    gl_FragColor = vec4(v_color, 1.0);
  }
}
`;

export interface LineLayerOptions extends LayerOptions {
  theme: Theme;
}

export class LineLayer extends LayerBase {
  lodTarget: number = Infinity;

  private readonly theme: Theme;
  private segments: ChunkedBuffer | null = null;
  private joints: ChunkedBuffer | null = null;

  private aP0 = -1;
  private aP1 = -1;
  private aSide = -1;
  private aAttr = -1;
  private aPos = -1;
  private uQuantum: WebGLUniformLocation | null = null;
  private uPass: WebGLUniformLocation | null = null;

  constructor (options: LineLayerOptions) {
    super(options);
    this.theme = options.theme;
  }

  append (batch: StrokeBatch): void {
    if (this.segments === null || this.joints === null) {
      throw new Error('线图层尚未就绪，不能入队');
    }
    assertStrokeShape(batch);
    if (batch.segmentVertexCount > 0) this.segments.append(batch.segments);
    if (batch.jointCount > 0) this.joints.append(batch.joints);
  }

  get pendingBytes (): number {
    return (this.segments?.pendingBytes ?? 0) + (this.joints?.pendingBytes ?? 0);
  }

  override get gpuBytes (): number {
    return (this.segments?.uploadedBytes ?? 0) + (this.joints?.uploadedBytes ?? 0);
  }

  get uploaded (): number {
    return (this.segments?.uploaded ?? 0) + (this.joints?.uploaded ?? 0);
  }

  flush (byteBudget: number): number {
    let written = 0;
    if (this.segments !== null) written += this.segments.flush(byteBudget);
    if (this.joints !== null) written += this.joints.flush(Math.max(0, byteBudget - written));
    return written;
  }

  protected override shaders (): { vertex: string; fragment: string } {
    return { vertex: vertexSource(this.theme), fragment: FRAGMENT_SOURCE };
  }

  protected override onReady (gl: WebGLRenderingContext, program: WebGLProgram): void {
    this.segments = new ChunkedBuffer(gl, { stride: SEGMENT_STRIDE, chunkElements: CHUNK_SEGMENT_VERTICES });
    this.joints = new ChunkedBuffer(gl, { stride: POINT_STRIDE, chunkElements: CHUNK_JOINTS });

    this.aP0 = attribOf(gl, program, 'a_p0');
    this.aP1 = attribOf(gl, program, 'a_p1');
    this.aSide = attribOf(gl, program, 'a_side');
    this.aAttr = attribOf(gl, program, 'a_attr');
    this.aPos = attribOf(gl, program, 'a_pos');
    this.uQuantum = gl.getUniformLocation(program, 'u_quantum');
    this.uPass = gl.getUniformLocation(program, 'u_pass');
  }

  protected override onFrame (gl: WebGLRenderingContext): void {
    this.pump(() => this.draw(gl));
  }

  override dispose (): void {
    this.segments?.dispose();
    this.joints?.dispose();
    this.segments = null;
    this.joints = null;
  }

  private draw (gl: WebGLRenderingContext): void {
    const segments = this.segments;
    const joints = this.joints;
    if (segments === null || joints === null) return;

    gl.uniform1f(this.uQuantum, this.coords.quantum);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    const total = segments.uploaded;
    const ratio = Number.isFinite(this.lodTarget) && this.lodTarget > 0 && total > this.lodTarget
      ? this.lodTarget / total
      : 1;

    let calls = 0;
    let drawn = 0;

    if (total > 0) {
      gl.uniform1f(this.uPass, PASS_STROKE);
      gl.enableVertexAttribArray(this.aP0);
      gl.enableVertexAttribArray(this.aP1);
      gl.enableVertexAttribArray(this.aSide);
      gl.enableVertexAttribArray(this.aAttr);
      gl.disableVertexAttribArray(this.aPos);

      segments.drawEachChunk((vb, count) => {
        const whole = Math.floor(count / 6) * 6;
        const n = ratio >= 1 ? whole : Math.max(6, Math.floor((whole * ratio) / 6) * 6);
        if (n <= 0) return;

        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.vertexAttribPointer(this.aP0, 2, gl.SHORT, false, SEGMENT_STRIDE, 0);
        gl.vertexAttribPointer(this.aP1, 2, gl.SHORT, false, SEGMENT_STRIDE, 4);
        gl.vertexAttribPointer(this.aSide, 1, gl.UNSIGNED_BYTE, false, SEGMENT_STRIDE, 8);
        gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, SEGMENT_STRIDE, 9);
        gl.drawArrays(gl.TRIANGLES, 0, n);
        calls += 1;
        drawn += n / 6;
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
        const n = ratio >= 1 ? count : Math.max(1, Math.round(count * ratio));
        if (n <= 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, POINT_STRIDE, 0);
        gl.vertexAttribPointer(this.aAttr, 2, gl.UNSIGNED_BYTE, false, POINT_STRIDE, 4);
        gl.drawArrays(gl.POINTS, 0, n);
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
