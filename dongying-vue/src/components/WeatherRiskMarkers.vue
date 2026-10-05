<script setup>
import { computed, ref } from 'vue';
import { useWeatherRiskFacts } from '@/hooks/useWeatherRiskFacts.js';
import { weatherAnchor, weatherPolygon, isSimulatedWeatherRisk } from '@/services/weatherRiskGeometry.js';
import { drawWeatherArea, weatherLayerKind, weatherLayerGradient } from '@/services/weatherRiskLayer.js';
import { REASON_CODE_LABEL, labelOf } from '@/ui/labels.js';
import { weatherRiskIcon } from '@/ui/weatherRiskIcon.js';

const props = defineProps({ risks: { type: Array, default: () => [] },
  selectedId: String, visible: { type: Boolean, default: true }, sharedLayout: { type: Boolean, default: false },
  controlTarget: { type: String, default: '' }, controlInline: Boolean });
defineEmits(['select']);
const rows = useWeatherRiskFacts(computed(() => props.risks));
const located = computed(() => rows.value.map(row => ({ row, point: weatherAnchor(row.weather_fact), ring: weatherPolygon(row.weather_fact) })));
const markers = ref([]);
const enabled = ref(true), opacity = ref(.4);
const legendKinds = computed(() => [...new Set(located.value.filter(item => item.ring && isSimulatedWeatherRisk(item.row))
  .map(({ row }) => weatherLayerKind(row.reason_code || row.reasonCode)))]);
const missing = computed(() => located.value.filter(({ row, point }) => !row.weather_loading && !point).length);
const layoutRows = computed(() => located.value.map(item => ({ ...item, data: { ...item.row, id: item.row.risk_id,
  name: labelOf(REASON_CODE_LABEL, item.row.reason_code || item.row.reasonCode, '气象风险') } })));
function getMarkers(map) {
  if (!props.visible || !enabled.value || !map?.w) return [];
  return layoutRows.value.flatMap(({ row, point, ring, data }) => {
    if (!point || !ring) return [];
    const pixels = ring.map(p => map.px(...p));
    if (pixels.every(p => p[0] < 0) || pixels.every(p => p[0] > map.w)
      || pixels.every(p => p[1] < 0) || pixels.every(p => p[1] > map.h)) return [];
    const x = Math.max(8, Math.min(map.w - 160, Math.min(...pixels.map(p => p[0])) + 8));
    const y = Math.max(8, Math.min(map.h - 42, Math.min(...pixels.map(p => p[1])) + 8));
    return [{ kind: 'weather', data, point: [x + 80, y + 17], width: 160, height: 34,
      selected: props.selectedId === row.risk_id,
      abnormal: window.UI.abnormalActive(row) }];
  });
}
// 复用宿主 MapView 的绘制周期，拖动、缩放和减少动态效果均沿用原地图。
function draw(map) {
  const next = props.visible && enabled.value && map?.w ? located.value.flatMap(({ row, point, ring }) => {
    if (!point) return [];
    const reason = row.reason_code || row.reasonCode;
    const kind = weatherLayerKind(reason);
    const simulated = isSimulatedWeatherRisk(row);
    const color = ({ WEATHER_STRONG_WIND: '#cf8418', WEATHER_THUNDERSTORM: '#e15c75', WEATHER_LOW_VISIBILITY: '#8376cb' })[reason] || '#8376cb';
    const pixels = ring.map(p => map.px(...p));
    if (pixels.every(p => p[0] < 0) || pixels.every(p => p[0] > map.w)
      || pixels.every(p => p[1] < 0) || pixels.every(p => p[1] > map.h)) return [];
    drawWeatherArea(map.ctx, map, row.weather_fact, ring, null, color, kind, simulated, props.selectedId === row.risk_id, opacity.value);
    // 标题沿范围左上角排列，避免挡住旧版云团与风场中心。
    const shared = props.sharedLayout ? map._markerLayout?.points.get(`weather:${row.risk_id}`) : null;
    if (props.sharedLayout && !shared?.visible) return [];
    const x = shared ? shared.point[0] - 80 : Math.max(8, Math.min(map.w - 160, Math.min(...pixels.map(p => p[0])) + 8));
    const y = shared ? shared.point[1] - 17 : Math.max(8, Math.min(map.h - 42, Math.min(...pixels.map(p => p[1])) + 8));
    if (shared && Math.hypot(shared.point[0] - shared.anchor[0], shared.point[1] - shared.anchor[1]) > 2) {
      const origin = map.px(...point), c = map.ctx;
      c.save(); c.beginPath(); c.moveTo(...origin); c.lineTo(...shared.point);
      c.strokeStyle = color; c.globalAlpha = .65; c.lineWidth = 1; c.stroke(); c.restore();
    }
    return [{ id: row.risk_id, x: Math.round(x), y: Math.round(y), icon: weatherRiskIcon(row),
      title: labelOf(REASON_CODE_LABEL, row.reason_code || row.reasonCode, '气象风险'),
      mode: row.weather_fact.source_mode, color: row.state === 'EXCLUDED' ? 'var(--txt-3)' : 'var(--amber)' }];
  }) : [];
  if (JSON.stringify(next) !== JSON.stringify(markers.value)) markers.value = next;
}
defineExpose({ draw, getMarkers });
function risk(id) { return rows.value.find(row => row.risk_id === id); }
</script>

<template>
  <div v-if="visible" class="weather-risk-markers">
    <button v-for="marker in markers" :key="marker.id" type="button" class="weather-risk-marker"
      :class="{ selected: selectedId === marker.id }"
      :style="{ left: `${marker.x}px`, top: `${marker.y}px`, color: marker.color }"
      :aria-label="`查看${marker.title}范围`" :aria-pressed="selectedId === marker.id" @click.stop="$emit('select', risk(marker.id))">
      <span class="weather-risk-icon" aria-hidden="true" v-html="marker.icon"></span>
      <span class="weather-risk-label"><b>{{ marker.title }}</b><small v-if="marker.mode === 'mock'">模拟</small><small v-else-if="marker.mode === 'replay'">回放</small></span>
    </button>
    <span v-if="missing" class="weather-risk-missing">{{ missing }} 条气象风险范围暂不可用</span>
  </div>
  <Teleport :to="controlTarget || 'body'" :disabled="!controlTarget" defer>
    <details v-if="visible && rows.length" class="weather-layer-control" :class="{ inline: controlInline, floating: !controlTarget }" @click.stop>
      <summary :class="{ off: !enabled }">气象<span>{{ rows.length }}</span></summary>
      <div class="weather-layer-panel">
        <header><b>气象图层</b><button type="button" :aria-pressed="enabled" @click="enabled = !enabled">{{ enabled ? '隐藏图层' : '显示图层' }}</button></header>
        <div class="weather-opacity" aria-label="气象不透明度"><span>不透明度</span><button v-for="value in [.25, .4, .6]" :key="value" type="button" :aria-pressed="opacity === value" @click="opacity = value">{{ Math.round(value * 100) }}%</button></div>
        <div v-for="kind in legendKinds" :key="kind" class="weather-risk-scale"><span>{{ { wind: '大风', storm: '雷雨', visibility: '低能见度' }[kind] }}</span><i :style="{ background: weatherLayerGradient(kind) }"></i></div>
        <p v-if="legendKinds.length">模拟分布 · 非实测</p>
      </div>
    </details>
  </Teleport>
</template>

<style scoped>
.weather-risk-markers { position:absolute; inset:0; pointer-events:none; z-index:3; overflow:hidden; }
.weather-risk-marker { position:absolute; display:flex; align-items:center; gap:6px; box-sizing:border-box; width:160px; min-height:34px; padding:4px 7px; border:1px solid var(--line); border-radius:6px; background:var(--surface-1); cursor:pointer; pointer-events:auto; font:inherit; text-align:left; }
.weather-risk-icon { display:flex; flex:0 0 24px; }
.weather-risk-marker.selected { outline:2px solid var(--cyan); outline-offset:3px; z-index:1; }
.weather-risk-marker:focus-visible { outline:2px solid var(--cyan); outline-offset:3px; }
.weather-risk-label { display:flex; white-space:nowrap; align-items:center; gap:7px; font-size:12px; line-height:1.4; color:var(--txt); }
.weather-risk-label b { font-weight:500; }.weather-risk-label small { color:var(--txt-2); font-size:10px; }
.weather-layer-control { position:relative; color:var(--txt); font-size:12px; pointer-events:auto; }
.weather-layer-control summary { display:flex; align-items:center; gap:7px; min-height:36px; box-sizing:border-box; padding:0 10px; border:1px solid var(--line); border-radius:6px; background:var(--surface-selected); cursor:pointer; list-style:none; }
.weather-layer-control summary::-webkit-details-marker { display:none; }
.weather-layer-control summary span { color:var(--cyan); }.weather-layer-control summary.off { color:var(--txt-3); background:var(--surface-1); }
.weather-layer-panel { position:absolute; left:0; bottom:calc(100% + 8px); width:218px; box-sizing:border-box; padding:10px; border:1px solid var(--line); border-radius:6px; background:var(--surface-1); box-shadow:var(--shadow); }
.weather-layer-panel header,.weather-opacity { display:flex; align-items:center; justify-content:space-between; gap:4px; }
.weather-layer-control .weather-layer-panel button { min-height:28px; padding:4px 6px; border:1px solid var(--line); border-radius:4px; background:var(--surface-2); color:var(--txt-2); font:inherit; cursor:pointer; }
.weather-layer-control .weather-layer-panel button[aria-pressed="true"] { color:var(--cyan); background:var(--surface-selected); border-color:var(--blue); }
.weather-opacity { margin-top:10px; }.weather-opacity > span { font-size:11px; white-space:nowrap; }
.weather-risk-scale { display:flex; align-items:center; gap:8px; margin-top:9px; color:var(--txt-2); font-size:11px; }
.weather-risk-scale i { flex:1; height:5px; border-radius:3px; }
.weather-layer-panel p { margin:9px 0 0; color:var(--txt-3); font-size:10px; }
.weather-layer-control.inline .weather-layer-panel { position:static; width:100%; margin-top:6px; }
.weather-layer-control.inline { margin-top:8px; }
.weather-layer-control.floating { position:absolute; left:12px; bottom:12px; z-index:6; }
.weather-layer-control summary:focus-visible,.weather-layer-panel button:focus-visible { outline:2px solid var(--cyan); outline-offset:2px; }
.weather-risk-missing { position:absolute; left:12px; bottom:12px; max-width:calc(100% - 24px); padding:4px 8px; border-radius:4px; background:var(--surface-1); color:var(--txt-2); font-size:12px; }
</style>
