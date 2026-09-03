import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const types = { '.json': 'application/json; charset=utf-8', '.pmtiles': 'application/vnd.pmtiles', '.pbf': 'application/x-protobuf', '.png': 'image/png', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8' };
const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// 开发与 preview 共用；不遍历、不监听、不复制外置资源。
export function mapDataServer(directory) {
  return async (req, res, next) => {
    const raw = (req.url || '').split('?')[0];
    if (!raw.startsWith('/map-data/')) return next();
    const finish = (code, message) => { res.statusCode = code; res.end(message); };
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return finish(405, 'Method not allowed'); }
    try {
      const name = decodeURIComponent(raw.slice('/map-data/'.length));
      if (/[\\\0:]/.test(name) || name.split('/').some(p => p === '..' || p.startsWith('.'))) return finish(403, 'Forbidden');
      const root = await realpath(directory);
      const candidate = path.resolve(root, name);
      if (!within(root, candidate)) return finish(403, 'Forbidden');
      const file = await realpath(candidate);
      if (!within(root, file)) return finish(403, 'Forbidden');
      const info = await stat(file);
      const mime = types[path.extname(file).toLowerCase()];
      if (!info.isFile() || !mime) return finish(404, 'Not found');
      res.setHeader('Content-Type', mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
      const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
      res.setHeader('ETag', etag);
      let start = 0, end = info.size - 1;
      const range = req.headers.range;
      if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${info.size}`); return finish(416, 'Invalid range'); }
        if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
          res.setHeader('Content-Range', `bytes */${info.size}`); return finish(416, 'Invalid range');
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || !info.size) return res.end();
      const stream = createReadStream(file, { start, end });
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      finish(error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 403, 'Map resource unavailable');
    }
  };
}

export function externalMapData(directory) {
  const attach = server => { server.middlewares.use(mapDataServer(directory)); };
  return { name: 'external-map-data', configureServer: attach, configurePreviewServer: attach };
}
