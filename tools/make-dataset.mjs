#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CHUNK_HEADER_BYTES, FORMAT_VERSION, GEOM, HEADER } from '../src/core/format.ts';
import { llToMc } from '../src/core/geo.ts';

const argv = process.argv.slice(2);

function arg (name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const out = arg('out', 'public/data/dataset');
const center = /** @type {[number, number]} */ (arg('center', '114.36111,30.54083').split(',').map(Number));
const spanKm = Number(arg('span', '2'));
const seed = Number(arg('seed', '1'));
const want = {
  points: Number(arg('points', '1000000')),
  lines: Number(arg('lines', '400')),
  polygons: Number(arg('polygons', '200')),
  instances: Number(arg('instances', '5000')),
};

if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
  throw new Error('--center 需要 "经度,纬度"');
}

const ALARM_TARGET = 60;

const SENSORS = [
  { key: 'temp', label: '温度', unit: '°C', min: 20, max: 120, alarm: 95, digits: 1 },
  { key: 'press', label: '压力', unit: 'kPa', min: 0, max: 600, alarm: 480, digits: 0 },
  { key: 'gas', label: '可燃气体', unit: '%LEL', min: 0, max: 100, alarm: 25, digits: 1 },
  { key: 'level', label: '液位', unit: '%', min: 0, max: 100, alarm: 90, digits: 1 },
  { key: 'flow', label: '流量', unit: 'm³/h', min: 0, max: 200, alarm: 170, digits: 0 },
];

const ZONE_SENSORS = [
  [[0, 0.45], [1, 0.80], [2, 1.0]],
  [[3, 0.45], [1, 0.75], [2, 1.0]],
  [[4, 0.50], [1, 1.0]],
  [[2, 0.50], [4, 0.80], [1, 1.0]],
  [[0, 0.60], [2, 1.0]],
];

function typeOf (u, zone) {
  const table = ZONE_SENSORS[zone] ?? ZONE_SENSORS[0];
  for (const [type, edge] of table) if (u < edge) return type;
  return table[table.length - 1][0];
}

function readingOf (u, type, hot) {
  const spec = SENSORS[type];
  const span = spec.max - spec.min;
  const alarmNorm = (spec.alarm - spec.min) / span;
  const norm = hot
    ? alarmNorm + 0.03 + u * (1 - alarmNorm) * 0.35
    : 0.06 + u * Math.max(0.02, alarmNorm - 0.08);
  return Math.max(0, Math.min(255, Math.round(norm * 255)));
}

function readingValue (byte, type) {
  const spec = SENSORS[type];
  return spec.min + ((spec.max - spec.min) * byte) / 255;
}

function rng (s) {
  let a = s >>> 0;
  return function next () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss (next) {
  const u = 1 - next();
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const half = (spanKm * 1000) / 2;

const ZONE_COUNT = 5;

function makeFootprint (next) {
  const waves = [
    { order: 1, amp: 0.13, phase: next() * Math.PI * 2 },
    { order: 2, amp: 0.08, phase: next() * Math.PI * 2 },
    { order: 3, amp: 0.05, phase: next() * Math.PI * 2 },
  ];
  return (x, y) => {
    const radius = Math.hypot(x, y) / half;
    const theta = Math.atan2(y, x);
    let edge = 1;
    for (const wave of waves) edge += wave.amp * Math.cos(wave.order * theta + wave.phase);
    return radius <= edge;
  };
}

function buildingRing (next, cx, cy, size, shape) {
  if (shape === 'tank') {
    const sides = 14;
    const out = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      out.push({ x: cx + Math.cos(a) * size, y: cy + Math.sin(a) * size });
    }
    return out;
  }

  const w = size * (0.8 + next() * 0.6);
  const h = size * (0.8 + next() * 0.6);
  const angle = next() * Math.PI;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (dx, dy) => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });

  if (shape === 'l') {
    const mx = w * 0.12;
    const my = h * 0.12;
    return [
      at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, my),
      at(mx, my), at(mx, h / 2), at(-w / 2, h / 2),
    ];
  }

  return [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
}

function makeZoneOf (next) {
  const seeds = [];
  for (let i = 0; i < ZONE_COUNT; i++) {
    const angle = (i / ZONE_COUNT) * Math.PI * 2 + next() * 0.7;
    const radius = half * (0.25 + next() * 0.5);
    seeds.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }

  const zoneOf = (x, y) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const dx = x - seeds[i].x;
      const dy = y - seeds[i].y;
      const d = dx * dx + dy * dy;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  };

  return { zoneOf, seeds };
}

function statusOf (r) {
  if (r < 0.899) return 0;
  if (r < 0.981) return 1;
  return 2;
}

function makeCampus (next, half, want) {
  const inside = makeFootprint(next);
  const { zoneOf, seeds } = makeZoneOf(next);

  const lines = [];
  const MAIN = 3;
  const axes = [];
  for (let i = 0; i < MAIN; i++) {
    const base = -half + (half * 2) * ((i + 0.5) / MAIN);
    axes.push({ vertical: true, at: base + (next() * 2 - 1) * half * 0.1 });
    axes.push({ vertical: false, at: base + (next() * 2 - 1) * half * 0.1 });
  }

  const ROAD_STEPS = 9;
  for (const axis of axes) {
    let prev = null;
    for (let s = 0; s <= ROAD_STEPS; s++) {
      const t = -half + (half * 2) * (s / ROAD_STEPS);
      const drift = (next() * 2 - 1) * half * 0.035;
      const p = axis.vertical
        ? { x: axis.at + drift, y: t }
        : { x: t, y: axis.at + drift };

      if (prev !== null) {
        const midX = (prev.x + p.x) / 2;
        const midY = (prev.y + p.y) / 2;
        if (inside(midX, midY)) {
          lines.push({ pts: [prev, p], zone: zoneOf(midX, midY), status: statusOf(next()) });
        }
      }
      prev = p;
    }
  }

  const buildings = [];
  const placed = [];

  const fits = (x, y, r) => {
    for (const other of placed) {
      const dx = x - other.x;
      const dy = y - other.y;
      if (dx * dx + dy * dy < (r + other.r + 12) ** 2) return false;
    }
    return true;
  };

  const tankFarm = seeds[1] ?? seeds[0];
  const TANKS = Math.max(0, Math.round(want.polygons * 0.16));
  let guard = 0;

  while (buildings.length < TANKS && guard < TANKS * 60) {
    guard += 1;
    const angle = next() * Math.PI * 2;
    const dist = Math.sqrt(next()) * half * 0.3;
    const x = tankFarm.x + Math.cos(angle) * dist;
    const y = tankFarm.y + Math.sin(angle) * dist;
    if (!inside(x, y)) continue;

    const r = 14 + next() * 16;
    if (!fits(x, y, r)) continue;

    placed.push({ x, y, r });
    buildings.push({
      ring: buildingRing(next, x, y, r, 'tank'),
      zone: zoneOf(x, y),
      status: statusOf(next()),
      cx: x,
      cy: y,
      r,
    });
  }

  guard = 0;
  while (buildings.length < want.polygons && guard < want.polygons * 120) {
    guard += 1;
    const x = (next() * 2 - 1) * half;
    const y = (next() * 2 - 1) * half;
    if (!inside(x, y)) continue;

    const tier = next();
    const size = tier < 0.6 ? 14 + next() * 16 : tier < 0.9 ? 28 + next() * 26 : 55 + next() * 50;
    const r = size * 0.7;
    if (!fits(x, y, r)) continue;

    placed.push({ x, y, r });
    buildings.push({
      ring: buildingRing(next, x, y, size, next() < 0.15 ? 'l' : 'rect'),
      zone: zoneOf(x, y),
      status: statusOf(next()),
      cx: x,
      cy: y,
      r,
    });
  }

  for (const bd of buildings) {
    let target = null;
    let bestD = Infinity;
    for (const line of lines) {
      const a = line.pts[0];
      const b = line.pts[1];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((bd.cx - a.x) * vx + (bd.cy - a.y) * vy) / len2))
        : 0;
      const px = a.x + vx * t;
      const py = a.y + vy * t;
      const dx = px - bd.cx;
      const dy = py - bd.cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        target = { x: px, y: py };
      }
    }
    if (target === null) continue;
    lines.push({ pts: [{ x: bd.cx, y: bd.cy }, target], zone: bd.zone, status: statusOf(next()) });
  }

  const points = {
    xs: new Float64Array(want.points),
    ys: new Float64Array(want.points),
    a: new Uint8Array(want.points),
    b: new Uint8Array(want.points),
    t: new Uint8Array(want.points),
    r: new Uint8Array(want.points),
  };
  for (let i = 0; i < want.points; i++) {
    let x;
    let y;
    let zone;

    if (buildings.length === 0) {
      x = (next() * 2 - 1) * half;
      y = (next() * 2 - 1) * half;
      zone = zoneOf(x, y);
    } else {
      const bd = buildings[(next() * buildings.length) | 0];
      if (next() < 0.82) {
        const t = next() * Math.PI * 2;
        const rad = Math.sqrt(next()) * bd.r;
        x = bd.cx + Math.cos(t) * rad;
        y = bd.cy + Math.sin(t) * rad;
      } else {
        x = bd.cx + gauss(next) * bd.r * 1.1;
        y = bd.cy + gauss(next) * bd.r * 1.1;
      }
      zone = bd.zone;
    }

    const type = typeOf(next(), zone);
    const reading = readingOf(next(), type, false);
    const over = readingValue(reading, type) > SENSORS[type].alarm;
    const status = over ? 2 : next() < 0.018 ? 1 : 0;

    points.xs[i] = x;
    points.ys[i] = y;
    points.a[i] = zone;
    points.b[i] = status;
    points.t[i] = type;
    points.r[i] = reading;
  }

  const picked = new Set();
  while (picked.size < ALARM_TARGET) picked.add((next() * want.points) | 0);
  for (const idx of picked) {
    const type = points.t[idx];
    points.r[idx] = readingOf(next(), type, true);
    points.b[idx] = 2;
  }

  const instances = {
    xs: new Float64Array(want.instances),
    ys: new Float64Array(want.instances),
    heading: new Uint8Array(want.instances),
    a: new Uint8Array(want.instances),
    b: new Uint8Array(want.instances),
  };
  for (let i = 0; i < want.instances; i++) {
    if (lines.length === 0) {
      instances.xs[i] = (next() * 2 - 1) * half;
      instances.ys[i] = (next() * 2 - 1) * half;
      instances.a[i] = zoneOf(instances.xs[i], instances.ys[i]);
      instances.b[i] = statusOf(next());
      continue;
    }

    const seg = lines[(next() * lines.length) | 0];
    const t = next();
    const p0 = seg.pts[0];
    const p1 = seg.pts[1];
    instances.xs[i] = p0.x + (p1.x - p0.x) * t;
    instances.ys[i] = p0.y + (p1.y - p0.y) * t;
    const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    instances.heading[i] = Math.round((angle / (Math.PI * 2)) * 256) & 255;
    instances.a[i] = seg.zone;
    instances.b[i] = statusOf(next());
  }

  return { buildings, lines, points, instances, seeds };
}

async function main () {
  const { buildings, lines, points, instances, seeds } = makeCampus(rng(seed + 11), half, want);

  let maxAbs = 0;
  const scanPts = (pts) => {
    for (const p of pts) maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
  };
  for (let i = 0; i < points.xs.length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(points.xs[i]), Math.abs(points.ys[i]));
  }
  for (let i = 0; i < instances.xs.length; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(instances.xs[i]), Math.abs(instances.ys[i]));
  }
  for (const line of lines) scanPts(line.pts);
  for (const bd of buildings) scanPts(bd.ring);

  const quantum = Math.max(0.01, Math.ceil((maxAbs / 32000) * 100) / 100);
  const quant = (v) => {
    const r = Math.round(v / quantum);
    return r < -32768 ? -32768 : r > 32767 ? 32767 : r;
  };

  await mkdir(out, { recursive: true });

  const geometries = {};
  const report = [];

  async function emit (name, chunks, count) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      buf.set(c, at);
      at += c.length;
    }
    const file = `${name}.bin`;
    await writeFile(join(out, file), buf);
    geometries[name] = { file, count };
    report.push([name, count, buf.length]);
  }

  const chunkHead = (geom, count, byteLen) => {
    const b = new Uint8Array(CHUNK_HEADER_BYTES);
    const dv = new DataView(b.buffer);
    b[HEADER.GEOM] = geom;
    dv.setUint32(HEADER.COUNT, count, true);
    dv.setUint32(HEADER.BYTE_LEN, byteLen, true);
    return b;
  };

  {
    const CHUNK = 50000;
    const chunks = [];
    for (let start = 0; start < want.points; start += CHUNK) {
      const n = Math.min(CHUNK, want.points - start);
      const payload = new Uint8Array(n * 8);
      const dv = new DataView(payload.buffer);
      for (let i = 0; i < n; i++) {
        const j = start + i;
        const o = i * 8;
        dv.setInt16(o, quant(points.xs[j]), true);
        dv.setInt16(o + 2, quant(points.ys[j]), true);
        dv.setUint8(o + 4, points.a[j]);
        dv.setUint8(o + 5, points.b[j]);
        dv.setUint8(o + 6, points.t[j]);
        dv.setUint8(o + 7, points.r[j]);
      }
      chunks.push(chunkHead(GEOM.POINTS, n, payload.length), payload);
    }
    await emit('points', chunks, want.points);
  }

  if (lines.length > 0) {
    const CHUNK = 200;
    const chunks = [];
    for (let start = 0; start < lines.length; start += CHUNK) {
      const n = Math.min(CHUNK, lines.length - start);
      const parts = [];
      let byteLen = 0;
      for (let i = 0; i < n; i++) {
        const j = start + i;
        const pts = lines[j].pts;
        const feat = new Uint8Array(4 + pts.length * 4);
        const dv = new DataView(feat.buffer);
        dv.setUint16(0, pts.length, true);
        dv.setUint8(2, lines[j].zone);
        dv.setUint8(3, lines[j].status);
        for (let k = 0; k < pts.length; k++) {
          dv.setInt16(4 + k * 4, quant(pts[k].x), true);
          dv.setInt16(4 + k * 4 + 2, quant(pts[k].y), true);
        }
        parts.push(feat);
        byteLen += feat.length;
      }
      chunks.push(chunkHead(GEOM.LINES, n, byteLen), ...parts);
    }
    await emit('lines', chunks, lines.length);
  }

  if (buildings.length > 0) {
    const CHUNK = 100;
    const chunks = [];
    for (let start = 0; start < buildings.length; start += CHUNK) {
      const n = Math.min(CHUNK, buildings.length - start);
      const parts = [];
      let byteLen = 0;
      for (let i = 0; i < n; i++) {
        const j = start + i;
        const ring = buildings[j].ring;
        const feat = new Uint8Array(8 + ring.length * 4);
        const dv = new DataView(feat.buffer);
        dv.setUint16(0, 1, true); // ringCount
        dv.setUint8(2, buildings[j].zone);
        dv.setUint8(3, buildings[j].status);
        dv.setUint32(4, ring.length, true);
        for (let k = 0; k < ring.length; k++) {
          dv.setInt16(8 + k * 4, quant(ring[k].x), true);
          dv.setInt16(8 + k * 4 + 2, quant(ring[k].y), true);
        }
        parts.push(feat);
        byteLen += feat.length;
      }
      chunks.push(chunkHead(GEOM.POLYGONS, n, byteLen), ...parts);
    }
    await emit('polygons', chunks, buildings.length);
  }

  if (want.instances > 0) {
    const CHUNK = 50000;
    const chunks = [];
    for (let start = 0; start < want.instances; start += CHUNK) {
      const n = Math.min(CHUNK, want.instances - start);
      const payload = new Uint8Array(n * 8);
      const dv = new DataView(payload.buffer);
      for (let i = 0; i < n; i++) {
        const j = start + i;
        const o = i * 8;
        dv.setInt16(o, quant(instances.xs[j]), true);
        dv.setInt16(o + 2, quant(instances.ys[j]), true);
        dv.setUint8(o + 4, instances.heading[j]);
        dv.setUint8(o + 5, instances.a[j]);
        dv.setUint8(o + 6, instances.b[j]);
        dv.setUint8(o + 7, 0);
      }
      chunks.push(chunkHead(GEOM.INSTANCES, n, payload.length), payload);
    }
    await emit('instances', chunks, want.instances);
  }

function clipHalf (poly, mx, my, nx, ny) {
  const side = (p) => (p[0] - mx) * nx + (p[1] - my) * ny;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa <= 0) !== (sb <= 0)) {
      const k = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}

  const ringOf = (pts) => {
    if (pts.length < 3) return [];
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  };

  const chaikin = (ring, rounds) => {
    let cur = ring;
    for (let r = 0; r < rounds; r++) {
      const next = [];
      for (let i = 0; i < cur.length; i++) {
        const a = cur[i];
        const b = cur[(i + 1) % cur.length];
        next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      cur = next;
    }
    return cur;
  };

  let outline = ringOf(buildings.map((b) => [b.cx, b.cy]));
  if (outline.length >= 3) {
    let signed = 0;
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i];
      const q = outline[(i + 1) % outline.length];
      signed += p[0] * q[1] - q[0] * p[1];
    }
    if (signed < 0) outline.reverse();
    let ox = 0;
    let oy = 0;
    for (const p of outline) { ox += p[0]; oy += p[1]; }
    ox /= outline.length;
    oy /= outline.length;
    outline = chaikin(outline, 2);
  } else {
    outline = null;
  }

  const lim = 32760 * quantum;
  const clamp = (v) => Math.round(Math.max(-lim, Math.min(lim, v)));

  const zones = [];
  for (let i = 0; i < seeds.length; i++) {
    let poly = outline ?? [[-half, -half], [half, -half], [half, half], [-half, half]];
    for (let j = 0; j < seeds.length; j++) {
      if (j === i || poly.length === 0) continue;
      const a = seeds[i];
      const b = seeds[j];
      poly = clipHalf(
        poly,
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        b.x - a.x,
        b.y - a.y,
      );
    }
    if (poly.length >= 3) {
      zones.push({ zone: i, points: poly.map(([x, y]) => [clamp(x), clamp(y)]) });
    }
  }

  const manifest = {
    formatVersion: FORMAT_VERSION,
    crs: 'bd09mc',
    origin: center,
    quantum,
    geometries,
    sensors: SENSORS,
    zones,
  };
  await writeFile(join(out, 'dataset.json'), JSON.stringify(manifest, null, 2) + '\n');

  const tally = (values) => {
    const out = [0, 0, 0];
    for (let i = 0; i < values.length; i++) out[values[i]] += 1;
    return out;
  };

  const SAMPLE_LIMIT = 24;
  const alarms = [];
  for (let i = 0; i < points.b.length && alarms.length < SAMPLE_LIMIT; i++) {
    if (points.b[i] !== 2) continue;
    alarms.push({
      x: Math.round(points.xs[i] * 10) / 10,
      y: Math.round(points.ys[i] * 10) / 10,
      zone: points.a[i],
      type: points.t[i],
      value: Number(readingValue(points.r[i], points.t[i]).toFixed(SENSORS[points.t[i]].digits)),
    });
  }

  await writeFile(join(out, 'stats.json'), JSON.stringify({
    zones: ZONE_COUNT,
    points: { total: want.points, byStatus: tally(points.b) },
    buildings: { total: buildings.length, byStatus: tally(buildings.map((b) => b.status)) },
    lines: { total: lines.length, byStatus: tally(lines.map((l) => l.status)) },
    instances: { total: want.instances, byStatus: tally(instances.b) },
    alarms,
  }, null, 2) + '\n');

  const [mx, my] = llToMc(center[0], center[1]);
  console.log(`数据集 → ${out}`);
  console.log(`  原点    ${center[0]}, ${center[1]}   →  BD09MC ${mx.toFixed(2)}, ${my.toFixed(2)}`);
  console.log(`  量化    ${quantum} m/单位   →  覆盖 ±${((32767 * quantum) / 1000).toFixed(2)} km`);
  console.log('  几何');
  for (const [name, count, bytes] of report) {
    console.log(`    ${name.padEnd(10)} ${String(count).padStart(9)} 要素  ${(bytes / 1048576).toFixed(2)} MB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
