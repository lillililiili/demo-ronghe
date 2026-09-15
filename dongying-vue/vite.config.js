import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalMapData } from './tools/map-data-server.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const mapManifest = directory => path.join(directory, 'dongying-dev', 'manifest.json');

function resolveMapDataDirectory() {
  const configured = process.env.MAP_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  const candidates = [
    path.resolve(rootDir, '../map-data'),
    path.resolve(rootDir, '../../map-data')
  ];
  return candidates.find(directory => existsSync(mapManifest(directory))) || candidates[0];
}

export default defineConfig(() => {
  return {
    resolve: {
      alias: {
        '@': path.join(rootDir, 'src')
      }
    },
    plugins: [
      vue(),
      externalMapData(resolveMapDataDirectory())
    ],
    // 旧高德 VITE_* 值不再暴露给浏览器；地图地址走独立静态配置。
    envPrefix: 'APP_PUBLIC_',
    server: {
      port: 5173,
      // 临时 Cloudflare Tunnel 的 Host 头；仍只允许该测试域，不放开任意来源。
      allowedHosts: ['.trycloudflare.com'],
      proxy: {
        '/api': {
          target: process.env.APP_API_PROXY_TARGET || 'http://127.0.0.1:8081',
          changeOrigin: true,
          // 公网隧道仍是浏览器与 Vite 的同源访问；不要把隧道域名作为跨域 Origin 转给本机后端。
          configure: proxy => proxy.on('proxyReq', request => request.removeHeader('origin'))
        }
      },
      // 历史瓦片仍留在仓库旁用于人工回滚，但不再参与运行时加载或文件监听。
      watch: { ignored: ['**/dongying-demo/assets/tiles/**'] }
    }
  };
});
