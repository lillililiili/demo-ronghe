import '../../dongying-vue/src/assets/css/tokens.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import { prepareOfflineMap } from '../../dongying-vue/src/services/offlineMap.js';

// Keep version-1 saved scenes and MQTT positions unchanged. x/y are storage
// coordinates, never screen pixels; only MapLibre projects the WGS84 positions.
const coordinates = p => [118.56 + p[0] * .00012, 37.50 - p[1] * .00012];
const stored = p => [(p.lng - 118.56) / .00012, (37.50 - p.lat) / .00012];
const overlay = document.querySelector('#map');
const notice = document.querySelector('#map-status');
let map, controller, resources, generation = 0, resize;
function redraw() {
  const { width, height } = document.querySelector('#map-stage').getBoundingClientRect();
  overlay.setAttribute('viewBox', `0 0 ${Math.max(1, width)} ${Math.max(1, height)}`);
  window.dispatchEvent(new Event('simulator-map:render'));
}
function showError(message) {
  notice.hidden = false;
  notice.querySelector('span').textContent = message;
}
const bridge = window.SimulatorMap = {
  ready: false,
  project(point) {
    const p = map.project(coordinates(point));
    return [p.x, p.y];
  },
  zoom(delta) { if (this.ready) map.zoomTo(map.getZoom() + delta, { duration: 200 }); },
  fit(points) {
    if (!this.ready || !points.length) return;
    const coords = points.map(coordinates).filter(p => p.every(Number.isFinite));
    if (!coords.length) return;
    const lngs = coords.map(p => p[0]), lats = coords.map(p => p[1]);
    const padding = Math.min(70, map.getContainer().clientWidth / 5, map.getContainer().clientHeight / 5);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding, maxZoom: 15, duration: 300 });
  }
};
async function start() {
  const run = ++generation;
  bridge.ready = false;
  controller?.abort(); resize?.disconnect(); map?.remove(); resources?.release();
  map = null; resources = null;
  redraw();
  controller = new AbortController();
  notice.hidden = false;
  notice.querySelector('span').textContent = '正在加载系统地图';
  try {
    const next = await prepareOfflineMap(controller.signal);
    if (run !== generation) { next.release(); return; }
    resources = next;
    const [west, south, east, north] = next.bounds;
    map = new next.maplibre.Map({
      container: 'system-map', style: next.style, center: [118.62, 37.46], zoom: 10, maxZoom: 18,
      maxBounds: [[west, south], [east, north]], bearing: 0, pitch: 0,
      dragRotate: false, pitchWithRotate: false, touchPitch: false,
      renderWorldCopies: false, attributionControl: false,
      localIdeographFontFamily: 'Microsoft YaHei, PingFang SC, sans-serif', fadeDuration: 0,
      transformRequest: next.transformRequest
    });
    next.decorate(map);
    map.touchZoomRotate.disableRotation();
    map.doubleClickZoom.disable();
    map.addControl(new next.maplibre.AttributionControl({ compact: true }), 'bottom-right');
    map.on('move', redraw);
    map.on('click', event => window.dispatchEvent(new CustomEvent('simulator-map:point', { detail: stored(event.lngLat) })));
    map.on('error', () => showError('系统地图部分资源加载失败，请检查地图服务后重试'));
    map.on('load', () => {
      if (run !== generation) return;
      bridge.ready = true; notice.hidden = true;
      redraw(); window.dispatchEvent(new Event('simulator-map:ready'));
    });
    resize = new ResizeObserver(() => { map?.resize(); redraw(); });
    resize.observe(document.querySelector('#map-stage'));
  } catch (error) {
    if (run === generation && error.name !== 'AbortError') showError(`系统地图未加载：${error.message}。请确认业务前台地图服务已启动`);
  }
}
document.querySelector('#retry-map').addEventListener('click', start);
window.addEventListener('offline-map:change', start);
window.addEventListener('pagehide', () => { generation++; controller?.abort(); resize?.disconnect(); map?.remove(); resources?.release(); });
start();
