<script setup>
import { computed, onUnmounted } from 'vue';
import { autoVoiceView } from './autoVoiceView.js';
import { openFormModal } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';

const props = defineProps({ data: Object, disabled: Boolean });
const emit = defineEmits(['changed']);
let alive = true;
onUnmounted(() => { alive = false; });
const view = computed(() => autoVoiceView(props.data));
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
function retry() {
  if (!view.value.canRetry || props.disabled) return;
  const id = props.data.event_id, version = props.data.event_version;
  const key = newHandoffIdempotencyKey();
  const modal = openFormModal({
    title: '重新拨打飞手电话', confirmText: '提交重试', width: '520px',
    notice: '后台会重新检查当前研判、接收对象、录音模板和通道；提交后以通话回执为准。',
    warning: view.value.simulated ? '当前使用模拟电话通道，不会拨打真实电话或播放真实录音。' : '',
    fields: [{ key: 'note', label: '重试说明', type: 'textarea', required: true, minRows: 3, placeholder: '说明已经核查或处理了什么问题' }],
    initial: { note: '' },
    validate: value => String(value.note || '').trim() ? null : '请填写重试说明',
    onSubmit: async value => {
      const current = () => alive && id === props.data?.event_id && modal.isCurrent();
      if (!current()) throw new Error('事件已切换，请关闭后重新操作');
      if (props.disabled || !view.value.canRetry) throw new Error('当前状态不允许重拨，请关闭弹窗后核对最新结果。');
      try {
        await uavAdvisoryApi.retryVoice(id, { expected_version: version, note: String(value.note).trim() }, key);
        if (!current()) return;
        modal.close(); emit('changed'); toast('已提交重拨，请查看后台通话结果', 'ok');
      } catch (error) {
        if (!current()) return;
        emit('changed');
        throw new Error(error.code === 'VERSION_CONFLICT' ? '事件已有更新，请关闭弹窗，核对最新状态后重试。'
          : error.message || '提交结果尚未确认，请回读记录核查');
      }
    }
  });
}
</script>

<template>
  <section class="auto-voice-notice" aria-label="飞手电话录音通知" :data-state="data?.auto_voice?.status">
    <header><b>飞手电话录音通知</b><span v-if="view.simulated" class="tag t-amber">模拟电话</span></header>
    <p class="avn-title" :class="`avn-${view.tone}`">{{ view.title }}</p>
    <p v-if="view.reason">{{ view.reason }}</p>
    <dl v-if="view.recipient || view.recordingName || view.triggeredAt || view.updatedAt || view.answeredAt || view.playbackCompletedAt">
      <template v-if="view.recipient"><dt>接收飞手</dt><dd>{{ view.recipient }}<small v-if="view.recipientHint" style="display:block">{{ view.recipientHint }}</small></dd></template>
      <template v-if="view.recordingName"><dt>通知录音</dt><dd>{{ view.recordingName }}</dd></template>
      <template v-if="view.triggeredAt"><dt>触发时间</dt><dd>{{ time(view.triggeredAt) }}</dd></template>
      <template v-if="view.answeredAt"><dt>{{ view.simulated ? '模拟接通' : '接通时间' }}</dt><dd>{{ time(view.answeredAt) }}</dd></template>
      <template v-if="view.playbackCompletedAt"><dt>{{ view.simulated ? '模拟播完' : '播放完成' }}</dt><dd>{{ time(view.playbackCompletedAt) }}</dd></template>
      <template v-if="view.updatedAt && view.updatedAt !== view.triggeredAt"><dt>状态更新</dt><dd>{{ time(view.updatedAt) }}</dd></template>
    </dl>
    <p v-if="!view.recipient" class="avn-muted">未提供接收飞手信息</p>
    <details v-if="view.source || view.evaluatedAt || view.dataUpdatedAt" :key="data?.event_id">
      <summary>查看拨打依据与时间</summary>
      <p v-if="view.source">{{ view.source === 'RULE_ILLEGAL' ? '系统违规研判' : view.source === 'MANUAL_CONFIRMATION' ? '人工确认与当前观测' : '后台通知记录' }}</p>
      <p v-if="view.evaluatedAt">研判时间：{{ time(view.evaluatedAt) }}</p>
      <p v-if="view.dataUpdatedAt">观测时间：{{ time(view.dataUpdatedAt) }}</p>
    </details>
    <p class="avn-muted">接通与录音播放完成分别以回执为准，不代表飞手已理解或目标已飞离。</p>
    <button v-if="view.canRetry" type="button" class="btn sm" :disabled="disabled" @click="retry">重新拨打飞手电话</button>
  </section>
</template>

<style scoped>
.auto-voice-notice{margin-top:10px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg-soft);min-width:0}.auto-voice-notice header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:13px}.auto-voice-notice p{font-size:12px;line-height:1.6;margin:7px 0;overflow-wrap:anywhere}.auto-voice-notice .avn-title{font-size:14px;font-weight:600}.avn-success{color:var(--green)}.avn-warning{color:var(--amber)}.avn-muted{color:var(--muted)}.auto-voice-notice dl{display:grid;grid-template-columns:60px minmax(0,1fr);gap:5px 8px;font-size:11px;margin:10px 0}.auto-voice-notice dt{color:var(--muted)}.auto-voice-notice dd{margin:0;overflow-wrap:anywhere}.auto-voice-notice .btn{margin-top:6px;white-space:normal;height:auto;min-height:30px}.auto-voice-notice summary{font-size:11px;color:var(--muted);cursor:pointer}.auto-voice-notice button:focus-visible,.auto-voice-notice summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
</style>
