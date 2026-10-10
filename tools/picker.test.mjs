
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickNearest, scanDrawn, selectInBox } from '../src/core/query/picker.ts';

function block (firstId, pts) {
  const coords = new Int16Array(pts.length * 4);
  const attrs = new Uint8Array(pts.length * 8);
  pts.forEach(([x, y, a, b, t = 0, r = 0], i) => {
    coords[i * 4] = x;
    coords[i * 4 + 1] = y;
    attrs[i * 8 + 4] = a;
    attrs[i * 8 + 5] = b;
    attrs[i * 8 + 6] = t;
    attrs[i * 8 + 7] = r;
  });
  return { firstId, count: pts.length, coords, attrs };
}

function row (firstId, xs, a = 1) {
  return block(firstId, xs.map((x) => [x, 0, a, 1]));
}

test('拾取：命中半径内最近的那个', () => {
  const blocks = [row(0, [0, 10, 20, 30])];
  const hit = pickNearest(blocks, 1, 22, 0, 100, Int32Array.from([0, 4]));
  assert.ok(hit);
  assert.equal(hit.id, 2, '距离 2 的那个应当胜过距离 8 的那个');
  assert.equal(hit.x, 20);
  assert.deepEqual(hit.attrs, [1, 1, 0, 0]);
});

test('拾取:带回测点类型与读数', () => {
  const blocks = [block(0, [[0, 0, 2, 2, 1, 200]])];
  const hit = pickNearest(blocks, 1, 0, 0, 100, Int32Array.from([0, 1]));
  assert.ok(hit);
  assert.deepEqual(hit.attrs, [2, 2, 1, 200], '分区、状态、类型、读数必须原样带回');
});

test('拾取：半径之外不给结果', () => {
  const blocks = [row(0, [0, 10, 20])];
  const hit = pickNearest(blocks, 1, 500, 0, 30, Int32Array.from([0, 3]));
  assert.equal(hit, null);
});

test('拾取：**没有画出来的点绝不会被命中**', () => {
  const blocks = [row(0, [0, 10, 20, 30, 40])];
  const drawn = Int32Array.from([0, 2]);

  const partial = pickNearest(blocks, 1, 20, 0, 100, drawn);
  assert.ok(partial);
  assert.equal(partial.id, 1, '只画了两个，就只能在这两个里找');

  const full = pickNearest(blocks, 1, 20, 0, 100, Int32Array.from([0, 5]));
  assert.ok(full);
  assert.equal(full.id, 2);
});

test('拾取：区间跨块时两端都能命中', () => {
  const blocks = [row(0, [0, 10]), row(2, [20, 30])];
  const ranges = Int32Array.from([1, 3]); // ids 1 与 2，各在一個块里

  const left = pickNearest(blocks, 1, 10, 0, 100, ranges);
  assert.ok(left);
  assert.equal(left.id, 1);

  const right = pickNearest(blocks, 1, 20, 0, 100, ranges);
  assert.ok(right);
  assert.equal(right.id, 2, '第二个块里的要素也要能被搜到');
});

test('拾取：量子换算参与距离计算', () => {
  const blocks = [block(0, [[100, 0, 1, 1]])];
  const ranges = Int32Array.from([0, 1]);

  assert.ok(pickNearest(blocks, 0.5, 50, 0, 1, ranges), '50 m 处应当命中');
  assert.equal(pickNearest(blocks, 0.5, 60, 0, 1, ranges), null, '60 m 处超出半径');
});

test('遍历：多个区间按顺序走，且每块只走一次', () => {
  const blocks = [row(0, [0, 1]), row(2, [2, 3]), row(4, [4, 5])];
  const seen = [];
  scanDrawn(Int32Array.from([0, 2, 3, 6]), blocks, (id) => seen.push(id));
  assert.deepEqual(seen, [0, 1, 3, 4, 5]);
});

test('遍历：空区间与倒置区间都不产生访问', () => {
  const blocks = [row(0, [0, 1, 2])];
  const seen = [];
  scanDrawn(Int32Array.from([1, 1, 3, 2]), blocks, (id) => seen.push(id));
  assert.deepEqual(seen, []);
});

test('框选：计数精确，列表受上限截断但计数不受影响', () => {
  const blocks = [row(0, [0, 5, 10, 15, 20, 25])];
  const ranges = Int32Array.from([0, 6]);

  const all = selectInBox(blocks, 1, -1, -1, 100, 1, ranges, 100);
  assert.equal(all.count, 6);
  assert.equal(all.ids.length, 6);

  const capped = selectInBox(blocks, 1, -1, -1, 100, 1, ranges, 2);
  assert.equal(capped.count, 6, '计数必须是精确值');
  assert.deepEqual(capped.ids, [0, 1], '列表只给前几个');
});

test('框选：只统计已绘制的那部分', () => {
  const blocks = [row(0, [0, 5, 10, 15, 20, 25])];
  const partial = selectInBox(blocks, 1, -1, -1, 100, 1, Int32Array.from([0, 3]), 100);
  assert.equal(partial.count, 3, '没画出来的不算');
});

test('框选：包围盒边界是闭区间', () => {
  const blocks = [row(0, [0, 10, 20])];
  const ranges = Int32Array.from([0, 3]);
  const result = selectInBox(blocks, 1, 0, 0, 20, 0, ranges, 10);
  assert.equal(result.count, 3, '贴着边界的那两个应当算在内');
});
