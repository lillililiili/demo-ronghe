import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);
const require = createRequire(import.meta.url);
const files = new Set(['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']);

// 开发服务直接提供已安装库的发行文件，避免 Vite 给第三方 Worker 内联数 MB 的源码映射。
// 仅暴露固定的两个文件；正式构建仍走 Vite Worker 管线，不复制或改写依赖。
export function mapWorkerAssets() {
  const directory = path.dirname(require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs'));
  const cache = new Map();
  return {
    name: 'map-worker-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith('/map-engine/')) return next();
        const name = url.slice('/map-engine/'.length);
        if (!files.has(name)) { res.statusCode = 404; return res.end('Not found'); }
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD'); res.statusCode = 405; return res.end('Method not allowed');
        }
        try {
          const file = path.join(directory, name);
          const info = await stat(file);
          const version = `${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}`;
          let entry = cache.get(name);
          if (!entry || entry.version !== version) {
            const data = readFile(file).then(async identity => ({ identity, gzip: await compress(identity) }));
            entry = { version, data };
            cache.set(name, entry);
            data.catch(() => { if (cache.get(name) === entry) cache.delete(name); });
          }
          const zipped = (req.headers['accept-encoding'] || '').split(',').some(value => {
            const [encoding, ...parameters] = value.trim().toLowerCase().split(';');
            const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
            return encoding === 'gzip' && (!quality || Number(quality.slice(2)) > 0);
          });
          const etag = `"${version}${zipped ? '-gzip' : ''}"`;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('ETag', etag);
          if (zipped) res.setHeader('Content-Encoding', 'gzip');
          if ((req.headers['if-none-match'] || '').split(',').some(value => value.trim().replace(/^W\//, '') === etag)) {
            res.statusCode = 304; return res.end();
          }
          const data = (await entry.data)[zipped ? 'gzip' : 'identity'];
          res.setHeader('Content-Length', data.length);
          res.end(req.method === 'HEAD' ? undefined : data);
        } catch {
          // 依赖缺失保持真实失败，不回退 HTML，也不扩大静态目录访问范围。
          res.removeHeader?.('Content-Encoding');
          res.statusCode = 500; res.end('Map worker unavailable');
        }
      });
    }
  };
}
