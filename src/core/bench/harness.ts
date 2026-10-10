import type { Coords } from '../coords.ts';
import { POINT_STRIDE } from '../gl/layout.ts';
import type { PickHit, ResourceSummary } from '../stream/protocol.ts';
import type { FeedStats } from '../stream/feed.ts';
import type { AreaLayer } from '../gl/areaLayer.ts';
import type { InstancedLayer } from '../gl/instancedLayer.ts';
import type { LineLayer } from '../gl/lineLayer.ts';
import type { OverlayLayer } from '../gl/overlayLayer.ts';
import type { PointLayer } from '../gl/pointLayer.ts';
import type { FrameRecorder, FrameStats, LongTaskStats } from './recorder.ts';

export interface BenchDataset {
  url: string;
  quantum: number;
  counts: Record<string, number>;
}

export interface BenchLayers {
  points: PointLayer;
  lines: LineLayer;
  areas: AreaLayer;
  instances: InstancedLayer;
  overlay: OverlayLayer;
}

export interface BenchContext {
  layers: BenchLayers;
  dataset: BenchDataset;
  coords: Coords;
  centerLngLat: [number, number];
  instanceRange: () => { firstId: number; count: number };
  pointRanges: () => Int32Array;
  pickOnce: (x: number, y: number, radiusM: number) => Promise<PickHit | null>;
  selectOnce: (lng: number, lat: number, halfSpanDeg: number) => Promise<number>;
  stimulate: (phase: number) => boolean;
  budget: { bytesPerSecond: number; bytesPerFrame: number };
  lods: { point: number; instance: number };
}

export interface UpdateStats {
  perFrame: number;
  frames: number;
  calls: number;
  costMs: number;
  perUpdateUs: number;
  wallMs: number;
  framesStats: FrameStats;
}

export interface QueryStats {
  queries: number;
  totalMs: number;
  perQueryMs: number;
  hits: number;
  lastCount: number;
}

export interface AttributionStats {
  frames: number;
  withLayersMs: number;
  withoutLayersMs: number;
  ourMsPerFrame: number;
}

export interface DrawSnapshot {
  calls: number;
  points: number;
  segments: number;
  triangles: number;
  instances: number;
}

export interface BenchResult {
  meta: {
    startedAt: string;
    dataset: string;
    quantum: number;
    counts: Record<string, number>;
    quantumRangeKm: number;
    userAgent: string;
    devicePixelRatio: number;
    webglVersion: string;
    gpu: string;
    lods: { point: number; instance: number };
    budget: { bytesPerSecond: number; bytesPerFrame: number };
  };
  load: {
    firstDataMs: number | null;
    totalMs: number;
    receivedBytes: number;
    features: number;
    uploadDrainMs: number | null;
    resource: { count: number; transferSize: number; encodedBodySize: number };
    frames: FrameStats;
    longTasks: LongTaskStats;
  };
  idleRafHz: number;
  idleRounds: number[];
  throttled: boolean;
  scenarios: {
    update: UpdateStats | null;
    pick: QueryStats | null;
    select: QueryStats | null;
    interaction: { frames: FrameStats; stimulated: number } | null;
    attribution: AttributionStats | null;
  };
  drawCalls: number;
  drawn: { points: number; segments: number; triangles: number; instances: number };
  resources: {
    jsHeap: { usedBytes: number | null; totalBytes: number | null; limitBytes: number | null };
    geometryBytes: number;
    longTasks: LongTaskStats;
    mainThreadBusyRatio: number;
    gpuTimer: boolean;
  };
  errors: string[];
}

const ATTRIBUTED_LAYERS = ['points', 'lines', 'areas', 'instances'] as const;

const FIND_TARGET_RADIUS_M = 20000;
const PICK_RADIUS_M = 30;
const SELECT_HALF_SPAN_DEG = 0.004;
const IDLE_ROUNDS = 4;

export const THROTTLE_HZ = 20;

const nextFrame = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
};

function webglInfo (): { version: string; gpu: string; gpuTimer: boolean } {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (gl === null) return { version: '不可用', gpu: '不可用', gpuTimer: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext === null
      ? '（未暴露，浏览器默认禁用）'
      : String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    return {
      version: String(gl.getParameter(gl.VERSION)),
      gpu,
      gpuTimer: gl.getExtension('EXT_disjoint_timer_query') !== null
        || gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    };
  } catch {
    return { version: '读取失败', gpu: '读取失败', gpuTimer: false };
  }
}

function jsHeap (): { usedBytes: number | null; totalBytes: number | null; limitBytes: number | null } {
  const memory = (performance as unknown as {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (memory === undefined) return { usedBytes: null, totalBytes: null, limitBytes: null };
  return {
    usedBytes: memory.usedJSHeapSize,
    totalBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit,
  };
}

export interface ScenarioOptions {
  updatePerFrame: number;
  updateFrames: number;
  queries: number;
  interactionFrames: number;
  attributionFrames: number;
  idleFrames: number;
}

export const DEFAULT_SCENARIOS: ScenarioOptions = {
  updatePerFrame: 2000,
  updateFrames: 60,
  queries: 200,
  interactionFrames: 120,
  attributionFrames: 24,
  idleFrames: 40,
};

export class BenchHarness {
  private readonly ctx: BenchContext;
  private readonly recorder: FrameRecorder;
  private readonly startedAt = new Date().toISOString();
  private readonly loadStartMs = performance.now();
  private readonly bootFrameIndex: number;

  private firstDataMs: number | null = null;
  private receivedBytes = 0;
  private features = 0;
  private loadDoneMs: number | null = null;
  private loadDoneFrameIndex: number | null = null;
  private uploadDrainedMs: number | null = null;
  private idleRafHz = 0;
  private idleSample: { rounds: number; framesPerRound: number; perRound: number[] } | null = null;
  private drawSnapshot: DrawSnapshot | null = null;
  private transfer: ResourceSummary = { count: 0, transferSize: 0, encodedBodySize: 0 };
  private readonly errors: string[] = [];

  constructor (ctx: BenchContext, recorder: FrameRecorder) {
    this.ctx = ctx;
    this.recorder = recorder;
    this.bootFrameIndex = recorder.size;
  }

  noteFirstData (): void {
    if (this.firstDataMs === null) this.firstDataMs = performance.now() - this.loadStartMs;
  }

  noteProgress (receivedBytes: number, features: number): void {
    this.receivedBytes = receivedBytes;
    this.features = features;
  }

  noteLoadDone (stats: FeedStats): void {
    this.loadDoneMs = performance.now() - this.loadStartMs;
    this.loadDoneFrameIndex = this.recorder.size;
    this.transfer = stats.resource;
  }

  noteUploadDrained (): void {
    if (this.uploadDrainedMs === null && this.loadDoneMs !== null) {
      this.uploadDrainedMs = performance.now() - this.loadStartMs;
    }
  }

  noteError (message: string): void {
    this.errors.push(message);
  }

  async runScenarios (options: ScenarioOptions = DEFAULT_SCENARIOS): Promise<void> {
    this.idleRafHz = await this.measureIdle(options.idleFrames);

    this.scenarios.update = await this.measureUpdate(options.updatePerFrame, options.updateFrames);
    this.scenarios.pick = await this.measurePick(options.queries);
    this.scenarios.select = await this.measureSelect(options.queries);
    this.scenarios.interaction = await this.measureInteraction(options.interactionFrames);
    this.drawSnapshot = this.snapshotDraw();
    this.scenarios.attribution = await this.measureAttribution(options.attributionFrames);
  }

  private snapshotDraw (): DrawSnapshot {
    const { points, lines, areas, instances, overlay } = this.ctx.layers;
    return {
      calls: points.lastDrawCalls + lines.lastDrawCalls + areas.lastDrawCalls
        + instances.lastDrawCalls + overlay.lastDrawCalls,
      points: points.lastDrawn,
      segments: lines.lastDrawn,
      triangles: areas.lastDrawn,
      instances: instances.lastDrawn,
    };
  }

  private readonly scenarios: BenchResult['scenarios'] = {
    update: null,
    pick: null,
    select: null,
    interaction: null,
    attribution: null,
  };

  private async measureUpdate (perFrame: number, frames: number): Promise<UpdateStats | null> {
    const range = this.ctx.instanceRange();
    if (range.count === 0 || perFrame <= 0) return null;

    const count = Math.min(perFrame, range.count);
    const ids: number[] = new Array(count);
    const qx = new Int16Array(count);
    const qy = new Int16Array(count);
    for (let i = 0; i < count; i++) ids[i] = range.firstId + i;

    const span = Math.max(4, Math.round(200 / this.ctx.coords.quantum / 100));
    const frameIndex = this.recorder.size;
    const wallStart = performance.now();
    let costMs = 0;
    let calls = 0;

    for (let f = 0; f < frames; f++) {
      await nextFrame();
      const offset = Math.round(Math.sin((f / frames) * Math.PI * 2) * span);
      for (let i = 0; i < count; i++) {
        qx[i] = offset;
        qy[i] = Math.round(offset / 2);
      }
      const t0 = performance.now();
      calls += this.ctx.layers.instances.updatePositions(ids, qx, qy);
      costMs += performance.now() - t0;
    }

    const wallMs = performance.now() - wallStart;
    const updates = count * frames;
    return {
      perFrame: count,
      frames,
      calls,
      costMs: round(costMs, 2),
      perUpdateUs: round((costMs * 1000) / updates, 3),
      wallMs: round(wallMs, 1),
      framesStats: this.recorder.statsSince(frameIndex),
    };
  }

  private async measureIdle (frames: number): Promise<number> {
    if (frames <= 0) return 0;
    const perRound: number[] = [];
    let best = 0;

    for (let r = 0; r < IDLE_ROUNDS; r++) {
      const start = performance.now();
      for (let f = 0; f < frames; f++) await nextFrame();
      const elapsed = performance.now() - start;
      const hz = elapsed > 0 ? (frames * 1000) / elapsed : 0;
      perRound.push(round(hz, 1));
      best = Math.max(best, hz);
    }

    this.idleSample = { rounds: perRound.length, framesPerRound: frames, perRound };
    return best;
  }

  private async measurePick (queries: number): Promise<QueryStats | null> {
    if (queries <= 0) return null;
    if (this.ctx.pointRanges().length === 0) return null;

    const seed = await this.ctx.pickOnce(0, 0, FIND_TARGET_RADIUS_M);
    if (seed === null) {
      this.errors.push(
        `拾取：${FIND_TARGET_RADIUS_M} m 内没有任何已绘制点，选不出查询目标`,
      );
      return null;
    }

    const start = performance.now();
    let hits = 0;

    for (let i = 0; i < queries; i++) {
      const hit = await this.ctx.pickOnce(seed.x, seed.y, PICK_RADIUS_M);
      if (hit !== null) hits += 1;
    }

    const totalMs = performance.now() - start;
    return {
      queries,
      totalMs: round(totalMs, 2),
      perQueryMs: round(totalMs / queries, 3),
      hits,
      lastCount: hits > 0 ? 1 : 0,
    };
  }

  private async measureSelect (queries: number): Promise<QueryStats | null> {
    if (queries <= 0) return null;
    if (this.ctx.pointRanges().length === 0) return null;

    const [lng, lat] = this.ctx.centerLngLat;
    const start = performance.now();
    let lastCount = 0;

    for (let i = 0; i < queries; i++) {
      lastCount = await this.ctx.selectOnce(lng, lat, SELECT_HALF_SPAN_DEG);
    }

    const totalMs = performance.now() - start;
    return {
      queries,
      totalMs: round(totalMs, 2),
      perQueryMs: round(totalMs / queries, 3),
      hits: lastCount,
      lastCount,
    };
  }

  private async measureInteraction (frames: number): Promise<{ frames: FrameStats; stimulated: number } | null> {
    if (frames <= 0) return null;
    const from = this.recorder.size;
    let stimulated = 0;

    for (let f = 0; f < frames; f++) {
      await nextFrame();
      if (this.ctx.stimulate((f / frames) * Math.PI * 2)) stimulated += 1;
    }

    if (stimulated === 0) return null;
    return { frames: this.recorder.statsSince(from), stimulated };
  }

  private async measureAttribution (frames: number): Promise<AttributionStats | null> {
    if (frames <= 0) return null;

    const withLayers = await this.forceRepaint(frames, true);
    const withoutLayers = await this.forceRepaint(frames, false);

    for (const name of ATTRIBUTED_LAYERS) this.ctx.layers[name].visible = true;
    this.ctx.layers.overlay.set(new Uint8Array(0));

    return {
      frames,
      withLayersMs: withLayers,
      withoutLayersMs: withoutLayers,
      ourMsPerFrame: round(withLayers - withoutLayers, 2),
    };
  }

  private async forceRepaint (frames: number, visible: boolean): Promise<number> {
    for (const name of ATTRIBUTED_LAYERS) this.ctx.layers[name].visible = visible;

    const probe = new Uint8Array(POINT_STRIDE);
    this.ctx.layers.overlay.set(probe);
    const start = performance.now();
    for (let f = 0; f < frames; f++) {
      await nextFrame();
      this.ctx.layers.overlay.set(probe);
    }
    return round((performance.now() - start) / frames, 2);
  }

  result (): BenchResult {
    const { dataset } = this.ctx;
    const info = webglInfo();
    const idleRafHz = this.idleRafHz;
    const draw = this.drawSnapshot ?? this.snapshotDraw();
    const loadFrames = this.loadDoneFrameIndex === null
      ? this.recorder.statsSince(this.bootFrameIndex)
      : this.recorder.statsBetween(this.bootFrameIndex, this.loadDoneFrameIndex);

    return {
      meta: {
        startedAt: this.startedAt,
        dataset: dataset.url,
        quantum: dataset.quantum,
        counts: dataset.counts,
        quantumRangeKm: round((32767 * dataset.quantum) / 1000, 2),
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio || 1,
        webglVersion: info.version,
        gpu: info.gpu,
        lods: this.ctx.lods,
        budget: this.ctx.budget,
      },
      load: {
        firstDataMs: this.firstDataMs === null ? null : round(this.firstDataMs, 1),
        totalMs: round(this.loadDoneMs ?? performance.now() - this.loadStartMs, 1),
        receivedBytes: this.receivedBytes,
        features: this.features,
        uploadDrainMs: this.uploadDrainedMs === null ? null : round(this.uploadDrainedMs, 1),
        resource: this.transfer,
        frames: loadFrames,
        longTasks: this.recorder.longTasksBetween(
          this.loadStartMs,
          this.loadStartMs + (this.loadDoneMs ?? performance.now() - this.loadStartMs),
        ),
      },
      idleRafHz: round(idleRafHz, 1),
      idleRounds: this.idleSample?.perRound ?? [],
      throttled: idleRafHz > 0 && idleRafHz < THROTTLE_HZ,
      scenarios: this.scenarios,
      drawCalls: draw.calls,
      drawn: {
        points: draw.points,
        segments: draw.segments,
        triangles: draw.triangles,
        instances: draw.instances,
      },
      resources: {
        jsHeap: jsHeap(),
        geometryBytes: this.receivedBytes,
        longTasks: this.recorder.longTasksAll(),
        mainThreadBusyRatio: round(
          Math.min(1, this.recorder.longTasksAll().totalMs / Math.max(1, performance.now() - this.loadStartMs)),
          3,
        ),
        gpuTimer: info.gpuTimer,
      },
      errors: this.errors,
    };
  }
}

function round (value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
