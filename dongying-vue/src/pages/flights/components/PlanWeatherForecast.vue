<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { weatherForecastApi } from '@/services/weatherForecastApi.js';

const props = defineProps({
  planId: { type: [String, Number], required: true },
  startAt: { type: [String, Number], default: null },
  endAt: { type: [String, Number], default: null }
});

const loading = ref(false);
const error = ref(null);
const response = ref(null);
let requestVersion = 0;

const STATUS_COPY = {
  NOT_CONFIGURED: '天气预报尚未接通',
  AWAITING_ADAPTER: '天气预报尚未接通',
  EMPTY: '当前任务暂无天气预报'
};
const SOURCE_MODE_LABEL = { live: '真实接入', mock: '模拟数据', replay: '回放数据' };

const status = computed(() => response.value?.status || '');
const forecast = computed(() => response.value?.forecast || null);
const sourcePeriods = computed(() => Array.isArray(forecast.value?.periods) ? forecast.value.periods : []);
const planWindow = computed(() => {
  const from = timestamp(props.startAt), to = timestamp(props.endAt);
  return from !== null && to !== null && from < to ? { from, to } : null;
});
const validSourcePeriods = computed(() => sourcePeriods.value.map(item => {
  const from = timestamp(item?.from), to = timestamp(item?.to);
  return from !== null && to !== null && from < to ? { ...item, from, to } : null;
}).filter(Boolean).sort((a, b) => a.from - b.from));
// 同一区域的好几份预报会合在一起列出（CDX-P06）：发布时间不止一个时，每张卡片标出自己是哪次发布的。
const publishedTimes = computed(() => new Set(validSourcePeriods.value.map(item => timestamp(item.published_at)).filter(value => value !== null)));
const severalForecasts = computed(() => publishedTimes.value.size > 1);
const periods = computed(() => {
  if (!planWindow.value) return [];
  return validSourcePeriods.value.flatMap(item => {
    const { from, to } = item;
    const start = Math.max(from, planWindow.value.from), end = Math.min(to, planWindow.value.to);
    return start < end ? [{ ...item, from: start, to: end }] : [];
  }).sort((a, b) => a.from - b.from);
});
const planWindowText = computed(() => planWindow.value ? `${time(planWindow.value.from)} 至 ${time(planWindow.value.to)}` : '未提供');
const sourceWindowText = computed(() => validSourcePeriods.value.length
  ? validSourcePeriods.value.map(period => `${time(period.from)} 至 ${time(period.to)}`).join('；')
  : '未提供有效预报时段');
const uncoveredMessage = computed(() => `任务飞行时段：${planWindowText.value}；预报时段：${sourceWindowText.value}。两者没有时间交集。`);
const statusCopy = computed(() => response.value?.message || STATUS_COPY[status.value] || '天气预报不可用');
const canRetry = computed(() => error.value && ![401, 403].includes(error.value.status));
const errorTitle = computed(() => error.value?.status === 403
  ? '无天气数据查看权限'
  : (error.value?.status === 401 ? '登录状态已失效' : '天气预报读取失败'));
const errorMessage = computed(() => error.value?.message || '天气预报读取失败');

async function loadForecast() {
  const current = ++requestVersion;
  const requestedPlanId = String(props.planId ?? '');
  response.value = null;
  error.value = null;
  if (!requestedPlanId) { loading.value = false; return; }
  loading.value = true;
  try {
    const result = await weatherForecastApi.forPlan(requestedPlanId);
    if (current !== requestVersion) return;
    if (String(result?.plan_id ?? '') !== requestedPlanId) throw new Error('天气预报与当前任务不一致，请重新读取。');
    response.value = result;
  } catch (requestError) {
    if (current === requestVersion) error.value = requestError;
  } finally {
    if (current === requestVersion) loading.value = false;
  }
}

watch(() => props.planId, loadForecast, { immediate: true });
onUnmounted(() => {
  requestVersion++;
});

function present(value) { return value !== null && value !== undefined && value !== ''; }
function timestamp(value) {
  if (!present(value) || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && Number.isFinite(new Date(number).getTime()) ? number : null;
}
function hasField(item, key) { return Object.prototype.hasOwnProperty.call(item || {}, key); }
function amount(value, unit) { return present(value) ? `${value}${unit}` : '未提供'; }
function time(value) {
  if (!present(value) || !Number.isFinite(Number(value))) return '未提供';
  return new Date(Number(value)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
function periodTime(item) {
  if (!item || (!present(item.from) && !present(item.to))) return '时段未提供';
  return `${time(item.from)} 至 ${time(item.to)}`;
}
function periodCoversPlan(item) {
  return Boolean(planWindow.value && item && item.from < planWindow.value.to && item.to > planWindow.value.from);
}
function direction(value) { return present(value) ? `${value}°` : '未提供'; }
function sourceMode(value) { return SOURCE_MODE_LABEL[value] || (present(value) ? value : '未提供'); }
</script>

<template>
  <section class="plan-weather" aria-live="polite">
    <div v-if="loading" class="empty">正在读取天气预报</div>
    <div v-else-if="error" class="weather-state" role="alert">
      <strong>{{ errorTitle }}</strong>
      <p>{{ errorMessage }}</p>
      <button v-if="canRetry" class="btn" type="button" @click="loadForecast">重新读取</button>
    </div>
    <div v-else-if="STATUS_COPY[status]" class="weather-state">
      <strong>{{ statusCopy }}</strong>
    </div>
    <template v-else-if="forecast && (status === 'READY' || status === 'STALE')">
      <dl class="kv kv-surface weather-summary">
        <dt>预报区域</dt><dd><span class="tag" :class="forecast.area_name ? 't-cyan' : 't-gray'">{{ forecast.area_name || '未提供' }}</span></dd>
        <dt>数据来源</dt><dd>{{ forecast.provider_name || '未提供' }}<small><span class="tag" :class="({ live: 't-blue', mock: 't-amber', replay: 't-purple' })[forecast.source_mode] || 't-gray'">{{ sourceMode(forecast.source_mode) }}</span></small></dd>
        <dt>{{ severalForecasts ? '最新发布时间' : '发布时间' }}<br>（北京时间）</dt><dd>{{ time(forecast.published_at) }}</dd>
      </dl>
      <div v-if="!planWindow" class="weather-state"><strong>任务飞行时段不完整</strong><p>无法确定对应的天气预报覆盖关系，以下仍展示收到的预报时段。</p></div>
      <div v-else-if="!validSourcePeriods.length" class="weather-state"><strong>预报没有有效时段</strong><p>当前天气报文未提供可展示的开始时间和结束时间。</p></div>
      <div v-if="validSourcePeriods.length" class="forecast-periods">
        <article v-for="(item, index) in validSourcePeriods" :key="`${item.from ?? 'unknown'}-${item.to ?? 'unknown'}-${index}`" class="forecast-period">
          <header><strong>{{ periodTime(item) }}</strong><span class="tag" :class="item.summary ? 't-cyan' : 't-gray'">{{ item.summary || '天气现象未提供' }}</span><span v-if="planWindow" class="tag" :class="periodCoversPlan(item) ? 't-green' : 't-gray'">{{ periodCoversPlan(item) ? '覆盖任务时段' : '未覆盖任务时段' }}</span><small v-if="severalForecasts && timestamp(item.published_at) !== null" class="forecast-published">发布于 {{ time(item.published_at) }}</small></header>
          <dl class="weather-grid">
            <div v-if="hasField(item, 'temperature_c')" class="weather-temperature"><dt>温度</dt><dd>{{ amount(item.temperature_c, '°C') }}</dd></div>
            <div v-if="hasField(item, 'wind_speed_ms')" class="weather-wind"><dt>风速</dt><dd>{{ amount(item.wind_speed_ms, ' m/s') }}</dd></div>
            <div v-if="hasField(item, 'gust_ms')" class="weather-gust"><dt>阵风</dt><dd>{{ amount(item.gust_ms, ' m/s') }}</dd></div>
            <div v-if="hasField(item, 'wind_direction_deg')" class="weather-direction"><dt>风向</dt><dd>{{ direction(item.wind_direction_deg) }}</dd></div>
            <div v-if="hasField(item, 'precipitation_probability_pct')" class="weather-rain"><dt>降水概率</dt><dd>{{ amount(item.precipitation_probability_pct, '%') }}</dd></div>
            <div v-if="hasField(item, 'precipitation_mm')" class="weather-rain"><dt>降水量</dt><dd>{{ amount(item.precipitation_mm, ' mm') }}</dd></div>
            <div v-if="hasField(item, 'humidity_pct')" class="weather-humidity"><dt>湿度</dt><dd>{{ amount(item.humidity_pct, '%') }}</dd></div>
            <div v-if="hasField(item, 'pressure_hpa')" class="weather-pressure"><dt>气压</dt><dd>{{ amount(item.pressure_hpa, ' hPa') }}</dd></div>
            <div v-if="hasField(item, 'visibility_km')" class="weather-visibility"><dt>能见度</dt><dd>{{ amount(item.visibility_km, ' km') }}</dd></div>
          </dl>
        </article>
      </div>
      <div v-if="planWindow && validSourcePeriods.length && !periods.length" class="weather-state"><strong>预报区域已匹配，但未覆盖任务飞行时段</strong><p>{{ uncoveredMessage }}</p></div>
    </template>
    <div v-else-if="status === 'STALE'" class="weather-state">
      <strong>当前任务暂无天气预报</strong>
    </div>
    <div v-else class="weather-state">
      <strong>天气预报状态未知</strong>
      <p>{{ response?.message || '当前服务没有返回可识别的天气预报状态。' }}</p>
    </div>
  </section>
</template>

<style scoped>
.plan-weather { min-width: 0; }
.plan-weather .tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; line-height: 1.6; }
.weather-state { display: grid; justify-items: center; gap: 10px; padding: 38px 16px; text-align: center; color: var(--txt-2); }
.weather-state strong { color: var(--txt); font-size: 15px; }
.weather-state p { margin: 0; max-width: 38em; color: var(--txt-3); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.weather-summary { margin: 0 0 12px; padding: 8px 0; border: 0; border-bottom: 1px solid var(--line-2); border-radius: 0; background: transparent; }
.weather-summary dd { min-width: 0; overflow-wrap: anywhere; }
.weather-summary small { display: block; margin-top: 3px; color: var(--txt-3); font-size: 11px; }
.forecast-periods { display: grid; gap: 10px; }
.forecast-period { min-width: 0; padding: 11px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-gradient); }
.forecast-period header { display: grid; gap: 4px; padding-bottom: 9px; border-bottom: 1px solid var(--line-2); }
.forecast-period header strong { font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.forecast-period header .tag { justify-self: start; font-size: 12px; }
.forecast-period header .forecast-published { color: var(--txt-3); font-size: 11px; }
.weather-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 10px 0 0; }
.weather-grid div { --weather-accent: var(--cyan); min-width: 0; padding: 9px 10px; border: 1px solid color-mix(in srgb, var(--weather-accent) 28%, transparent); border-left: 3px solid var(--weather-accent); border-radius: 6px; background: color-mix(in srgb, var(--weather-accent) 6%, transparent); }
.weather-grid .weather-temperature { --weather-accent: var(--amber); }
.weather-grid .weather-gust, .weather-grid .weather-pressure { --weather-accent: var(--purple); }
.weather-grid .weather-direction, .weather-grid .weather-rain { --weather-accent: var(--blue); }
.weather-grid .weather-humidity, .weather-grid .weather-visibility { --weather-accent: var(--green); }
.weather-grid dt { color: var(--weather-accent); font-size: 11px; }
.weather-grid dd { margin: 4px 0 0; color: var(--txt); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
@media (max-width: 760px) { .weather-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
