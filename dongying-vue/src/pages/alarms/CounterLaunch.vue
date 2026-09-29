<script setup>
import { h, ref, watch, onUnmounted } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { disposalApi } from '@/services/disposalApi.js';
import { readSessionToken } from '@/services/apiClient.js';
import { openDisposalRequest, openDisposalDirect } from '@/ui/disposalAuthModal.js';
import { openModal } from '@/ui/modal.js';

const U = window.UI;
const props = defineProps({ eventId: { type: String, required: true }, eventLabel: String, active: Boolean, showLaunch: Boolean, showRecords: { type: Boolean, default: true } });
const emit = defineEmits(['records']);
const busy = ref(false);
let generation = 0, mounted = true, feedback = null;
watch(() => [props.eventId, props.active], () => { ++generation; busy.value = false; feedback?.close(); }, { flush: 'sync' });
onUnmounted(() => { mounted = false; ++generation; feedback?.close(); });

function showFeedback(title, message) {
  const label = props.eventLabel || props.eventId;
  feedback = openModal({
    title,
    render: () => h('div', { role: 'alert', style: 'overflow-wrap:anywhere' }, [
      h('p', { style: 'margin:0 0 12px' }, label),
      h('p', { style: 'margin:0;white-space:pre-wrap' }, message)
    ])
  });
}

async function launch() {
  if (busy.value || !props.active) return;
  const id = props.eventId, token = readSessionToken(), request = ++generation;
  const isCurrent = () => mounted && props.active && props.eventId === id && request === generation && token === readSessionToken();
  busy.value = true;
  try {
    // 每次点击重新读取资格；页面加载和轮询不创建授权。
    const eligibility = await uavAdvisoryApi.get(id);
    if (!isCurrent()) return;
    if (eligibility?.event_id !== id) throw new Error('未取得当前事件的反制资格，请刷新后重试。');
    if (eligibility.can_direct_counter !== true && eligibility.can_request_counter !== true) {
      showFeedback('暂不能发起反制', eligibility.counter_block_reason || '当前反制资格未确认，暂不能发起。');
      return;
    }
    const policy = await disposalApi.policies();
    if (!isCurrent()) return;
    const open = eligibility.can_direct_counter === true ? openDisposalDirect : openDisposalRequest;
    await open({
      actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: id,
      subjectText: props.eventLabel || id, policy, isCurrent,
      onDone: result => {
        if (isCurrent()) emit('records', { eventId: id, authorizationId: result?.authorization_id || '' });
      }
    });
  } catch (cause) {
    if (isCurrent()) showFeedback('反制条件检查失败', cause?.message || '读取反制资格失败，请稍后重试。');
  } finally {
    if (request === generation) busy.value = false;
  }
}
</script>

<template>
  <section class="counter-launch" aria-label="反制操作">
    <div class="counter-launch-actions">
      <button v-if="showRecords" class="btn" type="button" title="查看本事件反制记录" @click="emit('records', { eventId })">
        <span class="counter-action-icon" aria-hidden="true" v-html="U.icon('clock')"></span>反制记录
      </button>
      <button v-if="showLaunch" class="btn pri" type="button" :disabled="busy" :aria-busy="busy" @click="launch">
        <span class="counter-action-icon" aria-hidden="true" v-html="U.icon('shield')"></span>{{ busy ? '正在检查反制条件' : '发起反制' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.counter-launch { margin-left: auto; min-width: 0; max-width: 100%; }
.counter-launch-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
.counter-launch .btn { white-space: normal; height: auto; min-height: 40px; padding: 8px 14px; }
.counter-action-icon { display: inline-flex; flex: none; }
.counter-action-icon :deep(.svg-icon) { width: 16px; height: 16px; }
</style>
