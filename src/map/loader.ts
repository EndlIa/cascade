import { hasWebGLCustomLayer } from './jsapi.ts';

const CALLBACK_NAME = '__cascadeJsapiReady';

declare global {
  // eslint-disable-next-line no-var
  var __cascadeJsapiReady: (() => void) | undefined;
}

const TIMEOUT_MS = 20000;

export async function loadJsapi (ak: string): Promise<void> {
  if (hasWebGLCustomLayer()) return;
  if (ak.trim() === '') {
    throw new Error('缺少百度地图 AK：用 ?ak=… 或写入 .env.local 的 VITE_BMAP_AK');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`JSAPI 加载超时（${TIMEOUT_MS} ms）`));
    }, TIMEOUT_MS);

    globalThis.__cascadeJsapiReady = () => {
      window.clearTimeout(timer);
      resolve();
    };

    const script = document.createElement('script');
    script.src = `https://api.map.baidu.com/api?v=4.0&ak=${encodeURIComponent(ak)}&callback=${CALLBACK_NAME}`;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('JSAPI 脚本加载失败（检查网络或 AK）'));
    };
    document.head.appendChild(script);
  });

  if (!hasWebGLCustomLayer()) {
    throw new Error('JSAPI 已加载但没有 WebGLCustomLayer —— 确认地址里带了 ?v=4.0');
  }
}
