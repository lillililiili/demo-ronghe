<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { deviceApi } from '@/services/deviceApi.js';
import { hasModuleAction } from '@/services/accessControl.js';
import SimulatedRiskVideo from '@/components/video/SimulatedOpticalVideo.vue';

const props = defineProps({
  risk: { type: Object, default: null },
  target: { type: Object, default: null }
});
const targetId = computed(() => props.target?.target_id || props.risk?.target_id);
const subtype = computed(() => props.target?.subtype || props.risk?.space_fact?.subtype_code);
const demo = computed(() => props.target?.demo);
const task = ref(null), command = ref(null), loading = ref(false), busy = ref(false), error = ref('');
const availability = ref(null);
let generation = 0, refreshTimer = null;
let alive = true;
let preparedTarget = null;
const permission = computed(() => hasModuleAction('devices', 'op'));
// 异物风险保留目标缺失说明；其他风险只有关联目标时才适用光电追踪。
const visible = computed(() => !!props.target || (props.risk?.risk_type !== 'WEATHER'
  && (['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(props.risk?.risk_type) || !!targetId.value)));
const canRead = computed(() => visible.value && !!targetId.value && permission.value);
const blocked = computed(() => !targetId.value ? '监测目标尚未就绪，请刷新记录后重试。'
  : !permission.value ? '当前账号没有设备操作权限，无法查询或发起光电追踪。'
    : availability.value?.block_reason || '');
const active = computed(() => ['OPEN', 'ENDING'].includes(task.value?.status));
const videoVisible = computed(() => task.value?.status === 'OPEN'
  && command.value?.status === 'SUCCEEDED' && command.value?.simulated === true);
const statusText = computed(() => {
  if (loading.value) return '正在读取跟踪状态';
  if (error.value) return '跟踪状态未确认';
  if (!task.value) return '暂无跟踪任务';
  if (task.value.status === 'ENDING') return '正在结束跟踪';
  if (task.value.status === 'CLOSED') return '跟踪已结束';
  if (task.value.status === 'FAILED') return '跟踪失败';
  const state = command.value?.status;
  return ({ QUEUED: '指令已排队', SENT: '指令已下发，等待设备回执', SUCCEEDED: '设备已确认跟踪指令', FAILED: '指令执行失败', TIMED_OUT: '设备回执超时' })[state] || '跟踪任务已建立，等待设备状态';
});
async function refresh(silent = false) {
  clearTimeout(refreshTimer);
  const current = ++generation, target = targetId.value;
  if (!silent) { task.value = null; command.value = null; availability.value = null; }
  error.value = ''; loading.value = false;
  if (!canRead.value) return;
  loading.value = !silent;
  try {
    if (demo.value && preparedTarget !== target) {
      await deviceApi.prepareAirspaceDemoTarget(target, demo.value.frame);
      if (current !== generation) return;
      preparedTarget = target;
    }
    const result = await deviceApi.currentEoTrack(target);
    if (current !== generation) return;
    if (task.value?.command_id !== result?.command_id || !result) command.value = null;
    task.value = result;
    if (active.value) availability.value = null;
    if (result?.command_id) {
      const detail = await deviceApi.command(result.command_id);
      if (current === generation) command.value = detail;
    }
    if (current !== generation) return;
    if (!active.value) {
      const result = await deviceApi.eoTrackAvailability(target);
      if (current === generation) availability.value = result;
    }
  } catch (e) { if (current === generation) error.value = e.message || '跟踪状态读取失败'; }
  finally {
    if (current === generation) {
      loading.value = false;
      if (alive && canRead.value && !error.value) refreshTimer = setTimeout(() => {
        if (!busy.value) refresh(true);
      }, active.value ? 2000 : 5000);
    }
  }
}
async function begin() {
  if (!canRead.value || !availability.value?.available || busy.value || loading.value || error.value || active.value) return;
  clearTimeout(refreshTimer);
  const current = ++generation;
  busy.value = true; error.value = '';
  try {
    if (demo.value) await deviceApi.beginAirspaceDemoTrack(targetId.value, demo.value.frame);
    else await deviceApi.beginEoTrack(targetId.value, { reason: props.risk ? '风险详情人工发起光电追踪' : '监测目标详情人工发起光电追踪' });
    if (current === generation) await refresh();
  } catch (e) { if (current === generation) error.value = e.message || '光电追踪下发失败'; }
  finally { busy.value = false; }
}
async function end() {
  if (!permission.value || task.value?.status !== 'OPEN' || busy.value) return;
  clearTimeout(refreshTimer);
  const current = ++generation;
  busy.value = true; error.value = '';
  try {
    await deviceApi.endEoTrack(task.value.task_id);
    if (current === generation) await refresh();
  } catch (e) { if (current === generation) error.value = e.message || '结束光电追踪下发失败'; }
  finally { busy.value = false; }
}
watch([() => props.risk?.risk_id, targetId, canRead], () => refresh(), { immediate: true });
onUnmounted(() => { alive = false; generation++; clearTimeout(refreshTimer); });
</script>

<template>
  <section v-if="visible" class="sect optical-panel">
    <h4>光电追踪与视频 <span v-if="videoVisible" class="tag t-amber">模拟视频</span></h4>
    <SimulatedRiskVideo v-if="videoVisible" :key="targetId" :subtype="subtype" />
    <div v-if="canRead" class="tracking-status" role="status">{{ statusText }}</div>
    <p v-if="blocked" class="tracking-note">{{ blocked }}</p>
    <p v-if="error" class="warnbox" role="alert">{{ error }}</p>
    <div v-if="canRead" class="tracking-actions">
      <button v-if="!active" class="btn" :disabled="busy || loading || !!error || !availability?.available" :title="error ? '跟踪状态未确认，请先刷新跟踪状态' : loading ? '正在读取跟踪状态' : blocked" @click="begin">{{ busy ? '正在下发' : '发起光电追踪' }}</button>
      <button v-if="task?.status === 'OPEN'" class="btn danger" :disabled="!permission || busy || loading" @click="end">{{ busy ? '正在结束' : '结束追踪' }}</button>
      <button class="btn" :disabled="loading || busy" @click="refresh()">{{ loading ? '正在读取' : '刷新跟踪状态' }}</button>
    </div>
  </section>
</template>

<style scoped>
.optical-panel h4 { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.tracking-status { margin-top:10px; font-weight:600; }
.tracking-note { color:var(--txt-3); font-size:12px; line-height:1.6; margin:6px 0 10px; }
.tracking-actions { display:flex; flex-wrap:wrap; gap:8px; }
</style>
