import { llToMc } from './geo.ts';

export class Coords {
  readonly origin: [number, number];
  readonly quantum: number;
  readonly mcOrigin: [number, number];

  constructor (origin: [number, number], quantum: number) {
    this.origin = origin;
    this.quantum = quantum;
    this.mcOrigin = llToMc(origin[0], origin[1]);
  }

  toLocalMeters (lng: number, lat: number): [number, number] {
    const [x, y] = llToMc(lng, lat);
    return [x - this.mcOrigin[0], y - this.mcOrigin[1]];
  }

  quantize (localX: number, localY: number): [number, number] {
    return [clampI16(Math.round(localX / this.quantum)), clampI16(Math.round(localY / this.quantum))];
  }

  quantizeLngLat (lng: number, lat: number): [number, number] {
    const [x, y] = this.toLocalMeters(lng, lat);
    return this.quantize(x, y);
  }

  dequantize (qx: number, qy: number): [number, number] {
    return [qx * this.quantum, qy * this.quantum];
  }
}

function clampI16 (v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}
