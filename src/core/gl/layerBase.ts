import { bmapGL, type BMGLayerHandle, type BMapGLMap, type RawContext } from '../../map/jsapi.ts';
import type { Coords } from '../coords.ts';
import type { UploadBudget } from './budget.ts';

export interface LayerOptions {
  map: BMapGLMap;
  coords: Coords;
  budget: UploadBudget;
  zIndex?: number;
}

export abstract class LayerBase {
  readonly map: BMapGLMap;
  protected readonly coords: Coords;
  protected readonly budget: UploadBudget;

  lastDrawCalls = 0;
  lastDrawn = 0;
  readonly errors: string[] = [];

  protected gl: WebGLRenderingContext | null = null;
  protected program: WebGLProgram | null = null;

  private shown = true;
  private readonly zIndex: number;
  private layer: BMGLayerHandle | null = null;
  private initAttempts = 0;
  private drawFailures = 0;
  private stopped = false;

  constructor (options: LayerOptions) {
    this.map = options.map;
    this.coords = options.coords;
    this.budget = options.budget;
    this.zIndex = options.zIndex ?? 0;
  }

  get visible (): boolean {
    return this.shown;
  }

  set visible (value: boolean) {
    if (value === this.shown) return;
    this.shown = value;
    if (!value) {
      this.lastDrawCalls = 0;
      this.lastDrawn = 0;
    }
    this.requestRepaint();
  }

  protected abstract shaders (): { vertex: string; fragment: string };

  attach (): void {
    const { Point, WebGLCustomLayer } = bmapGL();
    const { vertex, fragment } = this.shaders();

    this.layer = new WebGLCustomLayer({
      vertexShader: vertex,
      fragmentShader: fragment,
      unsafeGL: true,
      referCenter: new Point(this.coords.origin[0], this.coords.origin[1]),
      zIndex: this.zIndex,
      onRender: (ctx) => this.frame(ctx),
      onDestroy: () => {
        this.gl = null;
        this.program = null;
      },
      onError: (error) => {
        this.errors.push(describe(error));
      },
    });
    this.map.addLayer(this.layer);
  }

  get gpuBytes (): number {
    return 0;
  }

  get isReady (): boolean {
    return this.gl !== null;
  }

  abstract get pendingBytes (): number;
  abstract flush (byteBudget: number): number;
  abstract dispose (): void;

  protected abstract onReady (gl: WebGLRenderingContext, program: WebGLProgram): void;
  protected abstract onFrame (gl: WebGLRenderingContext): void;

  protected pump (draw: () => void): void {
    if (this.pendingBytes > 0) {
      const granted = this.budget.take(this.pendingBytes);
      if (granted > 0) this.flush(granted);
      if (this.pendingBytes > 0) this.requestRepaint();
    }

    if (this.visible) {
      draw();
    } else {
      this.lastDrawCalls = 0;
      this.lastDrawn = 0;
    }
  }

  protected requestRepaint (): void {
    if (this.stopped) return;
    this.layer?.triggerRepaint();
  }

  protected report (message: string): void {
    if (this.errors.length >= MAX_ERRORS || this.errors.includes(message)) return;
    this.errors.push(message);
  }

  private frame (ctx: RawContext): void {
    if (this.stopped) return;

    const gl = ctx.gl;
    if (gl === undefined || gl === null) {
      this.report('onRender: ctx.gl 缺失');
      return;
    }

    if (this.gl === null) {
      if (this.initAttempts >= MAX_INIT_ATTEMPTS) {
        this.stopped = true;
        this.report('初始化始终失败，图层停止渲染（不再请求重绘）');
        return;
      }
      this.initAttempts += 1;

      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (program === null || program === undefined) {
        this.report('onRender: 引擎没有绑定 program');
        this.requestRepaint();
        return;
      }
      this.gl = gl;
      this.program = program as WebGLProgram;
      try {
        this.onReady(gl, this.program);
      } catch (error: unknown) {
        this.stopped = true;
        this.report(describe(error));
        return;
      }
    }

    try {
      this.pump(() => this.onFrame(gl));
      this.drawFailures = 0;
    } catch (error: unknown) {
      this.drawFailures += 1;
      this.report(describe(error));
      if (this.drawFailures >= MAX_DRAW_FAILURES) {
        this.stopped = true;
        this.report('绘制连续失败，图层停止渲染');
      }
    }
  }
}

const MAX_ERRORS = 8;
const MAX_INIT_ATTEMPTS = 120;
const MAX_DRAW_FAILURES = 5;

function describe (error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
