<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { weatherLayerGradient } from '@/pages/flights/weatherMap.js';
const props = defineProps({ fact: Object, title: String, severity: String, source: String, color: String, visible: Boolean, opened: Boolean, kind: String, simulated: Boolean, boundaryVisible: Boolean });
defineEmits(['toggle-layer', 'update:opened', 'update:boundary-visible']);
const gradient = computed(() => weatherLayerGradient(props.kind));
const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
const now = ref(Date.now());
const period = computed(() => now.value < props.fact.valid_from ? '尚未到预警时段' : now.value >= props.fact.valid_to ? '已过有效期 · 历史范围' : '处于预警时段');
let ticker;
onMounted(() => { ticker = setInterval(() => { now.value = Date.now(); }, 30000); });
onUnmounted(() => clearInterval(ticker));
</script>

<template>
  <div class="weather-controls" @click.stop>
    <b class="weather-title">{{ title }}<span v-if="fact.source_mode === 'mock'">模拟</span></b>
    <button type="button" :aria-pressed="visible" @click="$emit('toggle-layer')">{{ visible ? '隐藏图层' : '显示图层' }}</button>
    <button type="button" :aria-expanded="opened" @click="$emit('update:opened', !opened)">详情</button>
    <span class="weather-period">{{ period }}</span>
  </div>
  <section v-if="opened" class="weather-card" aria-label="气象预警详情" @click.stop>
    <div class="weather-heading"><b>{{ title }} · {{ severity }}</b><button type="button" @click="$emit('update:opened', false)">关闭</button></div>
    <span v-if="fact.source_mode === 'mock'" class="weather-demo">模拟数据 · 非实时天气</span>
    <dl>
      <dt>有效时段</dt><dd>{{ time(fact.valid_from) }} ～ {{ time(fact.valid_to) }}</dd>
      <template v-if="fact.wind_speed_mps != null"><dt>风速</dt><dd>{{ fact.wind_speed_mps }} 米/秒</dd></template>
      <template v-if="fact.wind_from_degrees != null"><dt>风向</dt><dd>从 {{ fact.wind_from_degrees }}° 方向吹来</dd></template>
      <template v-if="fact.visibility_m != null"><dt>能见度</dt><dd>{{ fact.visibility_m }} 米</dd></template>
      <dt>数据来源</dt><dd>{{ source || '未提供' }}</dd>
      <dt>发布时间</dt><dd>{{ time(fact.published_at) }}</dd>
    </dl>
    <p>紫色外圈表示区域内航段，是否影响飞行还需结合飞行时段和高度。</p>
  </section>
  <div v-if="simulated && visible" class="weather-scale" aria-label="模拟气象分布色标" @click.stop>
    <span>模拟分布<small>{{ kind === 'visibility' ? '能见度' : kind === 'storm' ? '雷雨' : '风' }}</small></span>
    <div class="scale-ramp" :style="{ background: gradient }"></div>
    <div class="scale-labels"><span>{{ kind === 'visibility' ? '清晰' : '弱' }}</span><span>{{ kind === 'visibility' ? '模糊' : '强' }}</span></div>
  </div>
  <details class="weather-legend" @click.stop>
    <summary>图例<span v-if="fact.source_mode === 'mock'"> · 模拟气象</span></summary>
    <div><i class="area" :style="{ color }"></i>预警范围</div>
    <div><i class="route"></i>关联航线</div>
    <div><i class="overlap"></i>区域内航段</div>
    <div v-if="simulated && kind === 'wind'">流线表示风吹向</div>
    <div v-if="simulated" class="texture-note">色带为模拟纹理，不是实测分布</div>
    <button v-if="simulated" type="button" :aria-pressed="boundaryVisible" @click="$emit('update:boundary-visible', !boundaryVisible)">{{ boundaryVisible ? '隐藏预警边界' : '显示预警边界' }}</button>
  </details>
</template>

<style scoped>
.weather-controls,.weather-card,.weather-legend,.weather-scale { position: absolute; z-index: 5; color: var(--txt-1); background: var(--surface-gradient); border: 1px solid var(--line); border-radius: 8px; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 3px 12px #0002; font-size: 11px; }
.weather-controls { left: 56px; top: 48px; display: flex; flex-wrap: wrap; gap: 3px; padding: 3px; max-width: calc(100% - 66px); }
.weather-title { display: flex; align-items: center; gap: 6px; padding: 4px 7px; font-size: 11px; }
.weather-title span { color: var(--amber); font-size: 10px; font-weight: 400; }
.weather-period { flex-basis: 100%; color: var(--txt-2); padding: 0 7px 4px; }
button { color: inherit; font: inherit; border: 0; background: transparent; padding: 5px 7px; border-radius: 5px; cursor: pointer; }
button:hover { background: #ffffff20; }
button:focus-visible,summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.weather-card { left: 10px; right: 10px; bottom: 64px; padding: 10px; max-height: 60%; overflow: auto; }
.weather-heading { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 12px; }
.weather-demo { color: var(--amber); }
dl { display: grid; grid-template-columns: 56px minmax(0,1fr); gap: 6px; margin: 10px 0; }
dt { color: var(--txt-3); } dd { margin: 0; overflow-wrap: anywhere; }
p { margin: 7px 0 0; padding-top: 7px; border-top: 1px solid var(--line); color: var(--txt-2); line-height: 1.6; }
.weather-legend { right: 10px; bottom: 26px; padding: 6px 9px; }
.weather-scale { left: 10px; bottom: 26px; padding: 6px 8px; width: min(138px, calc(100% - 142px)); min-width: 70px; font-size: 10px; }
.weather-scale > span { display: flex; justify-content: space-between; gap: 5px; }
.weather-scale small { color: var(--txt-2); font-size: inherit; }
.scale-ramp { height: 5px; margin: 5px 0 3px; border-radius: 3px; }
.scale-labels { display: flex; justify-content: space-between; color: var(--txt-2); font-size: 9px; }
.texture-note { max-width: 150px; line-height: 1.5; color: var(--txt-2); }
summary { cursor: pointer; font-weight: 600; }
summary span { font-weight: 400; color: var(--amber); }
.weather-legend div { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
i { display: inline-block; width: 17px; flex: none; }
.area { height: 9px; border: 1px dashed currentColor; background: color-mix(in srgb, currentColor 25%, transparent); }
.route { border-top: 2px dashed #269bad; }
.overlap { border-top: 4px solid #a855f7; }
</style>
