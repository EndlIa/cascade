
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Coords } from '../src/core/coords.ts';
import { UploadBudget } from '../src/core/gl/budget.ts';
import { PointLayer } from '../src/core/gl/pointLayer.ts';

const ATTRIBS = { a_pos: 0, a_attr: 1 };

class FakeGL {
  ARRAY_BUFFER = 0x8892;
  ELEMENT_ARRAY_BUFFER = 0x8893;
  DYNAMIC_DRAW = 0x88e8;
  STATIC_DRAW = 0x88e4;
  POINTS = 0;
  TRIANGLES = 4;
  SHORT = 0x1402;
  UNSIGNED_BYTE = 0x1401;
  UNSIGNED_SHORT = 0x1403;
  FLOAT = 0x1406;
  BLEND = 0x0be2;
  DEPTH_TEST = 0x0b71;
  SRC_ALPHA = 0x0302;
  ONE_MINUS_SRC_ALPHA = 0x0303;
  CURRENT_PROGRAM = 0x8b8d;

  program = { name: 'engine-program' };
  draws = [];

  #next = 1;
  #bound = 0;
  #buffers = new Map();

  createBuffer () {
    const id = this.#next++;
    this.#buffers.set(id, new Uint8Array(0));
    return id;
  }

  bindBuffer (_target, buffer) {
    this.#bound = buffer;
  }

  bufferData (_target, size) {
    this.#buffers.set(this.#bound, new Uint8Array(Number(size)));
  }

  bufferSubData (_target, offset, src) {
    const store = this.#buffers.get(this.#bound);
    if (store === undefined) throw new Error('写到未分配的缓冲');
    store.set(src, offset);
  }

  deleteBuffer (buffer) {
    this.#buffers.delete(buffer);
  }

  getParameter (name) {
    return name === this.CURRENT_PROGRAM ? this.program : null;
  }

  getAttribLocation (_program, name) {
    return ATTRIBS[name] ?? -1;
  }

  getUniformLocation (_program, name) {
    return { name };
  }

  drawArrays (mode, first, count) {
    this.draws.push({ mode, first, count });
  }

  read (buffer) {
    return this.#buffers.get(buffer);
  }

  onlyBuffer () {
    return [...this.#buffers.entries()][0];
  }

  uniform1f () {}
  uniformMatrix4fv () {}
  enableVertexAttribArray () {}
  disableVertexAttribArray () {}
  vertexAttribPointer () {}
  vertexAttrib1f () {}
  enable () {}
  disable () {}
  blendFunc () {}
  useProgram () {}
}

function fakeMap () {
  return {
    added: 0,
    addLayer () { this.added += 1; },
    removeLayer () {},
    centerAndZoom () {},
    getZoom () { return 16; },
    enableScrollWheelZoom () {},
    addEventListener () {},
    removeEventListener () {},
  };
}

const THEME = {
  classAxisLabel: '分类',
  modifierAxisLabel: '状态',
  background: [0, 0, 0],
  classes: [{ label: '一', color: [1, 0, 0], size: 5 }],
  modifiers: [{ label: '常规', tint: [0.5, 0.5, 0.5], amount: 0, scale: 1 }],
};

function mount () {
  let captured = null;
  let handle = null;

  globalThis.BMapGL = {
    Point: class { constructor (lng, lat) { this.lng = lng; this.lat = lat; } },
    Map: class {},
    WebGLCustomLayer: class {
      constructor (options) {
        captured = options;
        this.repaints = 0;
        handle = this;
      }

      triggerRepaint () {
        this.repaints += 1;
      }
    },
  };

  const gl = new FakeGL();
  const map = fakeMap();
  const layer = new PointLayer({
    map,
    coords: new Coords([116.506, 39.795], 0.21),
    budget: new UploadBudget({ bytesPerSecond: Infinity, bytesPerFrame: Infinity }),
    theme: THEME,
  });
  layer.attach();

  return {
    gl,
    map,
    layer,
    frame () { captured.onRender({ gl }); },
    repaints: () => handle.repaints,
    options: () => captured,
  };
}

function points (firstId, count) {
  const bytes = new Uint8Array(count * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    view.setInt16(i * 8, firstId + i, true);
    view.setInt16(i * 8 + 2, firstId + i, true);
    view.setUint8(i * 8 + 4, 0);
    view.setUint8(i * 8 + 5, 0);
  }
  return bytes;
}

test('图层：挂载时把着色器源码和 onRender 交给引擎', () => {
  const m = mount();
  assert.equal(m.map.added, 1, '应当被 addLayer 一次');
  const options = m.options();
  assert.ok(options.vertexShader.includes('u_mvpMatrix'), '必须声明内建 uniform');
  assert.ok(options.fragmentShader.length > 0);
  assert.equal(options.unsafeGL, true);
  assert.ok(options.referCenter.lng !== undefined, 'referCenter 要是 Point 实例');
});

test('图层：首帧用引擎绑定的 program 初始化，而不是自己造一个', () => {
  const m = mount();
  assert.throws(() => m.layer.append(points(0, 1)), /尚未就绪/);

  m.frame();
  assert.equal(m.layer.isReady, true);

  const result = m.layer.append(points(0, 10));
  assert.deepEqual(result, { firstId: 0, count: 10 }, 'append 必须交出 id 区间');
});

test('图层：一帧之内上传、绘制，并报出绘制调用数', () => {
  const m = mount();
  m.frame();
  m.layer.append(points(0, 100));

  m.frame();
  assert.equal(m.layer.uploaded, 100, '应当上传了 100 个点');
  assert.equal(m.layer.lastDrawCalls, 1, '100 个点装得下一块，只该一次绘制');
  assert.equal(m.gl.draws.length, 1);
  assert.equal(m.gl.draws[0].count, 100);
  assert.equal(m.gl.draws[0].mode, m.gl.POINTS);
});

test('图层：额度不够时先画已上传的部分，剩下的下次继续', () => {
  const gl = new FakeGL();
  let captured = null;
  globalThis.BMapGL = {
    Point: class {},
    Map: class {},
    WebGLCustomLayer: class {
      constructor (options) { captured = options; }
      triggerRepaint () {}
    },
  };

  const budget = new UploadBudget({ bytesPerSecond: Infinity, bytesPerFrame: 80 });
  const layer = new PointLayer({
    map: fakeMap(),
    coords: new Coords([116.506, 39.795], 0.21),
    budget,
    theme: THEME,
  });
  layer.attach();

  captured.onRender({ gl });
  layer.append(points(0, 100));

  budget.newFrame();
  captured.onRender({ gl });
  assert.equal(layer.uploaded, 10, '一帧只该传 10 个点');
  assert.equal(layer.lastDrawCalls, 1, '剩下的没传完也要照画已上传的那部分');

  budget.newFrame();
  captured.onRender({ gl });
  assert.equal(layer.uploaded, 20, '下一帧接着传');

  for (let i = 0; i < 10; i++) {
    budget.newFrame();
    captured.onRender({ gl });
  }
  assert.equal(layer.uploaded, 100, '最终应当全部传完');
  assert.equal(layer.pendingBytes, 0);
});

test('就地改坐标：字节落在正确位置，并且请求了重绘', () => {
  const m = mount();
  m.frame();
  m.layer.append(points(0, 10));
  m.frame();

  const [bufferId] = m.gl.onlyBuffer();
  const before = Array.from(m.gl.read(bufferId).subarray(1 * 8, 1 * 8 + 8));
  const repaintsBefore = m.repaints();

  const calls = m.layer.updatePositions([1], new Int16Array([-1234]), new Int16Array([5678]));
  assert.equal(calls, 1);

  const after = Array.from(m.gl.read(bufferId).subarray(1 * 8, 1 * 8 + 8));
  assert.notDeepEqual(after, before, '坐标应当被改写');
  assert.equal(after[4], before[4], '属性字节不该被动');
  assert.equal(after[5], before[5], '属性字节不该被动');

  const view = new DataView(m.gl.read(bufferId).buffer, 1 * 8, 8);
  assert.equal(view.getInt16(0, true), -1234);
  assert.equal(view.getInt16(2, true), 5678);

  assert.ok(m.repaints() > repaintsBefore, '改完坐标必须请求重绘');
});

test('就地改属性：只动指定的那几个字节，不碰隔壁要素', () => {
  const m = mount();
  m.frame();
  m.layer.append(points(0, 10));
  m.frame();

  const [bufferId] = m.gl.onlyBuffer();
  const calls = m.layer.updateAttributes([2, 3], 4, 2, new Uint8Array([9, 9, 7, 7]));
  assert.equal(calls, 2, '部分改写不能合并 —— 合并会跨过坐标字节写到隔壁去');

  const store = m.gl.read(bufferId);
  assert.equal(store[2 * 8 + 4], 9);
  assert.equal(store[3 * 8 + 4], 7);
  assert.equal(store[0 * 8 + 4], 0, '没点到的要素不该被动');
});

test('回收：dispose 之后缓冲被释放', () => {
  const m = mount();
  m.frame();
  m.layer.append(points(0, 10));
  m.frame();
  const [bufferId] = m.gl.onlyBuffer();
  assert.ok(m.gl.read(bufferId) !== undefined);

  m.layer.dispose();
  assert.equal(m.gl.read(bufferId), undefined, 'GL 缓冲必须显式释放');
});

test('开关：切换 visible 立刻请求重绘，值没变则不动', () => {
  const m = mount();
  m.frame();
  m.layer.append(points(0, 10));
  m.frame();
  const before = m.repaints();

  m.layer.visible = false;
  assert.equal(m.layer.visible, false);
  assert.equal(m.repaints(), before + 1, '隐藏必须立刻请求重绘');
  assert.equal(m.layer.lastDrawCalls, 0, '隐藏后绘制调用数要立刻归零');

  m.layer.visible = false;
  assert.equal(m.repaints(), before + 1, '值没变不该重复请求重绘');

  m.layer.visible = true;
  assert.equal(m.repaints(), before + 2, '重新显示也要请求重绘');
});

test('开关：不可见时 pump 不产生绘制调用', () => {
  const m = mount();
  m.frame();
  m.layer.append(points(0, 10));
  m.frame();
  assert.equal(m.gl.draws.length, 1);

  m.layer.visible = false;
  m.frame();
  assert.equal(m.gl.draws.length, 1, '隐藏后不能再向引擎提交绘制');
  assert.equal(m.layer.lastDrawCalls, 0);
  assert.equal(m.layer.lastDrawn, 0);

  m.layer.visible = true;
  m.frame();
  assert.equal(m.gl.draws.length, 2, '重新显示后恢复绘制');
  assert.equal(m.layer.lastDrawCalls, 1);
});
