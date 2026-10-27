<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { NButton, NModal } from 'naive-ui';
import { deviceApi } from '@/services/deviceApi.js';
import { authSession } from '@/services/auth.js';
import { displayTargetNo } from '@/ui/deviceNumber.js';

const props = defineProps({ targetId: { type: String, required: true }, deviceId: { type: String, default: '' }, summaryOnly: Boolean });
const emit = defineEmits(['updated']);
const state = ref(null), error = ref(''), busy = ref(false), choice = ref(null), loading = ref(false);
const brief = computed(() => ({ ACTIVE: '已有光电观察任务', SWITCHING: '等待原任务停止后切换',
  WAITING_DEVICE: '等待光电观察（按优先级排队）', BLOCKED: '暂不可观察', IDLE: '暂无光电任务', FAILED: '跟踪请求失败' })[state.value?.status] || '观察状态未知');
const options = computed(() => !error.value && !busy.value ? (state.value?.switch_options || []).filter(option => !props.deviceId || option.device_id === props.deviceId) : []);
let generation = 0, timer, controller, alive = true, pendingAction = null;
function clear() {
  ++generation; clearTimeout(timer); controller?.abort(); state.value = null;
  error.value = ''; choice.value = null; busy.value = false; loading.value = false; pendingAction = null;
}
async function refresh() {
  clearTimeout(timer);
  if (!alive || busy.value || !props.targetId) return;
  const token = ++generation, target = props.targetId;
  controller?.abort(); controller = new AbortController();
  const currentController = controller;
  const deadline = setTimeout(() => currentController.abort(), 12000);
  loading.value = true;
  try {
    const next = await deviceApi.eoDispatch(target, { signal: currentController.signal, dedupe: false });
    if (!alive || token !== generation || target !== props.targetId) return;
    if (next?.target_id !== target || !Array.isArray(next.switch_options)) throw new Error('光电调度状态不完整，请刷新。');
    state.value = next; error.value = '';
    // An open confirmation is bound to the exact task that was displayed.
    if (choice.value && !next.switch_options.some(option => option.task_id === choice.value.task_id)) choice.value = null;
  } catch (e) {
    if (alive && token === generation) { error.value = e.message || '调度状态读取失败，请重试。'; choice.value = null; }
  } finally {
    clearTimeout(deadline);
    if (alive && token === generation) { loading.value = false; timer = setTimeout(refresh, 5000); }
  }
}
async function perform(kind, selected = null) {
  if (busy.value || error.value) return;
  const target = props.targetId, device = props.deviceId, token = ++generation;
  clearTimeout(timer); controller?.abort(); busy.value = true; choice.value = null;
  const signature = `${target}:${device}:${kind}:${selected?.task_id || ''}`;
  if (!pendingAction || pendingAction.signature !== signature) pendingAction = { signature, key: `eo-dispatch-${crypto.randomUUID()}` };
  let failure = '';
  try {
    const result = kind === 'cancel' ? await deviceApi.cancelEoDispatch(target, pendingAction.key)
      : await deviceApi.requestEoDispatch(target, { ...(device ? { device_id: device } : {}), ...(selected ? { expected_task_id: selected.task_id } : {}) }, pendingAction.key);
    if (alive && token === generation && target === props.targetId && device === props.deviceId) { state.value = result; pendingAction = null; emit('updated'); }
  } catch (e) { failure = e.message || '操作结果未确认，请读取最新状态。'; }
  finally {
    if (alive && token === generation && target === props.targetId && device === props.deviceId) {
      busy.value = false; await refresh();
      if (failure && alive && target === props.targetId) error.value = `${failure}；请刷新确认当前状态。`;
    }
  }
}
watch([() => props.targetId, () => props.deviceId, authSession], () => { clear(); refresh(); }, { immediate: true, flush: 'sync' });
onUnmounted(() => { alive = false; clear(); });
</script>

<template>
  <div class="eo-dispatch" aria-label="光电调度">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="state" role="status">{{ summaryOnly ? brief : (state.status === 'FAILED' ? '上次跟踪请求未完成：' : '') + state.message }}</p>
    <p v-else role="status">正在读取光电调度状态</p>
    <div v-if="!summaryOnly" class="dispatch-actions">
      <NButton v-if="error" size="small" :loading="loading" @click="refresh">重读调度状态</NButton>
      <NButton v-if="!error && state?.can_request" size="small" type="primary" :loading="busy" @click="perform('request')">{{ deviceId ? '请求本机跟踪此目标' : '请求跟踪此目标' }}</NButton>
      <NButton v-if="!error && state?.can_cancel" size="small" :disabled="busy" @click="perform('cancel')">取消人工请求</NButton>
      <NButton v-for="option in options" :key="option.task_id" size="small" @click="choice = option">切换{{ option.device_name }}到此目标</NButton>
    </div>
    <p v-if="busy" role="status">正在提交，等待后台确认。</p>
    <NModal :show="!!choice" preset="dialog" title="确认切换光电跟踪" :mask-closable="false" @update:show="open => { if (!open) choice = null; }">
      <p v-if="choice">{{ choice.device_name }}目前正在跟踪{{ displayTargetNo(choice.target_no) }}。切换会中断该目标的当前光电画面；原任务停止确认后，设备才开始跟踪当前选中目标。</p>
      <template #action>
        <NButton @click="choice = null">保持原跟踪</NButton>
        <NButton type="warning" :disabled="busy || !!error || !choice" @click="perform('switch', choice)">确认切换到此目标</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.eo-dispatch { min-width:0; }
p { margin:0 0 10px; line-height:1.6; font-size:13px; overflow-wrap:anywhere; }
[role="alert"] { color:var(--amber); }
.dispatch-actions { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.dispatch-actions :deep(.n-button) { height:auto; min-height:32px; white-space:normal; }
.dispatch-actions :deep(.n-button__content) { white-space:normal; overflow-wrap:anywhere; }
</style>
