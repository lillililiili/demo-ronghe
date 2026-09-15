<script setup>
import { computed } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { deviceNoticeState, notifyDeviceAbnormal } from '@/pages/flights/deviceMaintenance.js';

const props = defineProps({ planId: { type: String, default: '' }, device: { type: Object, required: true } });
const abnormal = computed(() => props.device.abnormal || props.device.incidents?.some(item => !item.closed_at));
const state = computed(() => deviceNoticeState(props.planId, props.device.device_id));
const blocker = computed(() => !props.planId ? '未选择飞行计划' : !hasPermission('handoff:create') ? '没有通知提交权限' : '');
async function submit() {
  if (blocker.value || state.value.pending || !abnormal.value) return;
  try {
    const task = await notifyDeviceAbnormal(props.planId, props.device.device_id);
    if (task) toast(task.reused ? '后台已有这台设备的运维待办，未重复创建。' : '已生成后台运维待办。', 'ok');
  } catch (error) { toast(error.message, 'err'); }
}
</script>

<template>
  <button v-if="abnormal" class="device-notice-button" type="button" :disabled="!!blocker || state.pending"
    :title="blocker || state.error || (state.task ? `后台待办编号：${state.task.task_id}` : '提交到后台运维待办')"
    :aria-label="`通知${device.name}设备异常`" @click="submit">{{ state.pending ? '正在通知…' : '通知设备异常' }}</button>
</template>

<style scoped>
.device-notice-button { justify-self: start; color: var(--cyan); padding: 4px 8px; border: 1px solid currentColor; border-radius: 4px; background: transparent; font: inherit; cursor: pointer; }
.device-notice-button:hover:not(:disabled) { background: color-mix(in srgb, var(--cyan) 12%, transparent); }
.device-notice-button:disabled { opacity: .55; cursor: not-allowed; }
.device-notice-button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
</style>
