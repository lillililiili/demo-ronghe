// 挂载前注册桥接；经典 MapView 和业务页面不依赖具体引擎。
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { applyMapTheme, mapPalette, installThemeImages } from './mapTheme';
import { proceduralDemTile } from './proceduralTerrain';
let enginePromise;
const archives = new Map();
const MANAGED_CONFIG_URL = '/map-data/control/map-config.json';
const BUILTIN_CONFIG_URL = '/map-config.json';
let activeRuntimeKey = '';
let monitorStarted = false;

function localUrl(value, base = window.location.href) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('地图配置缺少资源地址');
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== window.location.origin) {
    throw new Error('地图资源必须通过同源内网静态地址提供');
  }
  return url.href;
}

async function json(url, signal, cache = 'no-cache', optional = false) {
  const response = await fetch(url, { signal, cache, redirect: 'error' });
  if (optional && response.status === 204) return null;
  if (!response.ok) {
    const error = new Error(`地图资源返回 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!(response.headers.get('Content-Type') || '').includes('json')) throw new Error('地图配置返回了网页而非 JSON，请重启开发服务或检查静态目录映射');
  return response.json();
}

function runtimeKey(config) {
  return `${config?.revision ?? 'builtin'}:${config?.package_id || config?.manifest || ''}`;
}

function preferLocalIdeographs(style) {
  // MapLibre 6 的 font-faces 优先于 localIdeographFontFamily。仅移除随包提供的
  // 完整中文后备字体，让 MapView 已配置的系统中文字体生效；保留其他语言/定制字体。
  const localRanges = new Set(['U+2E80-9FFF', 'U+F900-FAFF', 'U+FF00-FFEF']);
  for (const [stack, faces] of Object.entries(style['font-faces'] || {})) {
    const remaining = faces.filter(face => !(
      /\/NotoSansSC-Regular\.otf(?:[?#]|$)/.test(face.url) &&
      Array.isArray(face['unicode-range']) && face['unicode-range'].length > 0 &&
      face['unicode-range'].every(range => localRanges.has(range))
    ));
    if (remaining.length) style['font-faces'][stack] = remaining;
    else delete style['font-faces'][stack];
  }
  if (style['font-faces'] && !Object.keys(style['font-faces']).length) delete style['font-faces'];
}

async function readRuntimeConfig(signal) {
  const managedUrl = localUrl(MANAGED_CONFIG_URL);
  const builtinUrl = localUrl(BUILTIN_CONFIG_URL);
  // 默认配置很小，和后台指针并行读取；后台指针存在时仍优先使用它。
  // 先处理后备请求的拒绝，避免指针成功时出现无人接收的异步错误。
  const builtin = json(builtinUrl, signal).then(config => ({ config }), error => ({ error }));
  try {
    const config = await json(managedUrl, signal, 'no-cache', true);
    if (config) return { config, configUrl: managedUrl, managed: true };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }
  const result = await builtin;
  if (result.error) throw result.error;
  return { config: result.config, configUrl: builtinUrl, managed: false };
}

async function readMapManifest(signal) {
  const runtimeConfig = await readRuntimeConfig(signal);
  const manifestUrl = localUrl(runtimeConfig.config.manifest, runtimeConfig.configUrl);
  const manifest = await json(manifestUrl, signal, 'default');
  if (manifest.version !== 1 || manifest.coordinateSystem !== 'WGS84' || !manifest.archive || !manifest.style) {
    throw new Error('地图清单格式错误，需要 version=1 和 WGS84 数据');
  }
  return { runtimeConfig, manifest, manifestUrl, styleUrl: localUrl(manifest.style, manifestUrl) };
}

async function checkForRuntimeChange() {
  if (document.visibilityState === 'hidden') return;
  try {
    const response = await fetch(localUrl(MANAGED_CONFIG_URL), { cache: 'no-store', redirect: 'error' });
    if (!response.ok || response.status === 204) return;
    const config = await response.json();
    const key = runtimeKey(config);
    if (!activeRuntimeKey) { activeRuntimeKey = key; return; }
    if (key === activeRuntimeKey) return;
    activeRuntimeKey = key;
    window.dispatchEvent(new CustomEvent('offline-map:change', { detail: config }));
  } catch { /* 管理指针暂不可用时保持当前已加载地图。 */ }
}

function startRuntimeMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  window.setInterval(checkForRuntimeChange, 30000);
  window.addEventListener('focus', checkForRuntimeChange);
  document.addEventListener('visibilitychange', checkForRuntimeChange);
}

function loadEngine() {
  if (!enginePromise) {
    enginePromise = Promise.all([import('maplibre-gl'), import('pmtiles')]).then(([lib, pmtiles]) => {
      const maplibre = lib.default || lib;
      // 开发时使用同版本发行文件，避开内联源码映射；正式构建继续合并 Worker 模块。
      maplibre.setWorkerUrl(import.meta.env.DEV ? '/map-engine/maplibre-gl-worker.mjs' : workerUrl);
      const protocol = new pmtiles.Protocol();
      maplibre.addProtocol('pmtiles', protocol.tile);
      // 装饰性山影的高程瓦片在本机按噪声生成，不是网络源。
      maplibre.addProtocol('procdem', proceduralDemTile);
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
        const parents = [controller.signal, signal].filter(Boolean);
        const cancelled = () => parents.some(s => s.aborted);
        const read = async () => {
          if (cancelled()) throw new DOMException('Aborted', 'AbortError');
          const request = new AbortController();
          const abort = () => request.abort();
          parents.forEach(s => s.addEventListener('abort', abort, { once: true }));
          const timer = setTimeout(abort, 20000);
          try {
            const response = await fetch(url, {
              signal: request.signal,
              // Windows Chrome 会把同一 URL 的 Range 响应当成整文件缓存；必须跳过磁盘缓存。
              cache: 'no-store',
              headers: { Range: `bytes=${offset}-${offset + length - 1}` },
              redirect: 'error'
            });
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
            parents.forEach(s => s.removeEventListener('abort', abort));
          }
        };
        try {
          return await read();
        } catch (error) {
          // 缩放取消的请求不要重试；超时或瞬时失败再读一次。
          if (cancelled()) throw error;
          return await read();
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
  startRuntimeMonitor();
  // 清单和样式不依赖地图引擎；引擎下载期间直接推进资源链。
  const manifestTask = readMapManifest(signal);
  const styleTask = manifestTask.then(({ styleUrl }) => json(styleUrl, signal, 'default'));
  // 引擎失败或页面取消时也要接住已启动的样式请求；下面仍会正常抛出其错误。
  styleTask.catch(() => {});
  const [engine, resources] = await Promise.all([loadEngine(), manifestTask]);
  signal.throwIfAborted();
  const { runtimeConfig, manifest, manifestUrl, styleUrl } = resources;
  const { config } = runtimeConfig;
  activeRuntimeKey = runtimeKey(config);
  const url = localUrl(manifest.archive, manifestUrl);
  const lease = acquireArchive(engine, url);
  signal.addEventListener('abort', lease.release, { once: true });
  const release = () => { signal.removeEventListener('abort', lease.release); lease.release(); };
  try {
    // 样式文件和 PMTiles 头互不依赖，并行取得后再统一校验。
    const [style, header] = await Promise.all([
      styleTask,
      lease.archive.getHeader()
    ]);
    signal.throwIfAborted();
    if (style.version !== 8 || !style.sources?.protomaps || Object.keys(style.sources).length !== 1 || style.imports) {
      throw new Error('底图样式必须仅使用本地 protomaps 数据源');
    }
    const maxZoom = Number.isFinite(Number(manifest.maxZoom)) ? Number(manifest.maxZoom) : 15;
    style.sources.protomaps = {
      type: 'vector',
      url: `pmtiles://${url}`,
      attribution: '© OpenStreetMap contributors · Protomaps（开发数据）',
      minzoom: 0,
      // 包内只有到 Z15 的瓦片；声明 maxzoom 让引擎对 Z16–Z18 做过缩放，而不是去要没有的瓦片。
      maxzoom: maxZoom
    };
    const assetUrl = value => localUrl(value, styleUrl).replaceAll('%7B', '{').replaceAll('%7D', '}');
    if (style.glyphs) style.glyphs = assetUrl(style.glyphs);
    for (const faces of Object.values(style['font-faces'] || {})) {
      if (!Array.isArray(faces)) throw new Error('不支持的字体配置');
      faces.forEach(face => { face.url = assetUrl(face.url); });
    }
    preferLocalIdeographs(style);
    if (style.sprite) {
      if (typeof style.sprite !== 'string') throw new Error('不支持的图标清单格式');
      style.sprite = assetUrl(style.sprite);
    }
    if (header.tileType !== 1 || header.maxZoom < 15) throw new Error('地图包不是预期的 Z0–Z15 矢量数据');
    const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
    if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('地图包覆盖范围无效');
    // 影像瓦片是随包部署的静态目录，同源校验与其他资源一致；没有 imagery 字段就只画矢量。
    const imagery = manifest.imagery?.tiles ? {
      tiles: assetUrl(manifest.imagery.tiles), minzoom: manifest.imagery.minZoom ?? 7, maxzoom: manifest.imagery.maxZoom ?? 12,
      attribution: manifest.imagery.attribution || '', bounds
    } : null;
    return {
      maplibre: engine.maplibre, style: applyMapTheme(style, { imagery }), manifest, bounds, release,
      runtime: {
        managed: runtimeConfig.managed,
        revision: config.revision ?? null,
        packageId: config.package_id || '',
        cityCode: config.city_code || '370500',
        cityName: config.city_name || '东营市',
        clearBusinessOverlays: Boolean(config.clear_business_overlays)
      },
      decorate: installThemeImages,
      transformRequest: url => ({ url: url.startsWith('pmtiles://') || url.startsWith('procdem://') ? url : localUrl(url) })
    };
  } catch (error) { release(); throw error; }
}

window.OfflineMap = { prepare: prepareOfflineMap, palette: mapPalette };
