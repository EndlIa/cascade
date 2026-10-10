# 珞珈化工园区 · 安全与运行态势

基于百度地图 JSAPI `WebGLCustomLayer` 的海量空间数据流式渲染 Demo。

## 环境

- Node.js 20 或更高（用到 `node --test` 与 ESM）
- 百度地图 JavaScript API GL 的 AK

## 构建与运行

```bash
npm install
cp .env.example .env.local     # 填入百度地图 AK
npm run make                   # 生成数据集到 public/data/main（约 229 MB）
npm run dev                   
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run make` | 生成数据集：3000 万测点 / 900 装置 / 941 道路 / 5000 车辆 |
| `npm run make:big` | 生成更大的数据集：5000 万测点 |


