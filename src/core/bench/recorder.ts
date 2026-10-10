
export interface FrameStats {
  count: number;
  intervalP50Ms: number;
  intervalP95Ms: number;
  intervalMaxMs: number;
  fps: number;
}

export interface LongTaskStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

const LONG_TASK_MS = 50;

export class FrameRecorder {
  private readonly intervals: number[] = [];
  private last = 0;
  private observer: PerformanceObserver | null = null;

  private readonly longTasks: Array<{ start: number; duration: number }> = [];

  observeLongTasks (): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
    } catch {
      this.observer = null;
    }
  }

  stop (): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  tick (now: number): void {
    if (this.last > 0) this.intervals.push(now - this.last);
    this.last = now;
  }

  get size (): number {
    return this.intervals.length;
  }

  statsSince (from: number): FrameStats {
    return summarize(this.intervals.slice(from));
  }

  statsBetween (from: number, to?: number): FrameStats {
    return summarize(this.intervals.slice(from, to));
  }

  longTasksBetween (from: number, to: number): LongTaskStats {
    let count = 0;
    let total = 0;
    let max = 0;
    for (const task of this.longTasks) {
      if (task.start < from || task.start >= to) continue;
      count += 1;
      total += task.duration;
      max = Math.max(max, task.duration);
    }
    return { count, totalMs: round(total, 1), maxMs: round(max, 1) };
  }

  longTasksAll (): LongTaskStats {
    let total = 0;
    let max = 0;
    for (const task of this.longTasks) {
      total += task.duration;
      max = Math.max(max, task.duration);
    }
    return { count: this.longTasks.length, totalMs: round(total, 1), maxMs: round(max, 1) };
  }
}

function summarize (values: readonly number[]): FrameStats {
  if (values.length === 0) {
    return { count: 0, intervalP50Ms: 0, intervalP95Ms: 0, intervalMaxMs: 0, fps: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const p50 = at(0.5);
  return {
    count: sorted.length,
    intervalP50Ms: round(p50, 3),
    intervalP95Ms: round(at(0.95), 3),
    intervalMaxMs: round(sorted[sorted.length - 1], 3),
    fps: round(p50 > 0 ? 1000 / p50 : 0, 1),
  };
}

function round (value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { LONG_TASK_MS };
