<script setup>
import { computed } from 'vue';
const props = defineProps({ risk: Object, marker: Object, title: String, color: String, severity: String,
  routeVisible: Boolean, corridorVisible: Boolean });
const targetIcon = computed(() => window.UI.targetIcon(props.risk));
const statusIcon = window.UI.icon('warning');
const activeRisk = computed(() => window.UI.abnormalActive(props.risk));
const fact = computed(() => props.risk.space_fact || {});
const time = value => value == null ? '时间未知' : new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
</script>

<template>
  <div v-if="marker" class="object-marker" :style="{ left: `${marker.x}px`, top: `${marker.y}px`, color }">
    <span class="object-symbol" :class="{ 'map-alarm-active': activeRisk }"><span v-html="targetIcon"></span></span><span class="object-risk-state" aria-hidden="true" v-html="statusIcon"></span>
    <div class="object-label" :class="{ leftward: marker.leftward }"><b>{{ title }}</b><span>事件位置<template v-if="(risk.source_display_mode || risk.source_mode) === 'mock'"> · 模拟</template></span></div>
  </div>
  <div class="object-location-note">
    <template v-if="marker">{{ time(risk.occurred_at ?? fact.window_to) }} 的位置</template><template v-else>事件位置未知</template>
    <span v-if="fact.distance_to_route_m != null"> · 距航线 {{ fact.distance_to_route_m }} 米</span>
    <span v-if="risk.observed_altitude_m != null"> · 高度 {{ risk.observed_altitude_m }} 米（{{ risk.observed_altitude_datum || '基准未知' }}）</span><span v-else> · 高度未知</span>
  </div>
  <details v-if="marker || routeVisible" class="object-legend" open @click.stop>
    <summary>图例</summary>
    <ul>
      <li v-if="marker"><span class="legend-symbol" aria-hidden="true" v-html="targetIcon"></span><span>事件位置</span></li>
      <li v-if="marker"><span class="legend-symbol legend-warning" :style="{ color }" aria-hidden="true" v-html="statusIcon"></span><span>风险角标 · {{ severity }}</span></li>
      <li v-if="routeVisible"><i class="legend-route" aria-hidden="true"></i><span>灰色虚线 · 关联航线</span></li>
      <li v-if="corridorVisible"><i class="legend-corridor" aria-hidden="true"></i><span>青色区域 · 航线走廊</span></li>
    </ul>
  </details>
</template>

<style scoped>
.object-marker { position: absolute; z-index: 6; width: 30px; height: 30px; transform: translate(-50%, -50%); pointer-events: none; }
.object-symbol { display: grid; place-items: center; width: 30px; height: 30px; background:transparent;border:0;box-shadow:none; }
.object-symbol :deep(svg) { width:22px;height:22px; }.object-symbol span { display: flex; }
.object-risk-state{position:absolute;right:0;bottom:0;display:flex}.object-risk-state :deep(svg){width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2}
.object-label { position: absolute; left: 38px; top: -3px; min-width: 94px; background: var(--surface-gradient); border-left: 2px solid currentColor; border-radius: 4px; padding: 5px 8px; display: grid; gap: 2px; font-size: 11px; white-space: nowrap; }
.object-label b { color: var(--txt-1); }.object-label span { font-size: 9px; color: var(--txt-2); }.object-label.leftward { left: auto; right: 8px; transform: translateX(-30px); }
.object-location-note,.object-legend { position: absolute; z-index: 5; background: var(--surface-gradient); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--line); color: var(--txt-2); border-radius: 6px; font-size: 11px; padding: 7px 9px; }
summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.object-location-note { top: 48px; left: 56px; right: 10px; width: fit-content; max-width: calc(100% - 66px); box-sizing: border-box; line-height: 1.5; pointer-events: none; }
.object-legend { bottom: 30px; right: 10px; max-width: calc(100% - 20px); box-sizing: border-box; }
.object-legend summary { cursor: pointer; color: var(--txt); font-weight: 600; }
.object-legend ul { display: grid; gap: 7px; padding: 0; margin: 9px 0 0; list-style: none; }
.object-legend li { display: flex; align-items: center; gap: 7px; line-height: 1.5; }
.legend-symbol { display: inline-flex; align-items: center; justify-content: center; width: 20px; flex: none; }
.legend-symbol :deep(svg) { width: 18px; height: 18px; }
.legend-warning :deep(svg) { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
.object-legend i { display: inline-block; width: 20px; flex: none; box-sizing: border-box; }
.legend-route { border-top: 2px dashed var(--gray); }
.legend-corridor { height: 9px; background: color-mix(in srgb, var(--cyan) 20%, transparent); border: 1px solid color-mix(in srgb, var(--cyan) 50%, transparent); border-radius: 2px; }
</style>
