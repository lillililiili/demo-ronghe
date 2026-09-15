<script setup>
import { computed } from 'vue';
const props = defineProps({ risk: Object, marker: Object, title: String, color: String, heat: Boolean, heatCount: Number,
  trail: Array, trailIndex: Number, trailVisible: Boolean, playing: Boolean, trackError: String });
defineEmits(['toggle-heat', 'toggle-trail', 'toggle-play', 'step']);
const birdIcon = window.UI.icon('bird');
const bird = computed(() => ['BIRD', 'BIRD_FLOCK'].includes(props.risk.space_fact?.subtype_code));
const fact = computed(() => props.risk.space_fact || {});
const time = value => value == null ? '时间未知' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const currentTime = computed(() => time(props.trail?.[props.trailIndex]?.t));
</script>

<template>
  <div v-if="marker" class="object-marker" :style="{ left: `${marker.x}px`, top: `${marker.y}px`, color }">
    <span class="object-symbol"><span v-if="bird" v-html="birdIcon"></span><span v-else class="object-dot"></span></span>
    <div class="object-label" :class="{ leftward: marker.leftward }"><b>{{ title }}</b><span>事件位置<template v-if="risk.source_mode === 'mock'"> · 模拟</template></span></div>
  </div>
  <div class="object-map-tools" @click.stop>
    <button type="button" :aria-pressed="heat" :disabled="!heatCount" :title="heatCount ? '查看本页事件集中在哪些位置' : '本页没有可用的事件位置'" @click="$emit('toggle-heat')">{{ heat ? '隐藏事件热区' : '事件热区' }}</button>
    <button v-if="trail.length > 1" type="button" :aria-pressed="trailVisible" @click="$emit('toggle-trail')">{{ trailVisible ? '隐藏轨迹' : '关联目标轨迹' }}</button>
  </div>
  <div class="object-location-note">
    <template v-if="marker">{{ time(risk.occurred_at ?? fact.window_to) }} 的位置</template><template v-else>事件位置未知</template>
    <span v-if="fact.distance_to_route_m != null"> · 距航线 {{ fact.distance_to_route_m }} 米</span>
    <span v-if="risk.observed_altitude_m != null"> · 高度 {{ risk.observed_altitude_m }} 米（{{ risk.observed_altitude_datum || '基准未知' }}）</span><span v-else> · 高度未知</span>
    <span v-if="trackError"> · {{ trackError }}</span>
  </div>
  <div v-if="trailVisible && trail.length > 1" class="object-playback" @click.stop>
    <b>关联目标最近轨迹片段 · 逐点回放</b><span>{{ currentTime }}</span>
    <div><button type="button" :disabled="trailIndex <= 0" @click="$emit('step', -1)">前一点</button><button type="button" @click="$emit('toggle-play')">{{ playing ? '暂停' : trailIndex >= trail.length - 1 ? '重播' : '播放' }}</button><button type="button" :disabled="trailIndex >= trail.length - 1" @click="$emit('step', 1)">后一点</button><span>{{ trailIndex + 1 }}/{{ trail.length }}</span></div>
    <progress :value="trailIndex" :max="trail.length - 1" aria-label="轨迹回放进度"></progress>
  </div>
  <details class="object-legend" @click.stop>
    <summary>图例</summary>
    <div>异物标记颜色表示风险等级</div><div>青色：关联航线与走廊</div><div v-if="trailVisible">紫色：关联目标轨迹片段</div>
    <div v-if="heat">本页 {{ heatCount }} 条{{ risk.source_mode === 'mock' ? '模拟' : risk.source_mode === 'replay' ? '回放' : '' }}事件的位置分布，不代表鸟群大小。</div>
    <div>通知状态不改变地图上的风险等级。</div>
  </details>
</template>

<style scoped>
.object-marker { position: absolute; z-index: 6; width: 30px; height: 30px; transform: translate(-50%, -50%); pointer-events: none; }
.object-symbol { display: grid; place-items: center; width: 30px; height: 30px; background: var(--surface-1); border: 2px solid currentColor; border-radius: 50%; box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 12%, transparent); }
.object-symbol :deep(svg) { width: 19px; height: 19px; }.object-symbol span { display: flex; }
.object-dot { width: 7px; height: 7px; background: currentColor; border-radius: 50%; }
.object-label { position: absolute; left: 38px; top: -3px; min-width: 94px; background: rgba(13,31,47,.84); border-left: 2px solid currentColor; border-radius: 4px; padding: 5px 8px; display: grid; gap: 2px; font-size: 11px; white-space: nowrap; }
.object-label b { color: var(--txt-1); }.object-label span { font-size: 9px; color: var(--txt-2); }.object-label.leftward { left: auto; right: 8px; transform: translateX(-30px); }
.object-map-tools,.object-location-note,.object-playback,.object-legend { position: absolute; z-index: 5; background: rgba(15,32,49,.72); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(210,228,245,.24); color: var(--txt-2); border-radius: 6px; font-size: 11px; padding: 5px 7px; }
.object-map-tools { top: 48px; left: 56px; display: flex; gap: 4px; max-width: calc(100% - 66px); flex-wrap: wrap; }
button { cursor: pointer; border: 0; border-radius: 4px; color: inherit; background: transparent; font: inherit; padding: 4px 6px; }button[aria-pressed=true] { color: var(--cyan); background: #ffffff12; }button:disabled { opacity: .4; cursor: default; }
button:focus-visible,summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 1px; }
.object-location-note { top: 93px; left: 56px; right: 10px; width: fit-content; line-height: 1.5; pointer-events: none; }
.object-playback { left: 10px; bottom: 30px; max-width: calc(100% - 100px); display: grid; gap: 4px; }.object-playback b { font-size: 10px; }.object-playback > span { font-size: 10px; }.object-playback > div { display: flex; align-items: center; gap: 5px; }.object-playback progress { width: 100%; height: 4px; accent-color: var(--cyan); }
.object-legend { bottom: 30px; right: 10px; max-width: 190px; }.object-legend summary { cursor: pointer; }.object-legend div { margin-top: 5px; line-height: 1.5; font-size: 10px; }
</style>
