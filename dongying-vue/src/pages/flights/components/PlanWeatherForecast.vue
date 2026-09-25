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
  EMPTY: '当前计划暂无天气预报'
};
const SOURCE_MODE_LABEL = { live: '真实接入', mock: '模拟数据', replay: '回放数据' };

const status = computed(() => response.value?.status || '');
const forecast = computed(() => response.value?.forecast || null);
const sourcePeriods = computed(() => Array.isArray(forecast.value?.periods) ? forecast.value.periods : []);
const planWindow = computed(() => {
  const from = timestamp(props.startAt), to = timestamp(props.endAt);
  return from !== null && to !== null && from < to ? { from, to } : null;
});
const periods = computed(() => {
  if (!planWindow.value) return [];
  return sourcePeriods.value.flatMap(item => {
    const from = timestamp(item?.from), to = timestamp(item?.to);
    if (from === null || to === null || from >= to) return [];
    const start = Math.max(from, planWindow.value.from), end = Math.min(to, planWindow.value.to);
    return start < end ? [{ ...item, from: start, to: end }] : [];
  }).sort((a, b) => a.from - b.from);
});
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
    if (String(result?.plan_id ?? '') !== requestedPlanId) throw new Error('天气预报与当前计划不一致，请重新读取。');
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
        <dt>预报区域</dt><dd>{{ forecast.area_name || '未提供' }}</dd>
        <dt>数据来源</dt><dd>{{ forecast.provider_name || '未提供' }}<small>{{ sourceMode(forecast.source_mode) }}</small></dd>
        <dt>发布时间<br>（北京时间）</dt><dd>{{ time(forecast.published_at) }}</dd>
      </dl>
      <div v-if="!planWindow" class="weather-state"><strong>计划飞行时段不完整</strong><p>无法确定对应的天气预报时段。</p></div>
      <div v-else-if="periods.length" class="forecast-periods">
        <article v-for="(item, index) in periods" :key="`${item.from ?? 'unknown'}-${item.to ?? 'unknown'}-${index}`" class="forecast-period">
          <header><strong>{{ periodTime(item) }}</strong><span>{{ item.summary || '天气现象未提供' }}</span></header>
          <dl class="weather-grid">
            <div v-if="hasField(item, 'temperature_c')"><dt>温度</dt><dd>{{ amount(item.temperature_c, '°C') }}</dd></div>
            <div v-if="hasField(item, 'wind_speed_ms')"><dt>风速</dt><dd>{{ amount(item.wind_speed_ms, ' m/s') }}</dd></div>
            <div v-if="hasField(item, 'gust_ms')"><dt>阵风</dt><dd>{{ amount(item.gust_ms, ' m/s') }}</dd></div>
            <div v-if="hasField(item, 'wind_direction_deg')"><dt>风向</dt><dd>{{ direction(item.wind_direction_deg) }}</dd></div>
            <div v-if="hasField(item, 'precipitation_probability_pct')"><dt>降水概率</dt><dd>{{ amount(item.precipitation_probability_pct, '%') }}</dd></div>
            <div v-if="hasField(item, 'precipitation_mm')"><dt>降水量</dt><dd>{{ amount(item.precipitation_mm, ' mm') }}</dd></div>
            <div v-if="hasField(item, 'humidity_pct')"><dt>湿度</dt><dd>{{ amount(item.humidity_pct, '%') }}</dd></div>
            <div v-if="hasField(item, 'pressure_hpa')"><dt>气压</dt><dd>{{ amount(item.pressure_hpa, ' hPa') }}</dd></div>
            <div v-if="hasField(item, 'visibility_km')"><dt>能见度</dt><dd>{{ amount(item.visibility_km, ' km') }}</dd></div>
          </dl>
        </article>
      </div>
      <div v-else class="weather-state"><strong>计划飞行时段暂无天气预报</strong><p>当前预报未覆盖计划飞行时段。</p></div>
    </template>
    <div v-else-if="status === 'STALE'" class="weather-state">
      <strong>当前计划暂无天气预报</strong>
    </div>
    <div v-else class="weather-state">
      <strong>天气预报状态未知</strong>
      <p>{{ response?.message || '当前服务没有返回可识别的天气预报状态。' }}</p>
    </div>
  </section>
</template>

<style scoped>
.plan-weather { min-width: 0; }
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
.forecast-period header span { color: var(--cyan); font-size: 13px; overflow-wrap: anywhere; }
.weather-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; margin: 10px 0 0; }
.weather-grid div { min-width: 0; }
.weather-grid dt { color: var(--txt-3); font-size: 11px; }
.weather-grid dd { margin: 3px 0 0; color: var(--txt); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 760px) { .weather-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
