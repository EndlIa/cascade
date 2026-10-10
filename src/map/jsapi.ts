
export interface RawContext {
  gl: WebGLRenderingContext;
  getMVPMatrix: () => Float32Array;
  _mvp32?: Float32Array;
  getZoom: () => number;
  getPixelRatio: () => number;
  getUnitsPerPixel: () => number;
  getSize: () => { width: number; height: number };
}

export interface BMGLayerOptions {
  vertexShader: string;
  fragmentShader: string;
  unsafeGL?: boolean;
  referCenter: unknown;
  zIndex?: number;
  onRender?: (ctx: RawContext) => void;
  onDestroy?: () => void;
  onError?: (error: unknown) => void;
}

export interface BMGLayerHandle {
  triggerRepaint: () => void;
}

export interface BMapGLPoint {
  lng: number;
  lat: number;
}

export interface MapMouseEvent {
  point: BMapGLPoint;
  pixel: { x: number; y: number };
  button?: number;
}

export type MapMouseEventName = 'click' | 'mousedown' | 'mousemove' | 'mouseup' | 'moveend' | 'zoomend';

export interface BMapGLMap {
  addLayer: (layer: unknown) => void;
  removeLayer: (layer: unknown) => void;
  centerAndZoom: (center: unknown, zoom: number) => void;
  getZoom: () => number;
  enableScrollWheelZoom: (enable?: boolean) => void;
  disableDragging?: () => void;
  enableDragging?: () => void;
  pixelToPoint?: (pixel: { x: number; y: number }) => BMapGLPoint;
  pointToPixel?: (point: BMapGLPoint) => { x: number; y: number };
  setCenter?: (center: unknown) => void;
  setMapStyleV2?: (style: unknown) => void;
  addEventListener: (name: MapMouseEventName, handler: (event: MapMouseEvent) => void) => void;
  removeEventListener: (name: MapMouseEventName, handler: (event: MapMouseEvent) => void) => void;
}

export interface BMapGLNamespace {
  Point: new (lng: number, lat: number) => BMapGLPoint;
  Map: new (container: string | HTMLElement, options?: Record<string, unknown>) => BMapGLMap;
  WebGLCustomLayer: new (options: BMGLayerOptions) => BMGLayerHandle;
}

declare global {
  // eslint-disable-next-line no-var
  var BMapGL: unknown;
}

function isBMapGLNamespace (value: unknown): value is BMapGLNamespace {
  if (typeof value !== 'object' || value === null) return false;
  if (!('Point' in value) || !('Map' in value) || !('WebGLCustomLayer' in value)) return false;
  return typeof value.Point === 'function'
    && typeof value.Map === 'function'
    && typeof value.WebGLCustomLayer === 'function';
}

export function hasWebGLCustomLayer (): boolean {
  return isBMapGLNamespace(globalThis.BMapGL);
}

export function bmapGL (): BMapGLNamespace {
  const ns = globalThis.BMapGL;
  if (!isBMapGLNamespace(ns)) {
    throw new Error('BMapGL 未加载，或这个版本没有 WebGLCustomLayer（需要 ?v=4.0）');
  }
  return ns;
}
