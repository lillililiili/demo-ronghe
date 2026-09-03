// 挂载前注册桥接；经典 MapView 和业务页面不依赖具体引擎。
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
let enginePromise;
const archives = new Map();

function localUrl(value, base = window.location.href) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('地图配置缺少资源地址');
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== window.location.origin) {
    throw new Error('地图资源必须通过同源内网静态地址提供');
  }
  return url.href;
}

async function json(url, signal) {
  const response = await fetch(url, { signal, cache: 'no-cache', redirect: 'error' });
  if (!response.ok) throw new Error(`地图资源返回 HTTP ${response.status}`);
  if (!(response.headers.get('Content-Type') || '').includes('json')) throw new Error('地图配置返回了网页而非 JSON，请重启开发服务或检查静态目录映射');
  return response.json();
}

function loadEngine() {
  if (!enginePromise) {
    enginePromise = Promise.all([import('maplibre-gl'), import('pmtiles')]).then(([lib, pmtiles]) => {
      const maplibre = lib.default || lib;
      // v6 的 Worker 是独立 ESM；必须经过 Vite worker 管线合并其共享模块。
      maplibre.setWorkerUrl(workerUrl);
      const protocol = new pmtiles.Protocol();
      maplibre.addProtocol('pmtiles', protocol.tile);
      return { maplibre, pmtiles, protocol };
    }).catch(error => { enginePromise = null; throw error; });
  }
  return enginePromise;
}

// 验证每个 Range 响应，防止服务器忽略 Range 后下载整个包。
function acquireArchive(engine, url) {
  let entry = archives.get(url);
  if (!entry) {
    const controller = new AbortController();
    const source = {
      getKey: () => url,
      async getBytes(offset, length, signal, etag) {
        const request = new AbortController();
        const abort = () => request.abort();
        const signals = [controller.signal, signal].filter(Boolean);
        signals.forEach(s => s.addEventListener('abort', abort, { once: true }));
        if (signals.some(s => s.aborted)) request.abort();
        const timer = setTimeout(abort, 15000);
        try {
          const response = await fetch(url, { signal: request.signal, headers: { Range: `bytes=${offset}-${offset + length - 1}` }, cache: 'no-cache', redirect: 'error' });
          if (etag && response.headers.get('ETag') && response.headers.get('ETag') !== etag) {
            await response.body?.cancel();
            throw new engine.pmtiles.EtagMismatch('地图包已更新，请重新读取');
          }
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
          if (response.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) !== Math.min(offset + length, Number(range[3])) - 1) {
            await response.body?.cancel();
            throw new Error('地图服务器未正确支持 Range 分段读取（需要 HTTP 206）');
          }
          const data = await response.arrayBuffer();
          if (data.byteLength !== Number(range[2]) - offset + 1) throw new Error('地图分段数据长度不完整');
          return { data, etag: response.headers.get('ETag') || undefined };
        } finally {
          clearTimeout(timer);
          signals.forEach(s => s.removeEventListener('abort', abort));
        }
      }
    };
    const archive = new engine.pmtiles.PMTiles(source);
    entry = { archive, controller, users: 0 };
    archives.set(url, entry);
    engine.protocol.add(archive);
  }
  entry.users++;
  let released = false;
  return {
    archive: entry.archive,
    release() {
      if (released) return;
      released = true;
      if (--entry.users === 0) {
        entry.controller.abort();
        archives.delete(url);
        engine.protocol.tiles.delete(url);
      }
    }
  };
}

export async function prepareOfflineMap(signal) {
  const engine = await loadEngine();
  signal.throwIfAborted();
  const configUrl = localUrl('/map-config.json');
  const config = await json(configUrl, signal);
  const manifestUrl = localUrl(config.manifest, configUrl);
  const manifest = await json(manifestUrl, signal);
  if (manifest.version !== 1 || manifest.coordinateSystem !== 'WGS84' || !manifest.archive || !manifest.style) {
    throw new Error('地图清单格式错误，需要 version=1 和 WGS84 数据');
  }
  const styleUrl = localUrl(manifest.style, manifestUrl);
  const style = await json(styleUrl, signal);
  const url = localUrl(manifest.archive, manifestUrl);
  if (style.version !== 8 || !style.sources?.protomaps || Object.keys(style.sources).length !== 1 || style.imports) {
    throw new Error('底图样式必须仅使用本地 protomaps 数据源');
  }
  style.sources.protomaps = { type: 'vector', url: `pmtiles://${url}`, attribution: '© OpenStreetMap contributors · Protomaps（开发数据）' };
  const assetUrl = value => localUrl(value, styleUrl).replaceAll('%7B', '{').replaceAll('%7D', '}');
  if (style.glyphs) style.glyphs = assetUrl(style.glyphs);
  for (const faces of Object.values(style['font-faces'] || {})) {
    if (!Array.isArray(faces)) throw new Error('不支持的字体配置');
    faces.forEach(face => { face.url = assetUrl(face.url); });
  }
  if (style.sprite) {
    if (typeof style.sprite !== 'string') throw new Error('不支持的图标清单格式');
    style.sprite = assetUrl(style.sprite);
  }
  const lease = acquireArchive(engine, url);
  signal.addEventListener('abort', lease.release, { once: true });
  const release = () => { signal.removeEventListener('abort', lease.release); lease.release(); };
  try {
    const header = await lease.archive.getHeader();
    signal.throwIfAborted();
    if (header.tileType !== 1 || header.maxZoom < 15) throw new Error('地图包不是预期的 Z0–Z15 矢量数据');
    const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
    if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('地图包覆盖范围无效');
    return { maplibre: engine.maplibre, style, manifest, bounds, release, transformRequest: url => ({ url: url.startsWith('pmtiles://') ? url : localUrl(url) }) };
  } catch (error) { release(); throw error; }
}

window.OfflineMap = { prepare: prepareOfflineMap };
