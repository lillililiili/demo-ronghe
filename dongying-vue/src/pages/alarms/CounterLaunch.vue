<script setup>
import { h, ref, computed, watch, onUnmounted } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { disposalApi } from '@/services/disposalApi.js';
import { readSessionToken } from '@/services/apiClient.js';
import { openDisposalRequest, openDisposalDirect } from '@/ui/disposalAuthModal.js';
import { openModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { noCounterApi } from '@/services/noCounterApi.js';
import NoCounterDecisionModal from './NoCounterDecisionModal.vue';
import NoCounterBasis from './NoCounterBasis.vue';

const U = window.UI;
const props = defineProps({ eventId: { type: String, required: true }, eventLabel: String, active: Boolean, confirmed: Boolean, summary: Object, showLaunch: Boolean, handedOff: Boolean, showRecords: { type: Boolean, default: true } });
const emit = defineEmits(['records', 'decision']);
const busy = ref(false);
const currentSummary = computed(() => props.summary?.event_id === props.eventId ? props.summary : null);
const noCounter = computed(() => currentSummary.value?.no_counter);
const unavailableReason = computed(() => !props.active ? '请返回当前告警后操作' : busy.value ? '正在检查处置条件，请稍候' : '');
const noCounterBlock = computed(() => unavailableReason.value || (noCounter.value?.can_decide === true ? ''
  : noCounter.value?.block_reason || '尚未确认不反制条件，请刷新后重试'));
const launchBlock = computed(() => unavailableReason.value || (currentSummary.value?.can_direct_counter === true || currentSummary.value?.can_request_counter === true ? ''
  : currentSummary.value?.counter_block_reason || '尚未确认反制资格，请刷新后重试'));
const completed = computed(() => noCounter.value?.decision_active === true);
const time = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { hour12: false });
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
  if (launchBlock.value) return;
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

async function decideNoCounter() {
  if (noCounterBlock.value) return;
  const id = props.eventId, token = readSessionToken(), request = ++generation;
  const isCurrent = () => mounted && props.active && props.eventId === id && request === generation && token === readSessionToken();
  busy.value = true;
  try {
    const status = await noCounterApi.get(id);
    if (!isCurrent()) return;
    if (status?.event_id !== id) throw new Error('未取得当前事件的处置条件，请刷新后重试。');
    emit('decision', status);
    if (status.can_decide !== true) {
      showFeedback('暂不能确认不反制', status.block_reason || '当前状态暂不能办理，请核对最新依据。');
      return;
    }
    const modal = openModal({
      title: '确认不反制', width: '580px', footer: false,
      render: () => h(NoCounterDecisionModal, {
        status, eventLabel: props.eventLabel, isCurrent: () => isCurrent() && modal.isCurrent(),
        onClose: () => modal.close(),
        onRefreshed: result => { if (isCurrent()) emit('decision', result); },
        onSaved: result => {
          if (!isCurrent()) return;
          emit('decision', result); modal.close();
          toast(result.decision_active ? '已记录不反制决定，本次处置已结束' : '已记录决定，当前风险已有变化，请核对最新状态', result.decision_active ? 'ok' : 'err');
        }
      })
    });
    feedback = modal;
  } catch (cause) {
    if (isCurrent()) showFeedback('处置条件读取失败', cause?.message || '读取当前依据失败，请稍后重试。');
  } finally { if (request === generation) busy.value = false; }
}
</script>

<template>
  <section class="counter-launch" aria-label="处置选择">
    <div v-if="completed" class="counter-decision is-completed">
      <header><h3>已决定不反制</h3><span class="tag t-cyan">本次处置已结束</span></header>
      <dl><dt>处置决定</dt><dd>{{ noCounter.decision?.reason }}</dd><dt>决定人员</dt><dd>{{ noCounter.decision?.actor_name || '未提供' }}</dd><dt>决定时间</dt><dd>{{ time(noCounter.decision?.decided_at) }}</dd></dl>
      <p>保留告警与决定记录，继续监测；出现新的风险依据时重新判断。</p>
      <details><summary>查看决定依据</summary><NoCounterBasis :basis="noCounter.decision?.basis" /></details>
    </div>
    <div v-else-if="confirmed && !handedOff" class="counter-decision is-choice">
      <div class="counter-choice-actions">
        <div class="counter-choice-action">
          <p v-if="noCounterBlock" :id="`no-counter-block-${eventId}`" class="counter-action-note">{{ noCounterBlock }}</p>
          <button class="btn no-counter-choice" type="button" :disabled="!!noCounterBlock" :aria-describedby="noCounterBlock ? `no-counter-block-${eventId}` : undefined" :aria-busy="busy" @click="decideNoCounter">无风险不反制</button>
        </div>
        <div v-if="showLaunch" class="counter-choice-action">
          <p v-if="launchBlock" :id="`counter-block-${eventId}`" class="counter-action-note">{{ launchBlock }}</p>
          <button class="btn pri" type="button" :disabled="!!launchBlock" :aria-describedby="launchBlock ? `counter-block-${eventId}` : undefined" :aria-busy="busy" @click="launch"><span class="counter-action-icon" aria-hidden="true" v-html="U.icon('shield')"></span>发起反制</button>
        </div>
      </div>
      <details v-if="noCounter?.decision"><summary>此前不反制决定</summary><p>{{ noCounter.decision.actor_name || '未提供' }} · {{ time(noCounter.decision.decided_at) }}</p><p>{{ noCounter.decision.reason }}</p><NoCounterBasis :basis="noCounter.decision.basis" /></details>
    </div>
    <div v-if="showLaunch && !confirmed && !completed" class="counter-launch-actions">
      <p v-if="launchBlock" :id="`counter-block-${eventId}`" class="counter-action-note">{{ launchBlock }}</p>
      <button class="btn pri" type="button" :disabled="!!launchBlock" :aria-describedby="launchBlock ? `counter-block-${eventId}` : undefined" :aria-busy="busy" @click="launch">
        <span class="counter-action-icon" aria-hidden="true" v-html="U.icon('shield')"></span>{{ busy ? '正在检查反制条件' : '发起反制' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.counter-launch { margin-left: auto; min-width: 0; max-width: 100%; width:100%; }
.counter-decision{padding:13px;border:1px solid var(--control-line);border-radius:var(--r);background:var(--surface-3);margin-bottom:10px}.counter-decision header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.counter-decision h3{margin:0;font-size:13px;font-weight:600}.counter-decision p{font-size:12px;line-height:1.8;color:var(--txt-2);margin:9px 0}.counter-choice-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:0}.counter-decision .no-counter-choice{border-color:var(--cyan);color:var(--cyan);background:var(--input-bg)}.counter-decision .counter-block{color:var(--txt-3)}.counter-decision .counter-review{color:var(--amber)}.counter-decision.is-completed{border-color:var(--cyan)}.counter-decision dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:7px 12px;font-size:12px;line-height:1.65;margin:13px 0}.counter-decision dt{color:var(--txt-3)}.counter-decision dd{margin:0;color:var(--txt-2);overflow-wrap:anywhere}.counter-decision summary{cursor:pointer;color:var(--txt-3);font-size:12px}.counter-decision summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
.counter-launch-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
.counter-decision.is-choice { padding: 6px 8px; margin-bottom: 0; }
.counter-choice-action { flex: 1; min-width: 130px; display: flex; flex-direction: column; justify-content: flex-end; gap: 4px; }
.counter-launch .counter-action-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--txt-3); overflow-wrap: anywhere; white-space: pre-wrap; }
.counter-launch-actions .counter-action-note { flex-basis: 100%; }
.counter-launch .btn:disabled { background: var(--surface-2); border-color: var(--line); color: var(--txt-3); }
.counter-launch .btn { white-space: normal; height: auto; min-height: 30px; padding: 4px 10px; }
.counter-action-icon { display: inline-flex; flex: none; }
.counter-action-icon :deep(.svg-icon) { width: 16px; height: 16px; }
</style>
