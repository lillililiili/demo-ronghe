import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalMapData } from './tools/map-data-server.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(() => {
  return {
    resolve: {
      alias: {
        '@': path.join(rootDir, 'src')
      }
    },
    plugins: [
      vue(),
      externalMapData(process.env.MAP_DATA_DIR || path.resolve(rootDir, '../map-data'))
    ],
    // 旧高德 VITE_* 值不再暴露给浏览器；地图地址走独立静态配置。
    envPrefix: 'APP_PUBLIC_',
    server: {
      port: 5173,
      // 历史瓦片仍留在仓库旁用于人工回滚，但不再参与运行时加载或文件监听。
      watch: { ignored: ['**/dongying-demo/assets/tiles/**'] }
    }
  };
});
