<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { checkPlanDevices, deviceCheckStatus, deviceCheckCategory, deviceCheckCounts, deviceCheckHistory, deviceCheckExplanation, retainDeviceOrder } from '@/pages/flights/planDeviceCheck.js';
import { maintenanceStateLabel } from '@/pages/flights/maintenanceState.js';
import { loadDeviceMaintenanceNotice } from '@/pages/flights/deviceMaintenance.js';
import { hasPermission } from '@/services/accessControl.js';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import DeviceAbnormalNoticeButton from './DeviceAbnormalNoticeButton.vue';
const { deviceIcon, deviceMeta } = window.UI;

const props = defineProps({ plan: { type: Object, required: true } });
const result = ref(null), loading = ref(false), error = ref(''), errorStatus = ref(0);
const permitted = computed(() => ['flight:read', 'route:read', 'devices.read'].every(hasPermission));
let controller = null, generation = 0;
const rows = computed(() => result.value?.rows || []);
const emit = defineEmits(['checked', 'map-devices']);
const counts = computed(() => deviceCheckCounts(rows.value));
// 不按实时状态自动隐藏设备，避免恢复或新增异常时正在阅读的卡片消失。
function date(value) { return value == null || !Number.isFinite(Number(value)) ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
async function reload({ reset = false, quiet = false } = {}) {
  controller?.abort(); controller = new AbortController();
  const current = ++generation;
  if (reset) { result.value = null; emit('map-devices', null); }
  if (reset) { error.value = ''; errorStatus.value = 0; }
  if (reset) emit('checked', null);
  if (!permitted.value) { result.value = null; emit('map-devices', null); loading.value = false; return; }
  if (!quiet) loading.value = true;
  try {
    const planId = props.plan.plan_id;
    const data = await checkPlanDevices(props.plan, controller.signal);
    if (generation !== current) return;
    await Promise.all(data.rows.map(row => loadDeviceMaintenanceNotice(planId, row.device_id)));
    if (generation === current) {
      const next = { ...data, rows: retainDeviceOrder(data.rows, rows.value) };
      error.value = ''; errorStatus.value = 0; result.value = next;
      emit('checked', next); emit('map-devices', next);
    }
  }
  catch (reason) { if (generation === current) {
    error.value = reason.message || '设备检查失败'; errorStatus.value = reason.status || 0;
    if ([401,403].includes(errorStatus.value)) { result.value = null; emit('map-devices', null); }
    if (quiet) throw reason;
  } }
  finally { if (generation === current) loading.value = false; }
}
watch(() => [props.plan.plan_id, props.plan.start_at, props.plan.end_at, props.plan.district_name, props.plan.source_mode, permitted.value], () => reload({ reset: true }), { immediate: true });
defineExpose({ reload });
useRealtimeRefresh(['device', 'device_state', 'plan'], () => reload({ quiet: true }), { minIntervalMs: 2_000 });
onUnmounted(() => { generation++; controller?.abort(); emit('map-devices', null); });
</script>

<template>
  <div class="device-check">
    <header><b>设备自动检查</b><div class="device-actions"><button v-if="permitted" class="btn ghost" type="button" :disabled="loading || [401,403].includes(errorStatus)" @click="reload">刷新</button></div></header>
    <p v-if="!permitted">需要飞行任务、航线和设备的查看权限，请联系管理员。</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !result">正在读取附近设备状态和告警</p>
    <p v-if="result && error">本次更新失败，下方保留上次检查结果。</p>
    <template v-if="permitted && result">
      <p v-if="result.mqtt_simulation"><span class="tag t-gray">MQTT 模拟数据</span></p>
      <p class="check-summary"><template v-if="error">上次检查： </template>{{ result.message }}</p>
      <p class="scope-note">{{ result.selection_basis === 'DEVICE_SCAN_COVERAGE' ? '扫描范围覆盖航线' : '设备检查' }} · 已检查 {{ rows.length }} 台设备</p>
      <p v-if="rows.length">当前正常 {{ counts.NORMAL }} 台 · 当前异常 {{ counts.ABNORMAL }} 台 · 待核查 {{ counts.UNKNOWN }} 台</p>
      <p v-if="counts.UNKNOWN">待核查表示状态依据不足，未计为异常。</p>
      <p v-if="result.unchecked_locations">{{ result.unchecked_locations }} 台设备缺少位置，无法确认覆盖。</p>
      <p v-if="result.unchecked_coverage">{{ result.unchecked_coverage }} 台设备的扫描范围或航线依据不足，无法确认覆盖。</p>
      <div v-if="rows.length" class="device-rows">
        <article v-for="row in rows" :key="row.device_id">
          <div class="device-heading">
            <span class="device-type-icon" :title="deviceMeta(row).label" :class="deviceCheckCategory(row) === 'ABNORMAL' ? 'is-abnormal' : deviceCheckCategory(row) === 'NORMAL' ? 'is-normal' : ''" v-html="deviceIcon(row)"></span>
            <div class="device-heading-content">
              <b>{{ row.name }}</b>
              <div class="device-status"><span v-if="row.simulated" class="tag t-gray">模拟设备</span><span class="tag" :class="deviceCheckCategory(row) === 'ABNORMAL' ? 't-red' : deviceCheckCategory(row) === 'NORMAL' ? 't-green' : 't-gray'">{{ deviceCheckStatus(row) }}</span></div>
            </div>
          </div>
          <p class="device-meta"><span>{{ deviceMeta(row).label }}</span><span>距航线 {{ (Number(row.distance_m) / 1000).toFixed(2) }} 公里</span><span v-if="!row.complete && row.position && deviceCheckCategory(row) !== 'UNKNOWN'">信息待核查</span></p>
          <p v-if="!row.position">暂时无法取得设备位置。</p>
          <p v-if="deviceCheckExplanation(row)" class="state-explanation">{{ deviceCheckExplanation(row) }}</p>
          <p>最近心跳：{{ date(row.last_heartbeat_at) }}</p>
          <p v-if="row.maintenance" class="maintenance-progress" role="status">后台处置：{{ maintenanceStateLabel(row.maintenance) }} · 在管理后台“设备异常处理”办理</p>
          <p v-if="row.abnormal && ['BAD','DEGRADED'].includes(row.health_code) && !['设备故障','设备异常'].includes(deviceCheckStatus(row))">运行异常</p>
          <p v-if="row.abnormal && row.observed_at != null && date(row.observed_at) !== date(row.last_heartbeat_at)">状态上报：{{ date(row.observed_at) }}</p>
          <p v-if="row.abnormal && !row.incidents?.length">设备告警记录：本任务时段暂无事件记录。</p>
          <details v-if="row.incidents?.length" class="incident-records">
            <summary>{{ deviceCheckHistory(row) }}</summary>
            <p v-for="item in row.incidents" :key="item.incident_id">{{ item.reason }} · {{ date(item.detected_at) }}<span v-if="item.closed_at != null">（{{ date(item.closed_at) }} 已关闭）</span><span v-else>（尚未关闭）</span></p>
          </details>
          <DeviceAbnormalNoticeButton class="device-detail-link" :plan-id="plan.plan_id" :device="row" :refresh-device-state="reload" :show-refresh="false" :stale="!!error" />
        </article>
      </div>
      <footer>最近检查：{{ date(result.checked_at) }} · 每 5 秒自动更新，设备顺序保持不变</footer>
    </template>
  </div>
</template>

<style scoped>
.device-check { margin: 10px 0; padding: 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
header,.device-heading,.device-actions,footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
header { justify-content: space-between; }
p { color: var(--txt-3); margin: 5px 0; line-height: 1.5; overflow-wrap: anywhere; }
.check-summary { color: var(--txt-1); }
.device-check { container: device-check / inline-size; }
.device-rows { min-width: 0; }
@container device-check (min-width: 500px) {
  .device-rows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
}
article { padding: 8px 0; border-top: 1px solid var(--line); }
article p { margin: 2px 0; }
.device-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.incident-records summary { width: fit-content; max-width: 100%; color: var(--cyan); cursor: pointer; line-height: 1.5; overflow-wrap: anywhere; }
.incident-records summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
footer { margin-top: 8px; color: var(--txt-3); font-size: 11px; }
.device-heading { display: grid; grid-template-columns: 24px minmax(0, 1fr); align-items: start; gap: 6px; margin-bottom: 3px; }
.device-heading-content { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 6px; min-width: 0; min-height: 24px; }
.device-heading b { min-width: 0; overflow-wrap: anywhere; }
.device-status { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.device-status .tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.device-type-icon { display:inline-flex;flex-shrink:0;font-size:24px;border:0;color:var(--gray);background:transparent; }
.device-type-icon :deep(svg) { width:24px;height:24px; }
.device-type-icon.is-abnormal { color: var(--red); }
.device-type-icon.is-normal { color: var(--green); }
.device-detail-link { display: flex; margin-top: 4px; }
</style>
