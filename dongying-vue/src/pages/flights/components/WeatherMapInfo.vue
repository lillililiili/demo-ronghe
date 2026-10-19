<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NSlider } from 'naive-ui';
import { weatherPolygon } from '@/services/weatherRiskGeometry.js';
import { weatherRiskIcon } from '@/ui/weatherRiskIcon.js';
const props = defineProps({ fact: Object, title: String, severity: String, source: String, color: String, cloudVisible: Boolean, windVisible: Boolean, opened: Boolean, kind: String, simulated: Boolean, boundaryVisible: Boolean, opacity: { type: Number, default: .18 } });
defineEmits(['update:cloud-visible', 'update:wind-visible', 'update:opened', 'update:boundary-visible', 'update:opacity']);
const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '未提供';
const now = ref(Date.now());
const hasRange = computed(() => !!weatherPolygon(props.fact));
const hasWind = computed(() => Number.isFinite(props.fact.wind_from_degrees) && Number.isFinite(props.fact.wind_speed_mps) && props.fact.wind_speed_mps>0);
const windName = computed(() => Number.isFinite(props.fact.wind_from_degrees) ? ['北风','东北风','东风','东南风','南风','西南风','西风','西北风'][Math.round(props.fact.wind_from_degrees/45)%8] : '风向未提供');
const progress = computed(() => Math.max(0,Math.min(100,(now.value-props.fact.valid_from)/(props.fact.valid_to-props.fact.valid_from)*100)));
const clockTime = value => Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}) : '未提供';
const cloudIcon='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15a4 4 0 0 1-.6-8A6 6 0 0 1 17 6a4.5 4.5 0 0 1 1 9H6M7 18l-1 3m7-3-1 3m7-3-1 3"/></svg>';
const windIcon=weatherRiskIcon({reason_code:'WEATHER_STRONG_WIND'});
const isSimulation = computed(() => props.fact.simulated === true || props.simulated || props.fact.source_mode === 'mock');
const period = computed(() => now.value < props.fact.valid_from ? '预报尚未生效' : now.value >= props.fact.valid_to ? '历史预报 · 已过有效期' : '预报有效中');
const icon = computed(() => weatherRiskIcon({reason_code: {wind:'WEATHER_STRONG_WIND',storm:'WEATHER_THUNDERSTORM',visibility:'WEATHER_LOW_VISIBILITY',multi:'WEATHER_MULTI'}[props.kind]}));
let ticker;
onMounted(() => { ticker = setInterval(() => { now.value = Date.now(); }, 30000); });
onUnmounted(() => clearInterval(ticker));
</script>

<template>
  <div class="weather-controls" @click.stop>
    <div class="weather-heading"><b>区域气象 · 云雨与风场</b><span v-if="isSimulation" class="weather-demo">模拟预报</span><span class="weather-period">{{ period }}</span></div>
    <div class="weather-actions">
      <button type="button" class="weather-layer-button" :disabled="!hasRange" :aria-pressed="hasRange && cloudVisible" :title="hasRange ? '切换云雨纹理，限预报范围内' : '未提供范围坐标'" @click="$emit('update:cloud-visible',!cloudVisible)"><span aria-hidden="true" v-html="cloudIcon"></span>云雨</button>
      <button type="button" class="weather-layer-button" :disabled="!hasRange || !hasWind" :aria-pressed="hasRange && hasWind && windVisible" :title="!hasRange ? '未提供范围坐标' : !hasWind ? '未提供有效风速、风向' : '切换风场线，箭头表示吹向'" @click="$emit('update:wind-visible',!windVisible)"><span aria-hidden="true" v-html="windIcon"></span>风场</button>
      <button type="button" class="weather-detail-button" :aria-expanded="opened" @click="$emit('update:opened',!opened)"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v2"/></svg>预报详情</button>
      <div v-if="hasRange" class="weather-opacity"><span>显示强度</span><output>{{ Math.round(opacity*100) }}%</output><NSlider :value="Math.round(opacity*100)" :min="8" :max="30" :step="1" :tooltip="false" aria-label="气象显示强度" @update:value="$emit('update:opacity',$event/100)" /></div>
    </div>
  </div>
  <div v-if="hasRange && !opened" class="weather-readings" aria-label="区域预报数值">
    <div v-if="cloudVisible" class="weather-reading rain"><span aria-hidden="true" v-html="cloudIcon"></span><div><span>{{ fact.summary || title }}</span><b>{{ fact.precipitation_rate_mm_h != null ? `${fact.precipitation_rate_mm_h} mm/h` : '雨量未提供' }}</b></div></div>
    <div v-if="windVisible && hasWind" class="weather-reading wind"><span aria-hidden="true" v-html="windIcon"></span><div><span>{{ windName }}</span><b>{{ fact.wind_speed_mps }} m/s</b></div></div>
  </div>
  <section v-if="opened" class="weather-card" aria-label="气象预警详情" @click.stop>
    <div class="weather-heading"><b>{{ title }} · {{ severity }}</b><button type="button" @click="$emit('update:opened',false)">关闭</button></div>
    <dl>
      <dt>预报区域</dt><dd>{{ fact.area_name || '来源未提供区域名称' }} · {{ hasRange ? '按预报坐标显示' : '边界未提供' }}</dd>
      <dt>有效时段</dt><dd>{{ time(fact.valid_from) }} ～ {{ time(fact.valid_to) }}（北京时间）</dd>
      <template v-if="fact.precipitation_rate_mm_h != null"><dt>降雨强度</dt><dd>{{ fact.precipitation_rate_mm_h }} mm/h</dd></template>
      <template v-if="fact.wind_speed_mps != null"><dt>风速</dt><dd>{{ fact.wind_speed_mps }} m/s</dd></template>
      <template v-if="fact.wind_from_degrees != null"><dt>风向</dt><dd>从 {{ fact.wind_from_degrees }}° 方向吹来；箭头表示吹向</dd></template>
      <template v-if="fact.visibility_m != null"><dt>能见度</dt><dd>{{ fact.visibility_m }} m</dd></template>
      <dt>数据来源</dt><dd>{{ source || '未提供' }}<span v-if="isSimulation"> · 模拟数据</span></dd>
      <dt>发布时间</dt><dd>{{ time(fact.published_at) }}（北京时间）</dd>
    </dl>
    <p>云雨纹理为区域天气示意，不表示逐点雨量或实际云层分布。预报范围不等同于行政区边界；当前未提供高度分层。</p>
  </section>
  <div class="weather-legend" @click.stop>
    <div class="weather-legend-row"><span><i class="area"></i>{{ hasRange ? '预报范围' : '边界未提供' }}</span><span class="weather-cloud-key"><span aria-hidden="true" v-html="icon"></span>云雨示意</span><span><i class="wind-key"></i>风向</span><span><i class="route"></i>关联航线</span></div>
    <div class="weather-validity"><span>{{ clockTime(fact.valid_from) }}</span><div class="weather-time-track" :title="`有效时段：${time(fact.valid_from)} ～ ${time(fact.valid_to)}`"><i :style="{width:`${progress}%`}"></i></div><span>{{ clockTime(fact.valid_to) }}</span><span>北京时间</span></div>
    <div class="weather-window">{{ time(fact.valid_from) }} ～ {{ time(fact.valid_to) }}<span class="weather-texture-note">纹理示意 · 非逐点雨量</span></div>
  </div>
</template>

<style scoped>
.weather-controls,.weather-legend { flex:none; color:var(--txt-1); background:var(--surface-1); font-size:12px; padding:9px 12px; }
.weather-controls { order:-1; border-bottom:1px solid var(--line); }
.weather-heading,.weather-heading b,.weather-actions,.weather-opacity { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.weather-heading b { font-size:13px; }
.weather-icon { display:flex; color:#8bc7d7; }
.weather-demo { color:var(--amber); font-size:11px; }
.weather-period { margin-left:auto; color:var(--txt-3); font-size:11px; }
.weather-actions { margin-top:9px; gap:8px; }
.weather-actions button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:32px; }
.weather-layer-button { min-width:76px; }
.weather-layer-button span,.weather-cloud-key>span { display:flex; }
.weather-layer-button :deep(svg) { width:19px; height:19px; }
.weather-actions .weather-layer-button[aria-pressed="true"] { color:#e6f5ff; background:#1764ae; border-color:#3e8dd2; }
.weather-opacity { margin-left:auto; gap:7px; color:var(--txt-2); font-size:11px; flex:1 1 200px; justify-content:flex-end; }
.weather-opacity output { padding:3px 6px; border:1px solid var(--line); border-radius:5px; font-variant-numeric:tabular-nums; color:var(--txt-1); }
.weather-opacity :deep(.n-slider) { width:108px; flex:none; --n-fill-color:#5db7e8; --n-fill-color-hover:#75caff; --n-rail-color:#254164; --n-rail-color-hover:#2b4b73; }
button { font:inherit; color:var(--txt-2); background:transparent; border:1px solid var(--line); border-radius:5px; padding:5px 8px; cursor:pointer; }
button:hover:not(:disabled),button[aria-pressed="true"] { background:var(--surface-selected); color:var(--cyan); border-color:var(--cyan); }
button:disabled { opacity:.5; cursor:default; }
button:focus-visible { outline:2px solid var(--cyan); outline-offset:2px; }
.weather-readings { position:absolute; inset:0; pointer-events:none; z-index:2; }
.weather-reading { position:absolute; display:flex; align-items:center; gap:9px; max-width:148px; padding:7px 10px; border:1px solid #7ab2cf40; border-radius:6px; background:#082137ce; color:#d3e8f3; box-shadow:0 2px 8px #0002; }
.weather-reading.rain { left:22px; top:42%; }.weather-reading.wind { right:22px; top:24%; }
.weather-reading>span { display:flex; color:#a7cee0; }.weather-reading>span :deep(svg) { width:27px; height:27px; }
.weather-reading>div { display:grid; gap:3px; }.weather-reading>div>span { font-size:11px; }.weather-reading b { font-size:13px; font-weight:600; }
.weather-card { position:absolute; left:12px; right:12px; bottom:76px; z-index:5; color:var(--txt-1); background:var(--surface-1); border:1px solid var(--line); border-radius:6px; padding:12px; max-height:60%; overflow:auto; font-size:12px; box-shadow:0 4px 16px #0004; }
.weather-card .weather-heading { justify-content:space-between; }
dl { display:grid; grid-template-columns:64px minmax(0,1fr); gap:8px; margin:12px 0; } dt { color:var(--txt-3); } dd { margin:0; overflow-wrap:anywhere; }
p { margin:8px 0 0; padding-top:8px; border-top:1px solid var(--line); color:var(--txt-2); line-height:1.6; }
.weather-legend { order:2; border-top:1px solid var(--line); color:var(--txt-2); font-size:11px; }
.weather-legend-row,.weather-validity { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }.weather-legend span { display:flex; align-items:center; gap:5px; }
.weather-cloud-key :deep(svg) { width:16px; height:16px; color:#9abdd0; }
.weather-validity { margin-top:9px; gap:8px; color:var(--txt-2); font-variant-numeric:tabular-nums; }
.weather-time-track { flex:1; height:3px; border-radius:2px; background:#28415f; position:relative; }.weather-time-track i { display:block; position:relative; height:3px; background:#64a9cd; }.weather-time-track i::after { content:''; position:absolute; right:-3px; top:-2px; width:7px; height:7px; border-radius:50%; background:#a6d8e9; }
.weather-texture-note { margin-left:auto; }
.weather-window { margin-top:6px; color:var(--txt-3); }
.weather-window { display:flex; gap:8px; flex-wrap:wrap; font-size:10px; }
i { display:inline-block; width:16px; }.area { height:8px; border:1px dashed #80bfd6; background:#56b8cd18; }.route { border-top:2px dashed #269bad; }.wind-key { width:18px; border-top:1px solid #a2c8db; position:relative; }.wind-key::after { content:''; position:absolute; width:4px; height:4px; right:0; top:-3px; transform:rotate(45deg); border-right:1px solid #a2c8db; border-top:1px solid #a2c8db; }
</style>
