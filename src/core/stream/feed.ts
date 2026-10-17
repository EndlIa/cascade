import { parseManifest, type DatasetManifest } from '../format.ts';
import type { ChunkMessage, PickHit, ResourceSummary, ToWorker } from './protocol.ts';

export async function loadManifest (
  url: string,
): Promise<{ manifest: DatasetManifest; baseUrl: string }> {
  const absolute = new URL(url, document.baseURI).href;
  const response = await fetch(absolute);
  if (!response.ok) throw new Error(`dataset.json: HTTP ${response.status}`);
  const manifest = parseManifest(await response.json());
  return { manifest, baseUrl: absolute.slice(0, absolute.lastIndexOf('/') + 1) };
}

export interface FeedStats {
  receivedBytes: number;
  features: number;
  elapsedMs: number;
  resource: ResourceSummary;
}

export interface FeedOptions {
  onManifest?: (manifest: DatasetManifest) => void;
  onChunk: (chunk: ChunkMessage) => void;
  onProgress?: (receivedBytes: number, features: number) => void;
  onDone?: (stats: FeedStats) => void;
  onPick?: (hit: PickHit | null) => void;
  onSelect?: (count: number, ids: number[], points: ArrayBuffer, byStatus: number[]) => void;
  onAlarms?: (points: ArrayBuffer) => void;
  onError: (message: string) => void;
}

export class DatasetFeed {
  private readonly worker: Worker;
  private readonly options: FeedOptions;
  private stopped = false;

  constructor (options: FeedOptions) {
    this.options = options;
    this.worker = new Worker(new URL('./source.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      options.onError(`Worker 异常：${event.message}`);
    };
  }

  start (baseUrl: string, manifest: DatasetManifest, networkBytesPerSecond: number | null = null): void {
    this.send({ type: 'start', baseUrl, manifest, networkBytesPerSecond });
  }

  pick (lng: number, lat: number, radiusM: number, ranges: Int32Array): void {
    this.send({ type: 'pick', lng, lat, radiusM, ranges });
  }

  pickAt (x: number, y: number, radiusM: number, ranges: Int32Array): void {
    this.send({ type: 'pickAt', x, y, radiusM, ranges });
  }

  select (
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
    ranges: Int32Array,
    countOnly = false,
  ): void {
    this.send({ type: 'select', minLng, minLat, maxLng, maxLat, ranges, countOnly });
  }

  dispose (): void {
    if (this.stopped) return;
    this.stopped = true;
    this.send({ type: 'cancel' });
    this.worker.terminate();
  }

  private send (message: ToWorker): void {
    if (this.stopped) return;
    this.worker.postMessage(message);
  }

  private receive (data: unknown): void {
    if (typeof data !== 'object' || data === null || !('type' in data)) return;
    const message = data as { type: string } & Record<string, unknown>;

    switch (message.type) {
      case 'manifest':
        this.options.onManifest?.(message.manifest as DatasetManifest);
        return;
      case 'progress':
        this.options.onProgress?.(message.receivedBytes as number, message.chunks as number);
        return;
      case 'chunk':
        this.options.onChunk(message as unknown as ChunkMessage);
        return;
      case 'done':
        this.options.onDone?.({
          receivedBytes: message.receivedBytes as number,
          features: message.features as number,
          elapsedMs: message.elapsedMs as number,
          resource: message.resource as ResourceSummary,
        });
        return;
      case 'pick':
        this.options.onPick?.((message.hit ?? null) as PickHit | null);
        return;
      case 'select':
        this.options.onSelect?.(
          message.count as number,
          message.ids as number[],
          message.points as ArrayBuffer,
          message.byStatus as number[],
        );
        return;
      case 'alarms':
        this.options.onAlarms?.(message.points as ArrayBuffer);
        return;
      case 'error':
        this.options.onError(message.message as string);
        return;
      default:
        this.options.onError(`未知消息类型：${message.type}`);
    }
  }
}
