import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { prepareOfflineMap } from '@/services/offlineMap.js';

// 三维空域底面：用本地离线底图在屏外画一张正北朝上的方形图片，由三维视图按地面坐标贴到下限平面。
// 只影响画面；地图包缺失或加载失败时返回空图片，视图继续使用方格网。
const SIZE = 1280;
const EQUATOR_METRES = 40075016.686;

const sameFloor = (a, b) => a && b && a.lon === b.lon && a.lat === b.lat && a.radius === b.radius;

export function useAirspaceFloorMap(floor) {
  const image = shallowRef(null);
  const controller = new AbortController();
  let map = null, release = null, host = null, timer = 0, requested = null, painting = false;

  function paint() {
    const target = requested;
    if (!map || !target || painting) return;
    painting = true;
    const metresPerPixel = 2 * target.radius / SIZE;
    const zoom = Math.log2(EQUATOR_METRES * Math.cos(target.lat * Math.PI / 180) / (512 * metresPerPixel));
    map.jumpTo({ center: [target.lon, target.lat], zoom: Math.max(0, Math.min(18, zoom)) });
    map.once('idle', () => {
      painting = false;
      if (controller.signal.aborted) return;
      if (!sameFloor(target, requested)) { paint(); return; }
      try { image.value = { ...target, href: map.getCanvas().toDataURL('image/jpeg', .9) }; } catch { image.value = null; }
    });
  }

  watch(floor, value => {
    if (!value || !Number.isFinite(value.lon) || !Number.isFinite(value.lat) || !(value.radius > 0)) return;
    if (sameFloor(value, requested)) return;
    requested = { ...value };
    // 拖点时边界连续变化，停手后再重画底图。
    clearTimeout(timer);
    timer = setTimeout(paint, 250);
  }, { immediate: true });

  onMounted(async () => {
    try {
      const runtime = await prepareOfflineMap(controller.signal);
      if (controller.signal.aborted) { runtime.release(); return; }
      release = runtime.release;
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: `${SIZE}px`, height: `${SIZE}px`, pointerEvents: 'none' });
      document.body.appendChild(host);
      map = new runtime.maplibre.Map({
        container: host, style: runtime.style, center: [0, 0], zoom: 0, bearing: 0, pitch: 0, interactive: false,
        renderWorldCopies: false, attributionControl: false, pixelRatio: 1, fadeDuration: 0,
        localIdeographFontFamily: '"Noto Sans SC"', transformRequest: runtime.transformRequest,
        canvasContextAttributes: { preserveDrawingBuffer: true }
      });
      if (typeof runtime.decorate === 'function') runtime.decorate(map);
      map.on('error', () => {});
      map.once('load', paint);
    } catch { image.value = null; }
  });

  onBeforeUnmount(() => {
    controller.abort();
    clearTimeout(timer);
    map?.remove();
    release?.();
    host?.remove();
    map = null;
  });

  return image;
}
