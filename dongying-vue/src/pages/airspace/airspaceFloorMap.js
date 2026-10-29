import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { prepareOfflineMap } from '@/services/offlineMap.js';

// 三维空域底面：用本地离线底图在屏外画一张正北朝上的方形图片，由三维视图按地面坐标贴到下限平面。
// 只影响画面；地图包缺失或加载失败时返回空图片，视图继续使用方格网。
// coverage 回填地图包覆盖范围 [西, 南, 东, 北]：加载中为 null，不可用为 false。
const SIZE = 2048;
const EQUATOR_METRES = 40075016.686;

const sameFloor = (a, b) => a && b && a.lon === b.lon && a.lat === b.lat && a.radius === b.radius;

export function useAirspaceFloorMap(floor, coverage = shallowRef(null)) {
  const image = shallowRef(null);
  const controller = new AbortController();
  let map = null, release = null, host = null, timer = 0, requested = null, painting = false;

  function paint() {
    const target = requested;
    if (!map || !target || painting) return;
    painting = true;
    const circumference = EQUATOR_METRES * Math.cos(target.lat * Math.PI / 180);
    const zoom = Math.max(0, Math.min(18, Math.log2(circumference * SIZE / (512 * 2 * target.radius))));
    // 极小空域放大到 18 级封顶时，图片实际覆盖的范围比请求的小，按实际级别记录半径。
    const radius = circumference * SIZE / (512 * 2 * 2 ** zoom);
    map.jumpTo({ center: [target.lon, target.lat], zoom });
    map.once('idle', () => {
      painting = false;
      if (controller.signal.aborted) return;
      if (!sameFloor(target, requested)) { paint(); return; }
      try { image.value = { lon: target.lon, lat: target.lat, radius, href: map.getCanvas().toDataURL('image/jpeg', .9) }; } catch { image.value = null; }
    });
    // 视角未变时 jumpTo 不重绘，主动触发一次，保证 idle 一定到来。
    map.triggerRepaint();
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
      coverage.value = runtime.bounds;
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
    } catch { image.value = null; coverage.value = false; }
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
