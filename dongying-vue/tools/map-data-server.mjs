import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import path from 'node:path';

const types = { '.json': 'application/json; charset=utf-8', '.pmtiles': 'application/vnd.pmtiles', '.pbf': 'application/x-protobuf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8' };
const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// 开发与 preview 共用；不遍历、不监听、不复制外置资源。
export function mapDataServer(directory) {
  let rootPromise;
  const immutableFiles = new Map();
  const resolveRoot = () => {
    if (!rootPromise) rootPromise = realpath(directory).catch(error => { rootPromise = null; throw error; });
    return rootPromise;
  };
  return async (req, res, next) => {
    const raw = (req.url || '').split('?')[0];
    if (!raw.startsWith('/map-data/')) return next();
    const finish = (code, message) => { res.statusCode = code; res.end(message); };
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return finish(405, 'Method not allowed'); }
    try {
      const name = decodeURIComponent(raw.slice('/map-data/'.length));
      if (/[\\\0:]/.test(name) || name.split('/').some(p => p === '..' || p.startsWith('.'))) return finish(403, 'Forbidden');
      const root = await resolveRoot();
      const candidate = path.resolve(root, name);
      if (!within(root, candidate)) return finish(403, 'Forbidden');
      const immutable = raw.startsWith('/map-data/packages/');
      let metadata = immutable ? immutableFiles.get(candidate) : null;
      if (!metadata) {
        const file = await realpath(candidate);
        if (!within(root, file)) return finish(403, 'Forbidden');
        const info = await stat(file);
        const mime = types[path.extname(file).toLowerCase()];
        metadata = { file, info, mime };
        if (immutable) immutableFiles.set(candidate, metadata);
      }
      const { file, info, mime } = metadata;
      if (!info.isFile() || !mime) return finish(404, 'Not found');
      const compressible = mime.includes('json') || mime.includes('protobuf') || mime.startsWith('text/');
      const gzip = compressible && info.size >= 1024 && !req.headers.range &&
        (req.headers['accept-encoding'] || '').split(',').some(value => {
          const [encoding, ...parameters] = value.trim().toLowerCase().split(';');
          const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='));
          return encoding === 'gzip' && (!quality || Number(quality.slice(2)) > 0);
        });
      res.setHeader('Content-Type', mime);
      if (compressible) res.setHeader('Vary', 'Accept-Encoding');
      if (gzip) res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      // Range 分段必须返回真实字节。对 PMTiles 回 304 时，Chrome 会把空正文或其它分段
      // 缓存当成当前分段，包头变成全 0，解析报 Wrong magic number。
      res.setHeader('Cache-Control', raw === '/map-data/control/map-config.json'
        ? 'no-store, max-age=0'
        : range
          ? 'no-store'
        : immutable
          ? 'public, max-age=31536000, immutable'
        : mime.includes('pmtiles') || mime.includes('protobuf') || mime.includes('font') || mime.startsWith('image/')
          ? 'public, max-age=600'
          : 'no-cache');
      const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}${gzip ? '-gzip' : ''}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', info.mtime.toUTCString());
      const ifNoneMatch = req.headers['if-none-match'];
      const unchanged = ifNoneMatch
        ? ifNoneMatch.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
        : req.headers['if-modified-since'] && Math.floor(info.mtimeMs / 1000) * 1000 <= Date.parse(req.headers['if-modified-since']);
      if (!range && raw !== '/map-data/control/map-config.json' && unchanged) {
        res.statusCode = 304;
        return res.end();
      }
      let start = 0, end = info.size - 1;
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
      if (!gzip) res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || !info.size) return res.end();
      const stream = createReadStream(file, { start, end });
      // JSON/PBF 按需压缩；Range 始终保持原始字节。pipeline 在断连时清理整个流链。
      pipeline(...(gzip ? [stream, createGzip(), res] : [stream, res]), () => {});
    } catch (error) {
      finish(error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 403, 'Map resource unavailable');
    }
  };
}

export function externalMapData(directory) {
  const attach = server => { server.middlewares.use(mapDataServer(directory)); };
  return { name: 'external-map-data', configureServer: attach, configurePreviewServer: attach };
}
