import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const amapRuntimeConfig = {
    key: env.VITE_AMAP_KEY || '',
    // 安全密钥仅允许进入开发服务器响应，生产构建强制剔除。
    securityJsCode: mode === 'development' ? (env.VITE_AMAP_SECURITY_CODE || '') : '',
    serviceHost: env.VITE_AMAP_SERVICE_HOST || ''
  };
  return {
  plugins: [
    vue(),
    {
      name: 'amap-runtime-config',
      transformIndexHtml(html) {
        return html.replace('__AMAP_RUNTIME_CONFIG__', JSON.stringify(amapRuntimeConfig));
      }
    }
  ],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        bigscreen: path.resolve(__dirname, 'bigscreen.html')
      }
    }
  },
  server: {
    port: 5173,
    // 历史瓦片仍留在仓库旁用于人工回滚，但不再参与运行时加载或文件监听。
    watch: { ignored: ['**/dongying-demo/assets/tiles/**'] }
  }
  };
});
