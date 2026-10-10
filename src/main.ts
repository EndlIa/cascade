import { BenchHarness, type BenchContext, type BenchResult } from './core/bench/harness.ts';
import { FrameRecorder } from './core/bench/recorder.ts';
import { Coords } from './core/coords.ts';
import { GEOM, sensorByte, sensorText, type SensorSpec } from './core/format.ts';
import { llToMc } from './core/geo.ts';
import { AreaLayer } from './core/gl/areaLayer.ts';
import { UploadBudget } from './core/gl/budget.ts';
import { InstancedLayer } from './core/gl/instancedLayer.ts';
import { LineLayer } from './core/gl/lineLayer.ts';
import { OverlayLayer } from './core/gl/overlayLayer.ts';
import { PointLayer } from './core/gl/pointLayer.ts';
import type { StrokeBatch } from './core/gl/stroke.ts';
import { themeLegend } from './core/gl/theme.ts';
import { DatasetFeed, loadManifest } from './core/stream/feed.ts';
import type { ChunkMessage, PickHit } from './core/stream/protocol.ts';
import { bmapGL, type BMapGLMap } from './map/jsapi.ts';
import { loadJsapi } from './map/loader.ts';
import { ALARM_THEME, CAMPUS_THEME, SELECTION_THEME } from './scene/theme.ts';

const MB = 1024 * 1024;
const PICK_RADIUS_PX = 12;

const SCHEMATIC_STYLE = {
  styleJson: [
    { featureType: 'all', elementType: 'geometry', stylers: { color: '#080d14' } },
    { featureType: 'all', elementType: 'geometry.fill', stylers: { color: '#080d14' } },
    { featureType: 'all', elementType: 'geometry.stroke', stylers: { color: '#0e1520' } },
    { featureType: 'road', elementType: 'geometry.fill', stylers: { color: '#16202e' } },
    { featureType: 'water', elementType: 'geometry.fill', stylers: { color: '#060b12' } },
    { featureType: 'all', elementType: 'labels', stylers: { visibility: 'off' } },
    { featureType: 'all', elementType: 'labels.text', stylers: { visibility: 'off' } },
    { featureType: 'all', elementType: 'labels.icon', stylers: { visibility: 'off' } },
  ],
};

declare global {
  // eslint-disable-next-line no-var
  var __bench: { result: () => BenchResult; json: () => string } | undefined;
  // eslint-disable-next-line no-var
  var __cascade: {
    layers: Layers;
    feed: DatasetFeed;
    map: BMapGLMap;
    coords: Coords;
    center: [number, number];
  } | undefined;
}

function mustElement (id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`页面缺少 #${id}`);
  return element;
}

function budgetOption (raw: string | null, fallbackBytes: number): number {
  if (raw === null) return fallbackBytes;
  if (raw === 'off') return Infinity;
  const megabytes = Number(raw);
  return Number.isFinite(megabytes) && megabytes > 0 ? megabytes * MB : fallbackBytes;
}

function benchSize (raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function formatBytes (bytes: number): string {
  if (!Number.isFinite(bytes)) return '不限';
  return bytes >= MB ? `${(bytes / MB).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function strokeOf (chunk: ChunkMessage): StrokeBatch {
  if (chunk.segments === undefined || chunk.joints === undefined) {
    throw new Error('线/面块缺少描边字段');
  }
  return {
    segments: new Uint8Array(chunk.segments),
    segmentVertexCount: chunk.segmentVertexCount ?? 0,
    joints: new Uint8Array(chunk.joints),
    jointCount: chunk.jointCount ?? 0,
  };
}

function fillOf (chunk: ChunkMessage): { vertices: Uint8Array; indices: Uint16Array } {
  if (chunk.vertices === undefined || chunk.indices === undefined) {
    throw new Error('面块缺少填充字段');
  }
  return {
    vertices: new Uint8Array(chunk.vertices),
    indices: new Uint16Array(chunk.indices),
  };
}

function renderLegend (root: HTMLElement): void {
  const legend = themeLegend(CAMPUS_THEME);
  const swatch = (css: string, label: string) =>
    `<li><i style="background:${css}"></i><span>${label}</span></li>`;

  root.innerHTML = [
    `<h4>${legend.classAxisLabel}</h4>`,
    `<ul>${legend.classes.map((c) => swatch(c.css, c.label)).join('')}</ul>`,
    `<hr />`,
    `<h4>${legend.modifierAxisLabel}</h4>`,
    `<ul>${legend.modifiers.map((m) => swatch(m.css, m.label)).join('')}</ul>`,
  ].join('');
}

interface SceneStats {
  zones: number;
  points: { total: number; byStatus: number[] };
  buildings: { total: number; byStatus: number[] };
  lines: { total: number; byStatus: number[] };
  instances: { total: number; byStatus: number[] };
  alarms: Array<{ x: number; y: number; zone: number; type: number; value: number }>;
}

async function loadStats (url: string): Promise<SceneStats | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as SceneStats;
  } catch {
    return null;
  }
}

function makeLocalInverse (origin: [number, number]): (x: number, y: number) => [number, number] {
  const step = 0.01;
  const [mx0, my0] = llToMc(origin[0], origin[1]);
  const [mx1] = llToMc(origin[0] + step, origin[1]);
  const [, my1] = llToMc(origin[0], origin[1] + step);
  const perLng = (mx1 - mx0) / step;
  const perLat = (my1 - my0) / step;

  return (x, y) => [origin[0] + x / perLng, origin[1] + y / perLat];
}

function detailHtml (hit: PickHit | null, sensors: readonly SensorSpec[]): string | null {
  if (hit === null) return null;
  const zone = CAMPUS_THEME.classes[hit.attrs[0]]?.label ?? '（表外）';
  const status = CAMPUS_THEME.modifiers[hit.attrs[1]]?.label ?? '（表外）';
  const alarm = hit.attrs[1] === 2;
  const spec = sensors[hit.attrs[2]];
  const rows: string[] = [];

  if (spec !== undefined) {
    rows.push(`<div class="row"><span>测点</span><b>${spec.label}</b></div>`);
    rows.push(
      `<div class="row"><span>读数</span><b class="${alarm ? 'bad' : ''}">${sensorText(spec, hit.attrs[3])}</b></div>`,
    );
    rows.push(`<div class="row"><span>报警阈值</span><b>${spec.alarm} ${spec.unit}</b></div>`);
  }

  return [
    `<h3>选中测点</h3>`,
    ...rows,
    `<div class="row"><span>分区</span><b>${zone}</b></div>`,
    `<div class="row"><span>状态</span><b class="${alarm ? 'bad' : ''}">${status}</b></div>`,
    `<div class="row"><span>位置</span><b>${hit.x.toFixed(1)}, ${hit.y.toFixed(1)} m</b></div>`,
  ].join('');
}

function selectionHtml (count: number, points: Uint8Array): string {
  const byStatus = [0, 0, 0];
  for (let at = 0; at + 7 < points.length; at += 8) byStatus[points[at + 5]] += 1;
  const shown = points.length / 8;

  return [
    `<h3>框选结果</h3>`,
    `<div class="row"><span>命中测点</span><b>${count.toLocaleString('en-US')}</b></div>`,
    `<div class="row"><span>正常</span><b>${byStatus[0].toLocaleString('en-US')}</b></div>`,
    `<div class="row"><span>检修</span><b>${byStatus[1].toLocaleString('en-US')}</b></div>`,
    `<div class="row"><span>报警</span><b class="${byStatus[2] > 0 ? 'bad' : ''}">${byStatus[2].toLocaleString('en-US')}</b></div>`,
    count > shown
      ? `<div class="row"><span>高亮</span><b>前 ${shown.toLocaleString('en-US')} 个</b></div>`
      : '',
  ].join('');
}

const popupAnchor = { x: 0, y: 0 };

function showPopover (root: HTMLElement, x: number, y: number, html: string): void {
  root.innerHTML = html;
  root.style.display = 'block';

  const box = root.getBoundingClientRect();
  const above = y - box.height - 18 >= 66;
  root.dataset.side = above ? 'above' : 'below';
  root.style.left = `${Math.max(10, Math.min(x - 22, window.innerWidth - box.width - 10))}px`;
  root.style.top = `${above ? y - box.height - 18 : y + 20}px`;
}

interface Layers {
  points: PointLayer;
  lines: LineLayer;
  areas: AreaLayer;
  instances: InstancedLayer;
  overlay: OverlayLayer;
  highlight: PointLayer;
  alarms: OverlayLayer;
  alarmDots: PointLayer;
  block: AreaLayer;
}

async function boot (): Promise<void> {
  const params = new URLSearchParams(location.search);
  const ak = params.get('ak') ?? import.meta.env.VITE_BMAP_AK ?? '';
  const datasetUrl = params.get('dataset') ?? 'data/main/dataset.json';
  const benchEnabled = params.get('bench') === '1';

  const mapElement = mustElement('map');
  const hud = mustElement('hud');
  const legend = mustElement('legend');

  const say = (message: string): void => {
    hud.textContent = message;
  };

  const recorder = benchEnabled ? new FrameRecorder() : null;
  recorder?.observeLongTasks();

  say('加载 JSAPI…');
  await loadJsapi(ak);

  say('读取数据集清单…');
  const { manifest, baseUrl } = await loadManifest(datasetUrl);
  const coords = new Coords(manifest.origin, manifest.quantum);

  const ns = bmapGL();
  const map = new ns.Map(mapElement, { enableRotate: false });
  map.centerAndZoom(new ns.Point(manifest.origin[0], manifest.origin[1]), 16);

  if (params.get('basemap') === 'dark' && typeof map.setMapStyleV2 === 'function') {
    map.setMapStyleV2(SCHEMATIC_STYLE);
  }

  const budget = new UploadBudget({
    bytesPerSecond: budgetOption(params.get('rate'), 48 * MB),
    bytesPerFrame: budgetOption(params.get('frameBudget'), 2 * MB),
  });
  const netRate = budgetOption(params.get('netRate'), Infinity);

  const layers: Layers = {
    areas: new AreaLayer({
      map, coords, budget, zIndex: 6, theme: CAMPUS_THEME, fillAlpha: 0.38,
    }),
    lines: new LineLayer({ map, coords, budget, zIndex: 8, theme: CAMPUS_THEME }),
    points: new PointLayer({ map, coords, budget, zIndex: 10, theme: CAMPUS_THEME }),
    instances: new InstancedLayer({ map, coords, budget, zIndex: 12, theme: CAMPUS_THEME }),
    overlay: new OverlayLayer({ map, coords, budget, zIndex: 20, theme: CAMPUS_THEME }),
    highlight: new PointLayer({ map, coords, budget, zIndex: 22, theme: SELECTION_THEME }),
    alarms: new OverlayLayer({
      map, coords, budget, zIndex: 18, theme: ALARM_THEME, pointPx: 28, persistent: true,
    }),
    alarmDots: new PointLayer({ map, coords, budget, zIndex: 14, theme: CAMPUS_THEME }),
    block: new AreaLayer({ map, coords, budget, zIndex: 4, theme: CAMPUS_THEME, fillAlpha: 0.66 }),
  };
  layers.highlight.lodTarget = 20000;
  layers.alarmDots.lodTarget = Infinity;

  for (const zone of manifest.zones) {
    const n = zone.points.length;
    const verts = new Uint8Array(n * 6);
    const view = new DataView(verts.buffer);
    zone.points.forEach(([x, y], i) => {
      const [qx, qy] = coords.quantize(x, y);
      view.setInt16(i * 6, qx, true);
      view.setInt16(i * 6 + 2, qy, true);
      view.setUint8(i * 6 + 4, zone.zone);
    });
    const indices = new Uint16Array((n - 2) * 3);
    for (let i = 1; i < n - 1; i++) {
      indices[(i - 1) * 3] = 0;
      indices[(i - 1) * 3 + 1] = i;
      indices[(i - 1) * 3 + 2] = i + 1;
    }
    layers.block.appendFill(verts, indices);
  }
  layers.block.visible = false;

  const lodParam = params.get('lod');
  let lodFixed: number | null = null;
  if (lodParam === 'off') {
    lodFixed = Infinity;
    layers.points.lodTarget = Infinity;
    layers.instances.lodTarget = Infinity;
  } else if (lodParam !== null && Number(lodParam) > 0) {
    lodFixed = Number(lodParam);
    layers.points.lodTarget = lodFixed;
  }

  const COARSE_ZOOM = 14;
  let coarse = false;
  let syncRows: () => void = () => {};
  const applyZoom = (): void => {
    const zoom = map.getZoom?.() ?? 16;
    const next = zoom < COARSE_ZOOM;
    if (next !== coarse) {
      coarse = next;
      layers.block.visible = next;
      layers.points.visible = !next;
      layers.areas.visible = !next;
      layers.lines.visible = !next;
      layers.instances.visible = !next;
      syncRows();
    }
    if (!coarse && lodFixed === null) {
      const scaled = Math.round(6000 * 2 ** (zoom - 15));
      layers.points.lodTarget = Math.max(3000, Math.min(150000, scaled));
    }
  };
  applyZoom();
  map.addEventListener('zoomend', applyZoom);

  for (const layer of Object.values(layers)) layer.attach();
  renderLegend(legend);

  const sceneStats = await loadStats(`${baseUrl}stats.json`);
  const numberFormat = new Intl.NumberFormat('en-US');
  const popover = mustElement('popover');

  if (sceneStats !== null) {
    mustElement('kpi-points').textContent = numberFormat.format(sceneStats.points.total);
    mustElement('kpi-buildings').textContent = numberFormat.format(sceneStats.buildings.total);
    mustElement('kpi-vehicles').textContent = numberFormat.format(sceneStats.instances.total);
    mustElement('kpi-alarms').textContent = numberFormat.format(sceneStats.points.byStatus[2]);
  }

  const clock = mustElement('clock');
  const updateClock = (): void => {
    clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  };
  updateClock();
  setInterval(updateClock, 1000);

  const LAYER_ROWS: Array<{ key: 'areas' | 'lines' | 'points' | 'instances' | 'alarms'; label: string; count: number }> = [
    { key: 'areas', label: '装置 / 建筑', count: sceneStats?.buildings.total ?? 0 },
    { key: 'lines', label: '厂区道路', count: sceneStats?.lines.total ?? 0 },
    { key: 'points', label: '测点', count: sceneStats?.points.total ?? 0 },
    { key: 'instances', label: '作业车辆', count: sceneStats?.instances.total ?? 0 },
    { key: 'alarms', label: '报警脉冲', count: sceneStats?.points.byStatus[2] ?? 0 },
  ];

  const layerList = mustElement('layer-list');
  const rowItems: Array<{ item: HTMLElement; key: typeof LAYER_ROWS[number]['key'] }> = [];
  for (const row of LAYER_ROWS) {
    const item = document.createElement('li');
    item.dataset.on = 'true';
    item.innerHTML = `<span class="box">✓</span><span>${row.label}</span>`
      + `<span class="count">${numberFormat.format(row.count)}</span>`;
    item.addEventListener('click', () => {
      const layer = layers[row.key];
      layer.visible = !layer.visible;
      item.dataset.on = String(layer.visible);
    });
    layerList.append(item);
    rowItems.push({ item, key: row.key });
  }
  syncRows = () => {
    for (const { item, key } of rowItems) item.dataset.on = String(layers[key].visible);
  };
  syncRows();

  const alarmList = mustElement('alarm-list');
  const toLngLat = makeLocalInverse(manifest.origin);

  const PULSE_MAX = 600;
  let alarmSource: Uint8Array | null = null;
  let pulseTimer = 0;

  const refreshPulses = (): void => {
    if (alarmSource === null) return;
    const host = mustElement('map');
    const width = host.clientWidth;
    const height = host.clientHeight;
    const source = new DataView(alarmSource.buffer, alarmSource.byteOffset, alarmSource.byteLength);
    const total = alarmSource.byteLength / 6;

    const inView: number[] = [];
    for (let i = 0; i < total; i++) {
      const x = source.getInt16(i * 6, true) * coords.quantum;
      const y = source.getInt16(i * 6 + 2, true) * coords.quantum;
      const [lng, lat] = toLngLat(x, y);
      const pixel = map.pointToPixel?.(new ns.Point(lng, lat));
      if (pixel === undefined) continue;
      if (pixel.x < -24 || pixel.y < -24 || pixel.x > width + 24 || pixel.y > height + 24) continue;
      inView.push(i);
    }

    const step = Math.max(1, Math.ceil(inView.length / PULSE_MAX));
    const out = new Uint8Array(Math.ceil(inView.length / step) * 6);
    let at = 0;
    for (let k = 0; k < inView.length; k += step) {
      const i = inView[k];
      out.set(alarmSource.subarray(i * 6, i * 6 + 6), at * 6);
      at += 1;
    }
    layers.alarms.set(out.subarray(0, at * 6));
  };

  const schedulePulses = (): void => {
    window.clearTimeout(pulseTimer);
    pulseTimer = window.setTimeout(refreshPulses, 120);
  };

  map.addEventListener('moveend', schedulePulses);
  map.addEventListener('zoomend', schedulePulses);

  if (sceneStats !== null) {
    const now = Date.now();
    sceneStats.alarms.slice(0, 12).forEach((alarm, index) => {
      const item = document.createElement('li');
      const spec = manifest.sensors[alarm.type];
      const zone = CAMPUS_THEME.classes[alarm.zone]?.label ?? '厂区';
      const at = new Date(now - index * 47000);
      const label = spec === undefined ? zone : `${spec.label} ${alarm.value} ${spec.unit}`;
      item.innerHTML = `<span class="lvl">报警</span><span class="zone">${label}</span>`
        + `<span class="t">${at.toTimeString().slice(0, 5)}</span>`;
      item.addEventListener('click', () => {
        const [lng, lat] = toLngLat(alarm.x, alarm.y);
        if (typeof map.setCenter === 'function') {
          map.setCenter(new ns.Point(lng, lat));
        } else {
          stats.errors.push('地图没有 setCenter，报警点了不会定位');
        }
        const hit: PickHit = {
          x: alarm.x,
          y: alarm.y,
          geom: GEOM.POINTS,
          attrs: [alarm.zone, 2, alarm.type, spec === undefined ? 0 : sensorByte(spec, alarm.value)],
        };
        markPoint(layers.overlay, coords, hit);
        const host = mustElement('map');
        popupAnchor.x = host.clientWidth / 2;
        popupAnchor.y = host.clientHeight * 0.45;
        showPopover(popover, popupAnchor.x, popupAnchor.y, detailHtml(hit, manifest.sensors) ?? '');
      });
      alarmList.append(item);
    });
  }

  let bootHidden = false;
  const hideBoot = (): void => {
    if (bootHidden) return;
    bootHidden = true;
    mustElement('boot').classList.add('gone');
  };

  const queued: ChunkMessage[] = [];
  let unroutedFeatures = 0;
  const ready = (): boolean => layers.points.isReady && layers.lines.isReady
    && layers.areas.isReady && layers.instances.isReady && layers.overlay.isReady;

  let instanceFirstId = -1;
  let instanceTotal = 0;

  const route = (chunk: ChunkMessage): void => {
    if (!ready()) {
      queued.push(chunk);
      return;
    }
    switch (chunk.geom) {
      case GEOM.POINTS:
        if (chunk.direct === undefined) throw new Error('点块缺少直通字节');
        layers.points.append(new Uint8Array(chunk.direct));
        return;
      case GEOM.INSTANCES: {
        if (chunk.direct === undefined) throw new Error('实例块缺少直通字节');
        const added = layers.instances.append(new Uint8Array(chunk.direct));
        if (instanceFirstId < 0) instanceFirstId = added.firstId;
        instanceTotal += added.count;
        return;
      }
      case GEOM.LINES:
        layers.lines.append(strokeOf(chunk));
        return;
      case GEOM.POLYGONS: {
        const fill = fillOf(chunk);
        layers.areas.appendFill(fill.vertices, fill.indices);
        layers.areas.appendStroke(strokeOf(chunk));
        return;
      }
      default:
        unroutedFeatures += chunk.features;
    }
  };

  const stats = {
    receivedBytes: 0,
    features: 0,
    done: null as null | { receivedBytes: number; features: number; elapsedMs: number },
    errors: [] as string[],
    hit: null as PickHit | null,
  };

  const pendingPicks: Array<(hit: PickHit | null) => void> = [];
  const pendingSelects: Array<(count: number) => void> = [];

  const feed = new DatasetFeed({
    onChunk: (chunk) => {
      harness?.noteFirstData();
      hideBoot();
      route(chunk);
    },
    onProgress: (receivedBytes, features) => {
      stats.receivedBytes = receivedBytes;
      stats.features = features;
      harness?.noteProgress(receivedBytes, features);
    },
    onDone: (done) => {
      stats.done = done;
      harness?.noteLoadDone(done);
    },
    onPick: (hit) => {
      stats.hit = hit;
      markPoint(layers.overlay, coords, hit);
      const html = detailHtml(hit, manifest.sensors);
      if (html === null) popover.style.display = 'none';
      else showPopover(popover, popupAnchor.x, popupAnchor.y, html);
      pendingPicks.shift()?.(hit);
    },
    onSelect: (count, _ids, points) => {
      const bytes = new Uint8Array(points);
      showPopover(popover, popupAnchor.x, popupAnchor.y, selectionHtml(count, bytes));
      layers.highlight.reset();
      if (bytes.byteLength > 0 && layers.highlight.isReady) {
        layers.highlight.append(bytes, true);
      }
      pendingSelects.shift()?.(count);
    },
    onAlarms: (points) => {
      const source = new Uint8Array(points);
      alarmSource = source;
      refreshPulses();

      const count = source.byteLength / 6;
      const dots = new Uint8Array(count * 8);
      for (let i = 0; i < count; i += 1) {
        dots[i * 8] = source[i * 6];
        dots[i * 8 + 1] = source[i * 6 + 1];
        dots[i * 8 + 2] = source[i * 6 + 2];
        dots[i * 8 + 3] = source[i * 6 + 3];
        dots[i * 8 + 4] = source[i * 6 + 4];
        dots[i * 8 + 5] = source[i * 6 + 5];
      }
      const paint = () => {
        if (layers.alarmDots.isReady) layers.alarmDots.append(dots, true);
        else window.setTimeout(paint, 300);
      };
      paint();
    },
    onError: (message) => {
      stats.errors.push(message);
      harness?.noteError(message);
    },
  });

  const harness = recorder === null
    ? null
    : new BenchHarness(buildBenchContext(), recorder);

  function buildBenchContext (): BenchContext {
    const origin = manifest.origin;

    return {
      layers,
      coords,
      centerLngLat: [origin[0], origin[1]],
      dataset: {
        url: datasetUrl,
        quantum: manifest.quantum,
        counts: Object.fromEntries(
          Object.entries(manifest.geometries).map(([key, entry]) => [key, entry?.count ?? 0]),
        ),
      },
      instanceRange: () => ({
        firstId: instanceFirstId < 0 ? 0 : instanceFirstId,
        count: instanceFirstId < 0 ? 0 : instanceTotal,
      }),
      pointRanges: () => layers.points.drawnRanges(),
      pickOnce: (x, y, radiusM) => {
        const { promise, resolve } = Promise.withResolvers<PickHit | null>();
        pendingPicks.push(resolve);
        feed.pickAt(x, y, radiusM, layers.points.drawnRanges());
        return promise;
      },
      selectOnce: (lng, lat, halfSpanDeg) => {
        const { promise, resolve } = Promise.withResolvers<number>();
        pendingSelects.push(resolve);
        feed.select(
          lng - halfSpanDeg,
          lat - halfSpanDeg,
          lng + halfSpanDeg,
          lat + halfSpanDeg,
          layers.points.drawnRanges(),
        );
        return promise;
      },
      stimulate: (phase) => {
        if (typeof map.setCenter !== 'function') return false;
        const radius = 0.0015;
        map.setCenter(new ns.Point(
          origin[0] + Math.cos(phase) * radius,
          origin[1] + Math.sin(phase) * radius,
        ));
        return true;
      },
      budget: {
        bytesPerSecond: Number.isFinite(budget.bytesPerSecond) ? budget.bytesPerSecond : Number.NaN,
        bytesPerFrame: Number.isFinite(budget.bytesPerFrame) ? budget.bytesPerFrame : Number.NaN,
      },
      lods: {
        point: Number.isFinite(layers.points.lodTarget) ? layers.points.lodTarget : Number.NaN,
        instance: Number.isFinite(layers.instances.lodTarget) ? layers.instances.lodTarget : Number.NaN,
      },
    };
  }

  const consoleEl = mustElement('console');
  const consoleBtn = mustElement('console-btn');
  consoleBtn.addEventListener('click', () => {
    consoleEl.dataset.open = consoleEl.dataset.open === 'true' ? 'false' : 'true';
  });

  const addOptions = (
    id: string,
    options: Array<[string, string]>,
    current: string,
    onChange: (value: string) => void,
  ): void => {
    const el = mustElement(id) as HTMLSelectElement;
    el.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    el.value = current;
    el.addEventListener('change', () => onChange(el.value));
  };

  const UNIT = 1024 * 1024;

  const syncUrl = (): void => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null): void => {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    };
    set('rate', budget.bytesPerSecond === Infinity ? 'off' : String(Math.round(budget.bytesPerSecond / UNIT)));
    set('frameBudget', budget.bytesPerFrame === Infinity ? 'off' : String(budget.bytesPerFrame / UNIT));
    set('lod', lodFixed === null ? null : lodFixed === Infinity ? 'off' : String(lodFixed));
    history.replaceState(null, '', url);
  };

  addOptions('c-net', [
    ['1', '1 MB/s'], ['2', '2 MB/s'], ['4', '4 MB/s'],
    ['8', '8 MB/s'], ['16', '16 MB/s'], ['48', '48 MB/s'], ['0', '不限'],
  ], netRate === Infinity ? '0' : String(Math.round(netRate / UNIT)), (value) => {
    const url = new URL(window.location.href);
    if (value === '0') url.searchParams.delete('netRate');
    else url.searchParams.set('netRate', value);
    history.replaceState(null, '', url);
  });

  addOptions('c-rate', [
    ['1', '1 MB/s'], ['2', '2 MB/s'], ['4', '4 MB/s'],
    ['8', '8 MB/s'], ['16', '16 MB/s'], ['48', '48 MB/s'], ['0', '不限'],
  ], budget.bytesPerSecond === Infinity ? '0' : String(Math.round(budget.bytesPerSecond / UNIT)), (value) => {
    budget.bytesPerSecond = value === '0' ? Infinity : Number(value) * UNIT;
    syncUrl();
  });

  addOptions('c-frame', [
    ['0.5', '0.5 MB'], ['1', '1 MB'], ['2', '2 MB'], ['4', '4 MB'], ['8', '8 MB'], ['0', '不限'],
  ], budget.bytesPerFrame === Infinity ? '0' : String(budget.bytesPerFrame / UNIT), (value) => {
    budget.bytesPerFrame = value === '0' ? Infinity : Number(value) * UNIT;
    syncUrl();
  });

  addOptions('c-lod', [
    ['auto', '自动（随缩放）'], ['3000', '3,000'], ['12000', '12,000'],
    ['30000', '30,000'], ['60000', '60,000'], ['off', '关闭'],
  ], lodFixed === null ? 'auto' : lodFixed === Infinity ? 'off' : String(lodFixed), (value) => {
    if (value === 'auto') {
      lodFixed = null;
      applyZoom();
      syncUrl();
      return;
    }
    lodFixed = value === 'off' ? Infinity : Number(value);
    layers.points.lodTarget = lodFixed;
    syncUrl();
  });

  addOptions('c-basemap', [
    ['light', '百度底图'], ['dark', '深色示意'],
  ], params.get('basemap') === 'dark' ? 'dark' : 'light', (value) => {
    if (typeof map.setMapStyleV2 !== 'function') return;
    map.setMapStyleV2(value === 'dark' ? SCHEMATIC_STYLE : { styleJson: [] });
    const url = new URL(window.location.href);
    if (value === 'dark') url.searchParams.set('basemap', 'dark');
    else url.searchParams.delete('basemap');
    history.replaceState(null, '', url);
  });

  addOptions('c-alarms', [
    ['on', '显示'], ['off', '隐藏'],
  ], layers.alarms.visible ? 'on' : 'off', (value) => {
    layers.alarms.visible = value === 'on';
    syncRows();
  });

  mustElement('c-reload').addEventListener('click', () => {
    window.location.reload();
  });

  feed.start(baseUrl, manifest, Number.isFinite(netRate) ? netRate : null);
  bindPick(map, layers, feed);

  globalThis.__cascade = {
    layers,
    feed,
    map,
    coords,
    center: [manifest.origin[0], manifest.origin[1]],
  };

  let frames = 0;
  let fps = 0;
  let lastFpsAt = performance.now();
  let lastHudAt = 0;
  let benchStarted = false;

  const pendingUploadBytes = (): number =>
    layers.points.pendingBytes + layers.lines.pendingBytes
    + layers.areas.pendingBytes + layers.instances.pendingBytes;

  const runBench = async (): Promise<void> => {
    if (harness === null) return;
    harness.noteUploadDrained();
    try {
      await harness.runScenarios({
        updatePerFrame: benchSize(params.get('bu'), 2000),
        updateFrames: benchSize(params.get('bf'), 60),
        queries: benchSize(params.get('bq'), 200),
        interactionFrames: benchSize(params.get('bi'), 120),
        attributionFrames: benchSize(params.get('ba'), 24),
        idleFrames: benchSize(params.get('bidle'), 40),
      });
    } catch (error: unknown) {
      harness.noteError(error instanceof Error ? error.message : String(error));
    }
    const result = harness.result();
    globalThis.__bench = {
      result: () => result,
      json: () => JSON.stringify(result, null, 2),
    };
    try {
      localStorage.setItem(`cascade.bench:${params.get('run') ?? 'default'}`, JSON.stringify(result));
    } catch {
    }
    console.log('[bench]', JSON.stringify(result));
  };

  const tick = (now: number): void => {
    budget.newFrame();
    recorder?.tick(now);

    if (queued.length > 0 && ready()) {
      for (const chunk of queued) route(chunk);
      queued.length = 0;
    }

    if (harness !== null && !benchStarted && stats.done !== null && pendingUploadBytes() === 0) {
      benchStarted = true;
      void runBench();
    }

    frames += 1;
    if (now - lastFpsAt >= 1000) {
      fps = (frames * 1000) / (now - lastFpsAt);
      frames = 0;
      lastFpsAt = now;
    }

    if (now - lastHudAt >= 250) {
      lastHudAt = now;
      updateHud(hud, {
        layers,
        fps,
        unroutedFeatures,
        queuedChunks: queued.length,
        stats,
        bench: harness === null
          ? null
          : { enabled: true, running: benchStarted && globalThis.__bench === undefined },
      });
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener('beforeunload', () => {
    recorder?.stop();
    feed.dispose();
    for (const layer of Object.values(layers)) layer.dispose();
  });
}

function markPoint (overlay: OverlayLayer, coords: Coords, hit: PickHit | null): void {
  if (hit === null) {
    overlay.set(new Uint8Array(0));
    return;
  }
  const [qx, qy] = coords.quantize(hit.x, hit.y);
  const buffer = new Uint8Array(6);
  const view = new DataView(buffer.buffer);
  view.setInt16(0, qx, true);
  view.setInt16(2, qy, true);
  view.setUint8(4, hit.attrs[0] ?? 0);
  view.setUint8(5, hit.attrs[1] ?? 0);
  overlay.set(buffer);
}

function bindPick (map: BMapGLMap, layers: Layers, feed: DatasetFeed): void {
  const host = mustElement('map');
  const marquee = mustElement('marquee');
  const button = mustElement('box-btn');
  let from: { x: number; y: number } | null = null;
  let settledAt = 0;
  let boxing = false;

  const setBoxing = (on: boolean): void => {
    boxing = on;
    button.dataset.on = String(on);
    host.style.cursor = on ? 'crosshair' : '';
    if (on) map.disableDragging?.();
    else map.enableDragging?.();
  };

  button.addEventListener('click', () => setBoxing(!boxing));

  const paint = (x: number, y: number): void => {
    if (from === null) return;
    marquee.style.left = `${Math.min(from.x, x)}px`;
    marquee.style.top = `${Math.min(from.y, y)}px`;
    marquee.style.width = `${Math.abs(x - from.x)}px`;
    marquee.style.height = `${Math.abs(y - from.y)}px`;
  };

  const radiusAt = (pixel: { x: number; y: number }): number => {
    const a = map.pixelToPoint?.(pixel);
    const b = map.pixelToPoint?.({ x: pixel.x + PICK_RADIUS_PX, y: pixel.y });
    if (a === undefined || b === undefined) return 40;
    const [ax, ay] = llToMc(a.lng, a.lat);
    const [bx, by] = llToMc(b.lng, b.lat);
    return Math.hypot(bx - ax, by - ay);
  };

  map.addEventListener('click', (event) => {
    if (boxing || performance.now() - settledAt < 300) return;
    popupAnchor.x = event.pixel.x;
    popupAnchor.y = event.pixel.y;
    feed.pick(
      event.point.lng,
      event.point.lat,
      radiusAt(event.pixel),
      layers.points.drawnRanges(),
    );
  });

  const block = (event: MouseEvent): boolean => {
    if (event.button !== 0) return false;
    if (!boxing && !event.shiftKey) return false;
    event.stopPropagation();
    event.preventDefault();
    return true;
  };

  const start = (clientX: number, clientY: number): void => {
    const rect = host.getBoundingClientRect();
    from = { x: clientX - rect.left, y: clientY - rect.top };
    marquee.style.display = 'block';
    paint(from.x, from.y);
  };

  const move = (clientX: number, clientY: number): void => {
    if (from === null) return;
    const rect = host.getBoundingClientRect();
    paint(clientX - rect.left, clientY - rect.top);
  };

  const end = (clientX: number, clientY: number): void => {
    if (from === null) return;
    const rect = host.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const anchor = from;
    from = null;
    marquee.style.display = 'none';
    if (Math.abs(x - anchor.x) < 8 || Math.abs(y - anchor.y) < 8) return;

    const a = map.pixelToPoint?.({ x: anchor.x, y: anchor.y });
    const b = map.pixelToPoint?.({ x, y });
    if (a === undefined || b === undefined) return;

    settledAt = performance.now();
    if (boxing) setBoxing(false);
    popupAnchor.x = (anchor.x + x) / 2;
    popupAnchor.y = (anchor.y + y) / 2;
    feed.select(
      Math.min(a.lng, b.lng),
      Math.min(a.lat, b.lat),
      Math.max(a.lng, b.lng),
      Math.max(a.lat, b.lat),
      layers.points.drawnRanges(),
    );
  };

  host.addEventListener('pointerdown', (event) => {
    if (block(event)) start(event.clientX, event.clientY);
  }, { capture: true });

  host.addEventListener('mousedown', (event) => {
    if (block(event) && from === null) start(event.clientX, event.clientY);
  }, { capture: true });

  window.addEventListener('pointermove', (event) => { move(event.clientX, event.clientY); });
  window.addEventListener('pointerup', (event) => { end(event.clientX, event.clientY); });
  window.addEventListener('mousemove', (event) => { move(event.clientX, event.clientY); });
  window.addEventListener('mouseup', (event) => { end(event.clientX, event.clientY); });
}

interface HudState {
  layers: Layers;
  fps: number;
  unroutedFeatures: number;
  queuedChunks: number;
  bench: { enabled: boolean; running: boolean } | null;
  stats: {
    receivedBytes: number;
    features: number;
    done: null | { receivedBytes: number; features: number; elapsedMs: number };
    errors: string[];
    hit: PickHit | null;
  };
}

function updateHud (hud: HTMLElement, state: HudState): void {
  const { layers, stats } = state;
  const lines: string[] = [];

  if (stats.done === null) {
    lines.push(`<b>加载中</b>  ${formatBytes(stats.receivedBytes)} / ${stats.features.toLocaleString('en-US')} 要素`);
  } else {
    const { receivedBytes, features, elapsedMs } = stats.done;
    lines.push(`<b>加载完成</b>  ${formatBytes(receivedBytes)} / ${features.toLocaleString('en-US')} 要素 / ${(elapsedMs / 1000).toFixed(2)} s`);
  }

  const calls = layers.points.lastDrawCalls + layers.lines.lastDrawCalls
    + layers.areas.lastDrawCalls + layers.instances.lastDrawCalls + layers.overlay.lastDrawCalls;

  lines.push(
    `帧率        <b>${state.fps.toFixed(1)}</b>`,
    `绘制批次    <b>${calls}</b>`,
    `已绘制      测点 ${layers.points.lastDrawn.toLocaleString('en-US')}`,
    `            道路 ${layers.lines.lastDrawn.toLocaleString('en-US')} · 装置 ${layers.areas.lastDrawn.toLocaleString('en-US')}`,
    `            车辆 ${layers.instances.lastDrawn.toLocaleString('en-US')}`,
    `显存占用    ${formatBytes(
      Object.values(layers).reduce((total, layer) => total + layer.gpuBytes, 0),
    )}`,
    `待上传      ${formatBytes(
      layers.points.pendingBytes + layers.lines.pendingBytes
      + layers.areas.pendingBytes + layers.instances.pendingBytes,
    )}`,
  );

  if (state.queuedChunks > 0) lines.push(`排队中的块   ${state.queuedChunks}`);
  if (!layers.instances.available) lines.push('<span class="bad">实例化扩展不可用</span>');
  if (state.unroutedFeatures > 0) {
    lines.push(`<span class="bad">未接图层     ${state.unroutedFeatures.toLocaleString('en-US')} 要素</span>`);
  }

  if (state.bench !== null) {
    lines.push(
      state.bench.running
        ? '<b>基准运行中…</b>（跑完会写进控制台）'
        : '<b>基准已就绪</b>，加载完成后自动开跑',
    );
  }

  if (stats.done !== null && state.bench === null) {
    lines.push('<span class="hint">点击查询测点 · Shift+拖拽框选</span>');
  }

  for (const error of stats.errors.slice(-2)) lines.push(`<span class="bad">${error}</span>`);
  for (const layer of Object.values(layers)) {
    for (const error of layer.errors.slice(-1)) lines.push(`<span class="bad">${error}</span>`);
  }

  hud.innerHTML = lines.join('\n');
}

boot().catch((error: unknown) => {
  const hud = document.getElementById('hud');
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (hud !== null) hud.innerHTML = `<span class="bad">启动失败：${message}</span>`;
  document.getElementById('boot')?.classList.add('gone');
  console.error(error);
});
