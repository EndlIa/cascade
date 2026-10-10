
export interface UploadBudgetOptions {
  bytesPerSecond?: number;
  burstBytes?: number;
  bytesPerFrame?: number;
}

const MB = 1024 * 1024;

export class UploadBudget {
  bytesPerSecond: number;
  bytesPerFrame: number;

  private readonly burst: number;
  private tokens: number;
  private frameLeft: number;
  private lastRefill = 0;

  constructor (opts: UploadBudgetOptions = {}) {
    this.bytesPerSecond = opts.bytesPerSecond ?? 48 * MB;
    this.burst = opts.burstBytes ?? 8 * MB;
    this.bytesPerFrame = opts.bytesPerFrame ?? 2 * MB;
    this.tokens = this.burst;
    this.frameLeft = this.bytesPerFrame;
  }

  newFrame (): void {
    this.frameLeft = this.bytesPerFrame;
  }

  take (want: number): number {
    if (want <= 0) return 0;
    this.refill();

    const byRate = this.bytesPerSecond === Infinity
      ? want
      : Math.min(want, Math.floor(this.tokens));
    const byFrame = this.bytesPerFrame === Infinity
      ? want
      : Math.min(want, this.frameLeft);

    const granted = Math.min(want, byRate, byFrame);
    if (granted <= 0) return 0;

    if (this.bytesPerSecond !== Infinity) this.tokens -= granted;
    if (this.bytesPerFrame !== Infinity) this.frameLeft -= granted;
    return granted;
  }

  get frameUsed (): number {
    return this.bytesPerFrame === Infinity ? 0 : this.bytesPerFrame - this.frameLeft;
  }

  private refill (): void {
    if (this.bytesPerSecond === Infinity) return;
    const now = performance.now();
    if (this.lastRefill === 0) {
      this.lastRefill = now;
      return;
    }
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.bytesPerSecond);
  }
}
