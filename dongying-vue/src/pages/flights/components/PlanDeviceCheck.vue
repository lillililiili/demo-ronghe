<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { checkPlanDevices, deviceCheckStatus } from '@/pages/flights/planDeviceCheck.js';
import { hasPermission } from '@/services/accessControl.js';
import DeviceAbnormalNoticeButton from './DeviceAbnormalNoticeButton.vue';
const { deviceIcon, deviceMeta } = window.UI;

const props = defineProps({ plan: { type: Object, required: true } });
const result = ref(null), loading = ref(false), error = ref(''), errorStatus = ref(0);
const permitted = computed(() => hasPermission('devices.read') && hasPermission('monitoring.read'));
let controller = null, generation = 0;
const rows = computed(() => result.value?.rows || []);
const emit = defineEmits(['checked', 'map-devices']);
const abnormalRows = computed(() => rows.value.filter(row => row.abnormal || row.incidents?.length));
const normalCount = computed(() => rows.value.filter(row => deviceCheckStatus(row) === '正常').length);
function date(value) { return value == null || !Number.isFinite(Number(value)) ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
async function reload({ reset = false } = {}) {
  controller?.abort(); controller = new AbortController();
  const current = ++generation;
  if (reset) { result.value = null; emit('map-devices', null); }
  error.value = ''; errorStatus.value = 0; emit('checked', null);
  if (!permitted.value) { result.value = null; emit('map-devices', null); loading.value = false; return; }
  loading.value = true;
  try { const data = await checkPlanDevices(props.plan, controller.signal); if (generation === current) { result.value = data; emit('checked', data); emit('map-devices', data); } }
  catch (reason) { if (generation === current) { error.value = reason.message || '设备检查失败'; errorStatus.value = reason.status || 0; emit('map-devices', null); if ([401,403].includes(errorStatus.value)) result.value = null; } }
  finally { if (generation === current) loading.value = false; }
}
watch(() => [props.plan.plan_id, props.plan.start_at, props.plan.end_at, props.plan.district_name, props.plan.source_mode, permitted.value], () => reload({ reset: true }), { immediate: true });
const timer = setInterval(() => { if (!document.hidden && !loading.value && ![401, 403].includes(errorStatus.value)) reload(); }, 30000);
onUnmounted(() => { generation++; controller?.abort(); clearInterval(timer); emit('map-devices', null); });
</script>

<template>
  <div class="device-check">
    <header><b>设备自动检查</b><div class="device-actions"><button v-if="permitted" class="btn ghost" type="button" :disabled="loading || [401,403].includes(errorStatus)" @click="reload">{{ loading ? '更新中…' : '重新检查' }}</button></div></header>
    <p v-if="!permitted">没有设备监测查看权限，请联系管理员。</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !result">正在读取附近设备状态和告警…</p>
    <p v-if="result && (loading || error)">{{ loading ? '正在更新，下方保留上次检查结果。' : '本次更新失败，下方是上次检查结果。' }}</p>
    <template v-if="permitted && result">
      <p v-if="result.mqtt_simulation"><span class="tag t-gray">MQTT 模拟数据</span></p>
      <p class="check-summary">{{ result.message }}</p>
      <p class="scope-note">航线周边 {{ Number(result.nearby_meters) / 1000 }} 公里 · 已检查 {{ rows.length }} 台设备</p>
      <p v-if="rows.length">正常 {{ normalCount }} 台 · 异常 {{ abnormalRows.length }} 台 · 待核查 {{ rows.length - normalCount - abnormalRows.length }} 台</p>
      <p v-if="result.unchecked_locations">{{ result.unchecked_locations }} 台设备缺少可用位置，无法确认是否在附近。</p>
      <p v-if="!result.complete && rows.length">部分信息不完整，请核查下方设备。</p>
      <div v-if="rows.length" class="device-rows">
        <article v-for="row in rows" :key="row.device_id">
          <div class="device-heading"><span class="device-type-icon" :title="deviceMeta(row).label" :class="row.abnormal ? 'is-abnormal' : row.incidents?.length ? 'is-historical' : deviceCheckStatus(row) === '正常' ? 'is-normal' : ''" v-html="deviceIcon(row)"></span><b>{{ row.name }}</b><span v-if="row.simulated" class="tag t-gray">模拟设备</span><span class="tag" :class="row.abnormal ? 't-red' : row.incidents?.length ? 't-amber' : deviceCheckStatus(row) === '正常' ? 't-green' : 't-gray'">{{ deviceCheckStatus(row) }}</span><DeviceAbnormalNoticeButton class="device-detail-link" :plan-id="plan.plan_id" :device="row" /></div>
          <p>{{ deviceMeta(row).label }}</p>
          <p v-if="!row.position">暂时无法取得设备位置。</p>
          <p>距航线 {{ (Number(row.distance_m) / 1000).toFixed(2) }} 公里 · 最近在线上报：{{ date(row.last_heartbeat_at) }}</p>
          <p v-if="row.abnormal">{{ ['BAD','DEGRADED'].includes(row.health_code) ? '设备运行异常' : '设备当前有异常' }} · 状态上报时间：{{ date(row.observed_at) }}</p>
          <p v-if="row.abnormal && !row.incidents?.length">尚无对应时段的告警记录，异常开始时间不明。</p>
          <p v-for="item in row.incidents" :key="item.incident_id">{{ item.reason }} · {{ date(item.detected_at) }}<span v-if="item.closed_at">（{{ date(item.closed_at) }} 已关闭）</span><span v-else>（尚未关闭）</span></p>
          <p v-if="!row.complete">该设备信息不完整。</p>
        </article>
      </div>
      <footer>检查于 {{ date(result.checked_at) }} · 每 30 秒更新</footer>
    </template>
  </div>
</template>

<style scoped>
.device-check { margin: 10px 0; padding: 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
header,.device-heading,.device-actions,footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
header { justify-content: space-between; }
p { color: var(--txt-3); margin: 5px 0; line-height: 1.5; overflow-wrap: anywhere; }
.check-summary { color: var(--txt-1); }
.device-rows { max-height: 230px; overflow: auto; }
article { padding: 8px 0; border-top: 1px solid var(--line); }
summary { cursor: pointer; }
footer { margin-top: 8px; color: var(--txt-3); font-size: 11px; }
.device-heading b { min-width: 0; overflow-wrap: anywhere; }
.device-type-icon { display:inline-flex;flex-shrink:0;padding:4px;font-size:24px;border:0;color:var(--gray);background:transparent; }
.device-type-icon :deep(svg) { width:24px;height:24px; }
.device-type-icon.is-abnormal { color: var(--red); }
.device-type-icon.is-historical { color: var(--amber); }
.device-type-icon.is-normal { color: var(--green); }
.device-detail-link { margin-left: auto; flex-shrink: 0; }
</style>
