<script setup>
import { computed, onUnmounted } from 'vue';
import { autoSmsView } from './autoSmsView.js';
import { openFormModal } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';

const props = defineProps({ data: Object, disabled: Boolean, compact: Boolean });
const emit = defineEmits(['changed']);
let alive = true;
onUnmounted(() => { alive = false; });
const view = computed(() => autoSmsView(props.data));
const compactTitle = computed(() => ({ WAITING: '等待发送', SENDING: '正在发送', SIMULATED_DELIVERED: '已送达', UNKNOWN: '发送结果未知', FAILED: '发送失败', UNAVAILABLE: '通道未接通', BLOCKED: '暂不满足发送条件', DISABLED: '未启用' })[props.data?.auto_sms?.status] || view.value.title);
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
function retry() {
  if (!view.value.canRetry || props.disabled) return;
  const id = props.data.event_id, version = props.data.event_version;
  const key = newHandoffIdempotencyKey();
  const modal = openFormModal({
    title: '重新发送飞手短信', confirmText: '提交重试', width: '520px',
    notice: '后台会重新检查当前目标、研判和通道条件；提交后以发送记录为准。',
    warning: view.value.simulated ? '当前使用模拟短信，不会发送真实短信。' : '',
    fields: [{ key: 'note', label: '重试说明', type: 'textarea', required: true, minRows: 3, placeholder: '说明已经核查或处理了什么问题' }],
    initial: { note: '' },
    validate: value => String(value.note || '').trim() ? null : '请填写重试说明',
    onSubmit: async value => {
      const current = () => alive && id === props.data?.event_id && modal.isCurrent();
      if (!current()) throw new Error('事件已切换，请关闭后重新操作');
      try {
        await uavAdvisoryApi.retrySms(id, { expected_version: version, note: String(value.note).trim() }, key);
        if (!current()) return;
        modal.close(); emit('changed'); toast('已提交重试，请查看后台发送结果', 'ok');
      } catch (error) {
        if (!current()) return;
        emit('changed');
        throw new Error(error.code === 'VERSION_CONFLICT' ? '事件已有更新，请关闭弹窗，核对最新状态后重试。' : error.message || '提交结果尚未确认，请回读记录核查');
      }
    }
  });
}
</script>

<template>
  <section class="auto-sms-notice" :class="{ 'is-compact': compact }" aria-label="飞手短信通知" :data-state="data?.auto_sms?.status">
    <component :is="compact ? 'details' : 'div'" :key="data?.event_id" :open="compact && data?.auto_sms?.status === 'BLOCKED'">
      <summary v-if="compact" class="notice-summary">
        <b>飞手短信</b><span class="notice-result" :class="`asn-${view.tone}`">{{ compactTitle }}</span>
        <span v-if="view.simulated" class="tag t-amber">模拟</span><span class="notice-toggle">详情</span>
      </summary>
      <header v-if="!compact"><b>飞手短信</b><span v-if="view.simulated" class="tag t-amber">模拟短信</span></header>
      <p v-if="!compact" class="asn-title" :class="`asn-${view.tone}`">{{ view.title }}</p>
      <p v-if="view.reason">{{ view.reason }}</p>
      <p v-if="view.guidance">{{ view.guidance }}</p>
      <dl v-if="view.recipient || view.triggeredAt || view.updatedAt">
        <template v-if="view.recipient"><dt>接收飞手</dt><dd>{{ view.recipient }}<small v-if="view.recipientHint" style="display:block">{{ view.recipientHint }}</small></dd></template>
        <template v-if="view.triggeredAt"><dt>触发时间</dt><dd>{{ time(view.triggeredAt) }}</dd></template>
        <template v-if="view.updatedAt && view.updatedAt !== view.triggeredAt"><dt>状态更新</dt><dd>{{ time(view.updatedAt) }}</dd></template>
      </dl>
      <p v-if="!view.recipient" class="asn-recipient">未提供接收飞手信息</p>
      <p v-if="compact && view.source === 'RULE_ILLEGAL'">触发依据来自系统研判，无需等待人工核实后再通知。</p>
      <details v-if="!compact && (view.source || view.evaluatedAt || view.dataUpdatedAt)" :key="data?.event_id">
        <summary>查看发送依据与时间</summary>
        <p v-if="view.source">{{ view.source === 'RULE_ILLEGAL' ? '触发依据来自系统研判，无需等待人工核实后再通知。' : view.source === 'MANUAL_CONFIRMATION' ? '人工确认与当前观测' : '后台通知记录' }}</p>
        <p v-if="view.evaluatedAt">研判时间：{{ time(view.evaluatedAt) }}</p>
        <p v-if="view.dataUpdatedAt">观测时间：{{ time(view.dataUpdatedAt) }}</p>
      </details>
      <p class="asn-recipient">送达不代表飞手已读，也不代表目标已飞离。</p>
      <button v-if="view.canRetry" type="button" class="btn sm" :disabled="disabled" @click="retry">重新发送飞手短信</button>
    </component>
  </section>
</template>

<style scoped>
.auto-sms-notice.is-compact{padding:9px 10px;margin-top:8px}.notice-summary{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-height:24px;list-style:none}.notice-summary::-webkit-details-marker{display:none}.notice-summary b{font-size:12px;color:var(--txt)}.notice-result{font-size:12px;font-weight:600}.notice-toggle{margin-left:auto;color:var(--muted);font-size:11px;text-decoration:underline;text-underline-offset:3px}summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}

.auto-sms-notice header{flex-wrap:wrap}.auto-sms-notice .asn-recipient{color:var(--muted)}.auto-sms-notice .btn{white-space:normal;height:auto;min-height:30px}
.auto-sms-notice{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg-soft,rgba(4,22,40,.25));min-width:0}.auto-sms-notice header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}.auto-sms-notice p{font-size:12px;line-height:1.6;margin:7px 0;overflow-wrap:anywhere}.auto-sms-notice .asn-title{font-size:14px;font-weight:600}.asn-success{color:var(--green,#52d6a5)}.asn-warning{color:var(--amber,#ffc160)}.asn-muted{color:var(--muted)}.auto-sms-notice dl{display:grid;grid-template-columns:60px minmax(0,1fr);gap:5px 8px;font-size:11px;margin:10px 0}.auto-sms-notice dt{color:var(--muted)}.auto-sms-notice dd{margin:0;overflow-wrap:anywhere}.auto-sms-notice button{margin-top:6px}.auto-sms-notice summary{font-size:11px;color:var(--muted);cursor:pointer}
</style>
