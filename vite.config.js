import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import fs from 'node:fs';

/* 瓦片转发：1.5GB / 32 万张离线瓦片留在 dongying-demo 原地，不复制、不软链进
   publicDir（build 会把 32 万文件抄进 dist）。dev 与 preview 都挂同一个中间件，
   把 /assets/tiles/** 流式转发到旧目录。生产部署时按 README 用反向代理或挂载解决。 */
const TILES_ROOT = path.resolve(__dirname, '../dongying-demo/assets/tiles');
function tilesMiddleware() {
  return (req, res, next) => {
    if (!req.url || !req.url.startsWith('/assets/tiles/')) return next();
    const rel = decodeURIComponent(req.url.split('?')[0].slice('/assets/tiles/'.length));
    const file = path.join(TILES_ROOT, rel);
    // 越界防护：解析后必须仍在瓦片根目录内
    if (!file.startsWith(TILES_ROOT + path.sep)) { res.statusCode = 403; return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).pipe(res);
    });
  };
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'dongying-tiles-forward',
      configureServer(server) { server.middlewares.use(tilesMiddleware()); },
      configurePreviewServer(server) { server.middlewares.use(tilesMiddleware()); }
    }
  ],
  server: { port: 5173 }
});
