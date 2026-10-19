<script setup>
import { onUnmounted, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { loadAttentionDeviceTasks } from '@/pages/flights/planAttention.js';
import { maintenanceState, maintenanceStateLabel } from '@/pages/flights/maintenanceState.js';
import { displayPlanNo } from '@/ui/deviceNumber.js';
const props = defineProps({ planId: { type: String, required: true }, planNo: String, taskIds: { type: Array, required: true } });
const items = ref([]), loading = ref(false), error = ref(''), missing = ref(0), loaded = ref(false);
let generation = 0;
function guidance(task) {
  const state = maintenanceState(task);
  if (state === 'COMPLETED' || state === 'LEGACY_HANDLED') return '这份处置单已结束，请刷新任务列表查看其余事项。';
  if (state === 'READY_TO_COMPLETE') return '请后台人员查看恢复核验依据，并点击“确认办结”。';
  if (state === 'PENDING') return '请后台人员点击“接手处理”，排查供电、网络和设备故障。';
  return '由后台人员继续排查、修复；系统核验恢复后，再确认办结。';
}
async function reload(quiet = false) {
  if (loading.value) return;
  const current = ++generation;
  loading.value = true;
  try {
    const result = await loadAttentionDeviceTasks(props.planId, props.taskIds, flightApi.maintenanceTasks, () => current === generation);
    if (!result || current !== generation) return;
    items.value = result.items; missing.value = result.missing; error.value = ''; loaded.value = true;
  } catch (reason) {
    if (current !== generation) return;
    error.value = reason.message || '读取处置进度失败，请重试。';
    if ([401, 403, 404].includes(reason.status)) { items.value = []; loaded.value = false; }
    if (quiet) throw reason;
  } finally { if (current === generation) loading.value = false; }
}
watch(() => [props.planId, props.taskIds.join(',')], () => { generation++; loading.value = false; items.value = []; loaded.value = false; error.value = ''; void reload(); }, { immediate: true });
useRealtimeRefresh(['device', 'plan', 'plan_check'], () => reload(true), { minIntervalMs: 2_000 });
onUnmounted(() => { generation++; });
</script>

<template>
  <div class="plan-maintenance-progress">
    <div class="progress-heading"><b>任务 {{ displayPlanNo(planNo) || planNo || '编号未提供' }}</b><button class="btn ghost" type="button" :disabled="loading" @click="reload()">刷新进度</button></div>
    <p class="progress-guide">办理入口：由后台人员进入“运维管理 → 设备异常处理”，按下方设备和处置单找到原单。</p>
    <p v-if="loading && !loaded" role="status">正在读取关联设备处置单…</p>
    <p v-if="error" class="progress-error" role="alert">{{ error }}<span v-if="loaded"> 下方保留上次读取的记录，当前进度待确认。</span><button class="btn ghost" :disabled="loading" type="button" @click="reload()">重新读取</button></p>
    <p v-if="loaded && missing">有 {{ missing }} 份关联处置单未能读取，请关闭后刷新任务；不能据此认为已办结。</p>
    <article v-for="task in items" :key="task.task_id" class="progress-task">
      <div class="progress-heading"><b>{{ task.device_name || '未命名设备' }}</b><span class="tag" :class="error ? 't-amber' : 't-gray'">{{ error ? '上次进度：' : '' }}{{ maintenanceStateLabel(task) }}</span><span v-if="task.simulated" class="tag t-gray">模拟设备</span></div>
      <p v-if="task.reason">{{ task.reason }}</p>
      <dl><dt>处置单</dt><dd>{{ task.task_no || task.task_id }}</dd><dt>处理人</dt><dd>{{ task.handled_by_name || '未记录' }}</dd></dl>
      <p v-if="!error" class="progress-next"><b>下一步</b>{{ guidance(task) }}</p>
    </article>
  </div>
</template>

<style scoped>
.plan-maintenance-progress { display: grid; gap: 12px; color: var(--txt); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.progress-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.progress-heading > b { flex: 1; min-width: 120px; }
.progress-guide { margin: 0; color: var(--txt-2); }
.progress-task { border: 1px solid var(--line); border-radius: 6px; padding: 12px; background: var(--panel-2); }
.progress-task p { margin: 8px 0 0; }
.progress-task dl { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 5px; margin: 10px 0; }
.progress-task dt { color: var(--txt-3); }.progress-task dd { margin: 0; }
.progress-next b { margin-right: 8px; color: var(--cyan); }.progress-error { color: var(--amber); }
</style>
