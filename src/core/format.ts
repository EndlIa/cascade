
export const CHUNK_HEADER_BYTES = 12;

export const ATTR_BYTES = 2;

export const GEOM = {
  POINTS: 0,
  LINES: 1,
  POLYGONS: 2,
  INSTANCES: 3,
} as const;

export type GeomCode = (typeof GEOM)[keyof typeof GEOM];

export type GeometryKey = 'points' | 'lines' | 'polygons' | 'instances';

export const WIRE_STRIDE: Partial<Record<GeomCode, number>> = {
  [GEOM.POINTS]: 8,
  [GEOM.INSTANCES]: 8,
};

export const HEADER = { GEOM: 0, FLAGS: 1, RESERVED: 2, COUNT: 4, BYTE_LEN: 8 } as const;

export const FORMAT_VERSION = 1;

export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export interface GeometryEntry {
  file: string;
  count: number;
}

export interface SensorSpec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  alarm: number;
  digits: number;
}

export interface ZoneOutline {
  zone: number;
  points: Array<[number, number]>;
}

export interface DatasetManifest {
  formatVersion: number;
  crs: 'bd09mc';
  origin: [number, number];
  quantum: number;
  geometries: Partial<Record<GeometryKey, GeometryEntry>>;
  sensors: SensorSpec[];
  zones: ZoneOutline[];
}

export interface ChunkHeader {
  geom: GeomCode;
  count: number;
  byteLen: number;
}

export function parseManifest (raw: unknown): DatasetManifest {
  if (raw === null || typeof raw !== 'object') throw new Error('manifest: 不是对象');
  const m = raw as Record<string, unknown>;

  if (m.formatVersion !== FORMAT_VERSION) {
    throw new Error(`manifest: 格式版本不支持（读到 ${String(m.formatVersion)}，需要 ${FORMAT_VERSION}）`);
  }
  if (m.crs !== 'bd09mc') throw new Error(`manifest: 坐标参考系不支持（读到 ${String(m.crs)}）`);

  const origin = m.origin;
  if (!Array.isArray(origin) || origin.length !== 2 ||
      typeof origin[0] !== 'number' || typeof origin[1] !== 'number') {
    throw new Error('manifest: origin 必须是 [经度, 纬度]');
  }
  if (typeof m.quantum !== 'number' || !(m.quantum > 0)) {
    throw new Error('manifest: quantum 必须是正数');
  }
  if (m.geometries === null || typeof m.geometries !== 'object') {
    throw new Error('manifest: geometries 缺失');
  }

  const geometries: Partial<Record<GeometryKey, GeometryEntry>> = {};
  for (const [key, value] of Object.entries(m.geometries as Record<string, unknown>)) {
    const e = value as Record<string, unknown>;
    if (typeof e.file !== 'string' || typeof e.count !== 'number') {
      throw new Error(`manifest: geometries.${key} 需要 { file, count }`);
    }
    geometries[key as GeometryKey] = { file: e.file, count: e.count };
  }

  return {
    formatVersion: FORMAT_VERSION,
    crs: 'bd09mc',
    origin: [origin[0], origin[1]],
    quantum: m.quantum,
    geometries,
    sensors: parseSensors(m.sensors),
    zones: parseZones(m.zones),
  };
}

function parseZones (raw: unknown): ZoneOutline[] {
  if (!Array.isArray(raw)) return [];
  const out: ZoneOutline[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown>;
    if (typeof e?.zone !== "number" || !Array.isArray(e?.points)) continue;
    const points = e.points
      .filter((p): p is unknown[] => Array.isArray(p) && p.length === 2)
      .map((p) => [Number(p[0]), Number(p[1])] as [number, number])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (points.length >= 3) out.push({ zone: e.zone, points });
  }
  return out;
}

function parseSensors (raw: unknown): SensorSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const e = entry as Record<string, unknown>;
    const num = (key: string): number => {
      const v = e?.[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`manifest: sensors[${index}].${key} 必须是数字`);
      }
      return v;
    };
    if (typeof e?.key !== 'string' || typeof e?.label !== 'string' || typeof e?.unit !== 'string') {
      throw new Error(`manifest: sensors[${index}] 需要 { key, label, unit }`);
    }
    const min = num('min');
    const max = num('max');
    if (!(max > min)) throw new Error(`manifest: sensors[${index}] 的 max 必须大于 min`);
    return {
      key: e.key,
      label: e.label,
      unit: e.unit,
      min,
      max,
      alarm: num('alarm'),
      digits: num('digits'),
    };
  });
}

export function sensorValue (spec: SensorSpec, byte: number): number {
  return spec.min + ((spec.max - spec.min) * byte) / 255;
}

export function sensorText (spec: SensorSpec, byte: number): string {
  return `${sensorValue(spec, byte).toFixed(spec.digits)} ${spec.unit}`;
}

export function sensorByte (spec: SensorSpec, value: number): number {
  const t = (value - spec.min) / (spec.max - spec.min);
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}

export function readChunkHeader (view: DataView): ChunkHeader {
  const geom = view.getUint8(HEADER.GEOM);
  const flags = view.getUint8(HEADER.FLAGS);
  const reserved = view.getUint16(HEADER.RESERVED, true);
  const count = view.getUint32(HEADER.COUNT, true);
  const byteLen = view.getUint32(HEADER.BYTE_LEN, true);

  if (flags !== 0 || reserved !== 0) {
    throw new Error(`块头: 保留字段非零（flags=${flags} reserved=${reserved}）`);
  }
  if (geom !== GEOM.POINTS && geom !== GEOM.LINES && geom !== GEOM.POLYGONS && geom !== GEOM.INSTANCES) {
    throw new Error(`块头: 未知几何类型 ${geom}`);
  }
  if (byteLen > MAX_CHUNK_BYTES) {
    throw new Error(`块头: 载荷长度 ${byteLen} 超过上限 ${MAX_CHUNK_BYTES}`);
  }
  return { geom, count, byteLen };
}
