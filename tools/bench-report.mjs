#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const THROTTLE_HZ = 20;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/bench-report.mjs <bench-*.json> …');
  process.exit(1);
}

const runs = files.map((file) => {
  try {
    return { file: basename(file), data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    console.error(`读不了 ${file}: ${error.message}`);
    process.exit(1);
  }
});

function problems (run) {
  const issues = [];
  const { load, idleRafHz, throttled, scenarios } = run.data;

  if (throttled || (idleRafHz > 0 && idleRafHz < THROTTLE_HZ)) {
    issues.push(`标签页被节流（空闲 rAF ${idleRafHz} Hz）⇒ 帧率与交互类指标不可采信`);
  }
  if (idleRafHz === 0) issues.push('没有采到 rAF 样本，帧率无法判定');
  if (load.frames.count < 10) {
    issues.push(`加载期只有 ${load.frames.count} 个帧样本（加载太快）⇒ 仅「加载期帧率」不可靠，其余指标不受影响`);
  }
  if (load.resource.count === 0) issues.push('Resource Timing 里没有数据请求，回源字节不可信');
  if (load.resource.transferSize === 0 && load.receivedBytes > 0) {
    issues.push('回源字节为 0 ⇒ 命中 HTTP 缓存，下载类指标不代表真实网络加载');
  }
  if (scenarios.update === null) issues.push('动态更新场景没有出数（实例图层可能没有数据）');
  if (scenarios.pick === null) issues.push('拾取场景没有出数（点图层可能没有已绘制区间）');
  else if (scenarios.pick.hits === 0) issues.push('拾取一次都没命中 ⇒ 查询目标选错了，耗时不可解释');
  if (scenarios.interaction === null) issues.push('交互场景没有出数（无法施加平移刺激）');
  if (scenarios.attribution === null) issues.push('归因场景没有出数（无法区分底图与本渲染层的开销）');
  if (run.data.errors.length > 0) issues.push(`运行期报错 ${run.data.errors.length} 条`);
  return issues;
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const mb = (bytes) => `${round(bytes / 1048576, 2)} MB`;

const bytes = (value) => {
  if (value >= 1048576) return `${round(value / 1048576, 2)} MB`;
  if (value >= 1024) return `${round(value / 1024, 1)} KB`;
  return `${value} B`;
};

const lines = [];
lines.push('# 性能基准报告');
lines.push('');
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push(`数据来源：${runs.map((r) => r.file).join('、')}`);
lines.push('');
lines.push('> 本报告由 `tools/bench-report.mjs` 从基准 JSON **直接生成**，不人工修订 ——');
lines.push('> 每个数字都能追溯到原始 JSON，判定（有效性、归因）也由数据推出而不是写死。');
lines.push('> 复现方式见仓库 README 的「性能基准」一节。');
lines.push('');
lines.push('本报告覆盖的指标：首屏时间（首数据）、加载速度、增量上传、三种查询延迟、');
lines.push('交互期帧率、加载期帧率、绘制规模、内存占用与主线程占用，以及**代价归因**。');
lines.push('');
lines.push('**明确不覆盖**的两项，原因是浏览器不给接口，而不是漏测：');
lines.push('');
lines.push('- **GPU 占用率**：WebGL1 上一般没有计时查询扩展，拿不到 GPU 时间。');
lines.push('  能反映 GPU 压力的替代量是绘制调用次数与每帧绘制规模（见「场景」一节）。');
lines.push('- **CPU 占用率**：浏览器不暴露本进程 CPU 时间。');
lines.push('  替代量是「主线程繁忙占比」（见「资源占用」一节），它低估真实占用，仅可横向比较。');
lines.push('');

lines.push('## 有效性');
lines.push('');
lines.push('| 记录 | 空闲 rAF | 各轮原始值 | 判定 | 问题 |');
lines.push('|---|---:|---|---|---|');
for (const run of runs) {
  const issues = problems(run);
  const rounds = (run.data.idleRounds ?? []).join(' / ') || '—';
  lines.push(
    `| ${run.file} | ${run.data.idleRafHz} Hz | ${rounds} | ${issues.length === 0 ? '**有效**' : '⚠️ 存疑'} | ${issues.length === 0 ? '—' : issues.join('；')} |`,
  );
}
lines.push('');

lines.push('## 环境');
lines.push('');
lines.push('| 记录 | 数据集 | 要素 | 数据量 | 量化 | 量程 | LOD(点/实例) | 限流(速率/每帧) |');
lines.push('|---|---|---:|---:|---:|---:|---|---|');
for (const run of runs) {
  const { meta } = run.data;
  const counts = Object.entries(meta.counts).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ');
  const rate = meta.budget.bytesPerSecond === null ? '不限' : `${round(meta.budget.bytesPerSecond / 1048576, 1)} MB/s`;
  const perFrame = meta.budget.bytesPerFrame === null ? '不限' : `${round(meta.budget.bytesPerFrame / 1048576, 2)} MB/帧`;
  lines.push(
    `| ${run.file} | ${meta.dataset} | ${counts} | ${mb(run.data.load.receivedBytes)} | ${meta.quantum} m | ±${meta.quantumRangeKm} km | ${meta.lods.point === null ? '∞' : meta.lods.point} / ${meta.lods.instance === null ? '∞' : meta.lods.instance} | ${rate} / ${perFrame} |`,
  );
}
lines.push('');
lines.push('| 记录 | WebGL | GPU | DPR |');
lines.push('|---|---|---|---:|');
for (const run of runs) {
  const { meta } = run.data;
  lines.push(`| ${run.file} | ${meta.webglVersion} | ${meta.gpu} | ${meta.devicePixelRatio} |`);
}
lines.push('');
lines.push('> 若 GPU 一列是软件光栅化实现（如含 `SwiftShader`），**绝对帧率不代表真实硬件**。');
lines.push('> 此时只读「代价归因」一节：它把底图本底与本渲染层的开销分开了，');
lines.push('> 那才是与代码有关的那个数。');
lines.push('');

lines.push('## 加载');
lines.push('');
lines.push('| 记录 | 首数据 | 总耗时 | 接收 | 回源 | 上传排空 | 加载期帧率 | 帧间隔 p95 | 加载窗内长任务(条/总/最长) |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
for (const run of runs) {
  const { load } = run.data;
  lines.push(
    `| ${run.file} | ${load.firstDataMs ?? '—'} ms | ${load.totalMs} ms | ${mb(load.receivedBytes)} | ${bytes(load.resource.transferSize)}（解码 ${mb(load.resource.encodedBodySize)}） | ${load.uploadDrainMs ?? '—'} ms | ${load.frames.fps} | ${load.frames.intervalP95Ms} ms | ${load.longTasks.count} 条 / ${round(load.longTasks.totalMs, 0)} ms / 最长 ${round(load.longTasks.maxMs, 0)} ms |`,
  );
}
lines.push('');
lines.push('> 「首数据」是第一个数据块到达的时刻 —— 首屏能出东西靠的是它，不是总耗时。');
lines.push('> 「上传排空」在限流被关掉时才有硬件含义；开着限流时它测的是限流配置本身。');
lines.push('> 「回源」是浏览器实际走网络的字节数。**本地开发服务器上它接近 0 且与缓存无关**；');
lines.push('> 冷启动 / 命中的对比必须在真实 HTTP 服务下量。几何文件由 Worker 拉取，');
lines.push('> 所以这一项由 Worker 侧上报 —— 主线程的 Resource Timing 看不到 Worker 的请求。');
lines.push('');

lines.push('## 代价归因');
lines.push('');
lines.push('> 底图的渲染开销与我们的代码无关。在软件光栅化环境里它单帧可能就到 200 ms 以上，');
lines.push('> 只报一个总帧率，读的人会把环境的账算到渲染层头上。所以这里强制连续重绘两遍 ——');
lines.push('> 一遍图层可见、一遍隐藏 —— 差额才是本渲染层的开销。');
lines.push('');
lines.push('| 记录 | 重绘·图层可见 | 重绘·图层隐藏(底图本底) | 本渲染层开销 |');
lines.push('|---|---:|---:|---:|');
for (const run of runs) {
  const a = run.data.scenarios.attribution;
  lines.push(a === null || a === undefined
    ? `| ${run.file} | — | — | — |`
    : `| ${run.file} | ${a.withLayersMs} ms | ${a.withoutLayersMs} ms | **${a.ourMsPerFrame} ms** |`);
}
lines.push('');

lines.push('## 资源占用');
lines.push('');
lines.push('> ⚠️ 浏览器**不提供** CPU / GPU 占用率接口。下表只写实测能拿到的量，');
lines.push('> 拿不到的如实标「—」，不编数：');
lines.push('> `主线程繁忙占比` = 长任务累计 ÷ 墙钟时间，**低估**真实占用（短任务不计入），仅可横向比较；');
lines.push('> GPU 时间需要计时查询扩展，WebGL1 上通常没有（见「可用」列）。');
lines.push('');
lines.push('| 记录 | JS 堆占用 | 堆上限 | 几何字节 | 主线程繁忙占比 | 全程长任务(条/总/最长) | GPU 计时可用 |');
lines.push('|---|---:|---:|---:|---:|---|---:|');
for (const run of runs) {
  const r = run.data.resources;
  const heap = r === undefined || r.jsHeap.usedBytes === null ? '—' : mb(r.jsHeap.usedBytes);
  const limit = r === undefined || r.jsHeap.limitBytes === null ? '—' : mb(r.jsHeap.limitBytes);
  const all = r?.longTasks === undefined
    ? '—'
    : `${r.longTasks.count} / ${round(r.longTasks.totalMs, 0)} ms / ${round(r.longTasks.maxMs, 0)} ms`;
  lines.push(
    `| ${run.file} | ${heap} | ${limit} | ${r === undefined ? '—' : mb(r.geometryBytes)} | ${r === undefined ? '—' : r.mainThreadBusyRatio} | ${all} | ${r === undefined ? '—' : (r.gpuTimer ? '可用' : '不可用')} |`,
  );
}
lines.push('');

lines.push('## 场景');
lines.push('');
lines.push('| 记录 | 动态更新（每帧 · 单次开销 · 上限 · 实测） | 拾取 (每次) | 框选 (每次/命中) | 交互期帧率 | 绘制调用 | 已绘制 |');
lines.push('|---|---|---|---|---|---:|---|');
for (const run of runs) {
  const { scenarios, drawCalls, drawn } = run.data;
  const u = scenarios.update;
  const update = u === null
    ? '—'
    : `${u.perFrame}/帧 · ${u.perUpdateUs} µs/次（上限 ${Math.round(1e6 / u.perUpdateUs).toLocaleString('en-US')}/秒）· 实测 ${round((u.perFrame * u.frames) / (u.wallMs / 1000), 0).toLocaleString('en-US')} 次/秒`;
  const pick = scenarios.pick === null
    ? '—'
    : `${scenarios.pick.perQueryMs} ms（命中 ${scenarios.pick.hits}/${scenarios.pick.queries}）`;
  const select = scenarios.select === null
    ? '—'
    : `${scenarios.select.perQueryMs} ms（命中 ${scenarios.select.lastCount}）`;
  const inter = scenarios.interaction === null ? '—' : `${scenarios.interaction.frames.fps} (刺激 ${scenarios.interaction.stimulated} 帧)`;
  lines.push(
    `| ${run.file} | ${update} | ${pick} | ${select} | ${inter} | ${drawCalls} | 点 ${drawn.points} · 线 ${drawn.segments} · 面 ${drawn.triangles} · 实例 ${drawn.instances} |`,
  );
}
lines.push('');
lines.push('> 「动态更新」的时间只算**更新调用本身**，不含等帧 —— 否则量到的是帧率而不是这条路径的开销。');
lines.push('> 表里因此有**两个速率，含义不同，不要混**：');
lines.push('> 「上限」由单次调用开销换算（`1 ÷ µs`），是这条路径本身的能力；');
lines.push('> 「实测」是总更新次数 ÷ 墙钟时间，**受帧率限制** —— 场景每帧只推一批，');
lines.push('> 帧率低的时候它远低于上限，两者相差多少正说明瓶颈在渲染而不在更新路径。');
lines.push('');

const gaps = [];
for (const run of runs) {
  for (const issue of problems(run)) {
    if (issue.startsWith('动态更新') || issue.startsWith('拾取') || issue.startsWith('交互')) {
      gaps.push(`${run.file}: ${issue}`);
    }
  }
}
if (gaps.length > 0) {
  lines.push('## 未取得数据的能力');
  lines.push('');
  for (const gap of gaps) lines.push(`- ${gap}`);
  lines.push('');
}

process.stdout.write(lines.join('\n'));
