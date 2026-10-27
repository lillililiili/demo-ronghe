<script setup>
import RiskDisposalSummary from './RiskDisposalSummary.vue';
import { riskSummaryMatches } from '@/services/riskCaseView.js';
import { userFacingMessage } from '@/ui/labels.js';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import AutoSmsNotice from './AutoSmsNotice.vue';
import FlightCheckNotice from './FlightCheckNotice.vue';
import AutoVoiceNotice from './AutoVoiceNotice.vue';
import AdvisoryRecords from './AdvisoryRecords.vue';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
import { autoHandoffView, handoffSubmitError, partyWarning, pendingSendStep } from './autoHandoffView.js';
import { counterProgressView } from './counterProgressView.js';
import { openFormModal } from '@/ui/formModal.js';
import { openConfirm } from '@/ui/confirm.js';
import { toast } from '@/ui/nv.js';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { disposalApi } from '@/services/disposalApi.js';
import { authUser } from '@/services/auth.js';
import { hasPermission } from '@/services/accessControl.js';
import { pendingOperationSettled } from '@/pages/punish/handoffStatus.js';

const props = defineProps({
  eventId: { type: String, required: true }, riskCase: Object, confirmed: Boolean,
  handoffId: { type: String, default: '' },
  /* 本事件最近一条反制（或历史干扰）授权记录，由告警页按处置记录读取后传入；没有就不显示反制一行。 */
  counter: { type: Object, default: null },
  /* 本事件最近一次急停记录（急停面板读到的 latest_stop）：设备回执按它写停止后的结果。 */
  counterStop: { type: Object, default: null },
  interval: { type: Number, default: 5000 }
});
const emit = defineEmits(['updated', 'unavailable']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, result => emit('updated', result), props.interval,
  (id, startedAt, caseId) => emit('unavailable', id, startedAt, caseId), () => props.riskCase?.risk_case_id || '', () => props.riskCase);
let alive = true;
onUnmounted(() => { alive = false; });
const current = computed(() => riskSummaryMatches(data.value, props.eventId, props.riskCase?.risk_case_id, props.riskCase) && !loading.value && !error.value);
const historicalObservations = computed(() => data.value?.event_id === props.eventId
  ? (data.value.records || []).filter(row => row.kind === 'OBSERVATION') : []);
// 人工反制标记不代表处罚资格；移送进度和操作只采用后端独立实测判断。
const handoff = computed(() => autoHandoffView(data.value, props.handoffId));
const observation = computed(() => data.value?.departure_observation);
const observationTime = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false });

/* ---------- 反制一行：自动/人工、开始、停止、设备回执（只读授权办理事件） ---------- */
const counterEvents = ref(null);
const counterEventsError = ref('');
let counterSeq = 0, counterTimer = null;
async function loadCounterEvents({ quiet = false } = {}) {
  const seq = ++counterSeq, id = props.counter?.authorization_id;
  if (!quiet) { counterEvents.value = null; counterEventsError.value = ''; }
  if (!id) return;
  try {
    const data = await disposalApi.events(id);
    if (!alive || seq !== counterSeq) return;
    counterEvents.value = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    counterEventsError.value = '';
  } catch (readError) {
    if (alive && seq === counterSeq) counterEventsError.value = readError?.status === 403 ? '当前账号不能查看反制办理记录。' : '反制办理记录读取失败，点“更新记录”重试。';
  }
}
watch(() => props.counter ? `${props.counter.authorization_id}:${props.counter.status}:${props.counter.version}` : '', (key, previous) => {
  const sameAuthorization = !!key && !!previous && key.split(':')[0] === previous.split(':')[0];
  void loadCounterEvents({ quiet: sameAuthorization });
  clearInterval(counterTimer); counterTimer = null;
  // 设备打开、到时关闭的回执不一定改变授权版本：执行中每 5 秒只读一次办理记录。
  if (key && ['APPROVED', 'EXECUTING'].includes(props.counter.status)) counterTimer = setInterval(() => { if (!document.hidden) void loadCounterEvents({ quiet: true }); }, 5000);
}, { immediate: true });
onUnmounted(() => clearInterval(counterTimer));
const counter = computed(() => counterProgressView(props.counter, counterEvents.value, props.counterStop));

/* ---------- 待发送移送：按后台规则自动发送，保留有权限人员的人工入口 ---------- */
const sendPermitted = computed(() => hasPermission('handoff:create') && hasPermission('handoff:read'));
const send = reactive({ id: '', status: null, loading: false, sending: false, error: '', pending: null });
let sendSeq = 0;
const sendKey = id => `punishment-notification:${authUser.value?.user_id || 'unknown'}:${id}`;
function readSendPending(id) {
  try { return JSON.parse(sessionStorage.getItem(sendKey(id)) || 'null'); } catch { return null; }
}
function saveSendPending(id, value) {
  if (value) sessionStorage.setItem(sendKey(id), JSON.stringify(value));
  else sessionStorage.removeItem(sendKey(id));
  send.pending = value;
}
async function loadSendStatus() {
  const id = handoff.value.awaitingSend && sendPermitted.value ? handoff.value.handoffId : '';
  const seq = ++sendSeq;
  if (id !== send.id) Object.assign(send, { id, status: null, error: '', pending: id ? readSendPending(id) : null });
  if (!id) return;
  send.loading = true;
  try {
    const status = await handoffApi.getHandoffNotification(id);
    if (!alive || seq !== sendSeq) return;
    send.status = status; send.error = '';
    if (pendingOperationSettled(send.pending, status)) saveSendPending(id, null);
  } catch (readError) {
    if (alive && seq === sendSeq) send.error = readError?.status === 403 ? '当前账号不能查看这份移送的发送状态。' : readError?.message || '发送状态读取失败，请点“更新记录”重试。';
  } finally { if (alive && seq === sendSeq) send.loading = false; }
}
watch(() => `${handoff.value.awaitingSend}:${handoff.value.handoffId}:${sendPermitted.value}`, () => { void loadSendStatus(); }, { immediate: true });
const sendStep = computed(() => pendingSendStep({ permitted: sendPermitted.value, status: send.status, loading: send.loading, error: send.error, waitingForRules: handoff.value.waitingForRules }));
function refresh() { load(); void loadSendStatus(); void loadCounterEvents({ quiet: true }); }
function sendHandoff() {
  if (!sendStep.value.canSend || send.sending || !current.value) return;
  const id = send.id, status = send.status;
  const recipient = status.recipient_snapshot?.org_name || status.recipient_snapshot?.recipient_name || '处罚接收单位';
  openConfirm({
    title: '发送处罚移送',
    message: `向「${recipient}」发送这份已建立的处罚交接材料。${sendStep.value.automaticAfterRules ? '通知处罚规则全部满足后也可自动发送；本次由你人工提交。' : '本次由你核对当前发送资格后人工提交。'}${status.simulated ? '本次使用模拟通道，不会发送真实通知。' : ''}送达和签收不代表处罚已办结。`,
    confirmText: '确认发送',
    onConfirm: async () => {
      if (!alive || send.id !== id || send.sending || !send.status?.can_notify) return true;
      await submitSend(id, send.status.expected_attempt_no);
      return true;
    }
  });
}
async function submitSend(id, attempt) {
  const request = send.pending && send.pending.attempt === attempt ? send.pending : { kind: 'notify', key: newHandoffIdempotencyKey(), attempt };
  try { saveSendPending(id, request); }
  catch { send.error = '浏览器无法保存本次操作，移送尚未发送。请检查浏览器存储设置后重试。'; return; }
  send.sending = true;
  try {
    await handoffApi.notifyHandoff(id, request.attempt, request.key);
    if (!alive || send.id !== id) return;
    saveSendPending(id, null);
    toast('已提交发送，请在“移送与处罚”查看送达和签收。', 'ok');
  } catch (sendError) {
    if (!alive || send.id !== id) return;
    const uncertain = !sendError?.status || sendError.status >= 500;
    if (!uncertain) saveSendPending(id, null);
    toast(uncertain ? '发送结果还没确认，请先点“更新记录”查看，不要重复发送。' : sendError?.message || '发送未能提交，请核对当前状态。', 'err');
  } finally {
    if (alive && send.id === id) send.sending = false;
    if (alive) refresh();
  }
}
function openHandoff() {
  if (handoff.value.handoffId) window.location.hash = `/punish?handoff=${encodeURIComponent(handoff.value.handoffId)}`;
}
const escText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* 启用了多个处罚接收单位时，后台不替人选（决策 18-14），由有移送权限的人在这里选定后提交。 */
async function submitHandoff() {
  const view = handoff.value;
  if (!view.canSubmit || !current.value) return;
  const id = data.value.event_id, version = data.value.event_version, caseId = props.riskCase?.risk_case_id || '';
  const sameRisk = () => current.value && id === data.value?.event_id && caseId === (props.riskCase?.risk_case_id || '');
  let recipients;
  try {
    recipients = (await handoffApi.listHandoffRecipients('UAV_PUNISHMENT'))?.items || [];
  } catch (listError) {
    toast(listError.status === 403 ? '当前账号没有查看处罚接收单位的权限' : listError.message || '读取处罚接收单位失败，请稍后重试', 'err');
    return;
  }
  if (!alive || !sameRisk()) return;
  if (!recipients.length) { toast('还没有启用的处罚接收单位，请联系管理员配置', 'err'); load(); return; }
  const key = newHandoffIdempotencyKey();
  const unidentified = view.partyUnidentified;
  const modal = openFormModal({
    title: '选择接收单位并移送到处罚', confirmText: '提交移送', width: '560px',
    warning: unidentified ? escText(partyWarning(view)) : '',
    notice: '提交后，移送材料按现在的事实保存，并发给所选单位。发出和签收结果以移送记录为准。',
    fields: [
      { key: 'recipient_id', label: '处罚接收单位', type: 'select', required: true, placeholder: '请选择接收单位',
        options: recipients.map(item => ({ label: item.display_name || item.recipient_id, value: item.recipient_id })) },
      ...(unidentified ? [{ key: 'party_confirmed', label: '当事人', type: 'checkbox', boxLabel: '我已知道当事人不明，按待补线索移送' }] : [])
    ],
    initial: { recipient_id: null, party_confirmed: false },
    submitEnabled: value => !!value.recipient_id && (!unidentified || value.party_confirmed === true),
    validate: value => !value.recipient_id ? '请选择处罚接收单位'
      : unidentified && value.party_confirmed !== true ? '请先确认已知道当事人不明' : null,
    onSubmit: async value => {
      const stillCurrent = () => alive && sameRisk() && modal.isCurrent();
      if (!stillCurrent()) throw new Error('事件已切换，请关闭后重新操作');
      try {
        await handoffApi.createHandoff({ source_kind: 'UAV_EVENT', source_id: id, handoff_type: 'UAV_PUNISHMENT',
          recipient_id: value.recipient_id, expected_version: version, ...(caseId ? { risk_case_id: caseId } : {}) }, key);
        if (!stillCurrent()) return;
        modal.close(); load(); toast('已移送到处罚，请在“移送与处罚”查看发出结果', 'ok');
      } catch (submitError) {
        if (!stillCurrent()) return;
        load();
        throw new Error(handoffSubmitError(submitError));
      }
    }
  });
}
</script>

<template>
  <section v-if="confirmed || loading || error || data || handoffId" class="uav-advisory" aria-label="飞手通知与处置进度">
    <header class="ua-head"><h3>处置进度</h3><button type="button" class="ua-link" :disabled="loading" @click="refresh()">{{ loading ? '正在读取' : error ? '重试' : '更新记录' }}</button></header>
    <p v-if="error" class="ua-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !data" class="ua-note">正在读取通知与处置进度</p>
    <template v-if="data">
      <RiskDisposalSummary :summary="data" :counter="props.counter" />
      <FlightCheckNotice :event-id="eventId" :interval="interval" />
      <AutoSmsNotice compact :data="data" :disabled="!current" @changed="load()" />
      <AutoVoiceNotice compact :data="data" :disabled="!current" @changed="load()" />
      <div v-if="counter" class="ua-handoff ua-counter" aria-label="反制进度" :data-state="props.counter?.status">
        <p><b>{{ counter.title }}</b><span>{{ counter.status }}</span></p>
        <p class="ua-note">{{ counter.initiator }}</p>
        <p v-if="counter.decisionNote" class="ua-note">{{ counter.decisionNote }}</p>
        <dl class="ua-counter-facts">
          <dt>开始</dt><dd>{{ counter.startedAt ? `${observationTime(counter.startedAt)} · ${counter.startText}` : counter.startText || '正在读取' }}</dd>
          <dt>停止</dt><dd>{{ counter.stoppedAt ? `${observationTime(counter.stoppedAt)} · ${counter.stopText}` : counter.stopText || (counter.eventsKnown ? '还没有停止记录' : '正在读取') }}</dd>
          <dt>设备回执</dt><dd>{{ counterEventsError || userFacingMessage(counter.receipt) || (counter.eventsKnown ? '还没有设备回执' : '正在读取') }}</dd>
        </dl>
      </div>
      <div v-if="observation?.started_at && observation.status !== 'RECORDED'" class="ua-handoff" aria-label="通知后的位置核对依据">
        <p>通知后位置判断：{{ ({ LEFT:'有效位置已确认离开', STILL_PRESENT:'仍在告警区域或仍有违规', UNKNOWN:'无法确认是否离开' })[observation.presence] }}</p>
        <p class="ua-note">{{ observation.channel === 'VOICE' ? '电话播放完成' : '短信送达' }} {{ observationTime(observation.started_at) }}（北京时间）</p>
        <p v-if="observation.position" class="ua-note">采用观测 {{ observationTime(observation.position.observed_at) }} · WGS84 {{ observation.position.longitude }}, {{ observation.position.latitude }}</p>
        <p v-else class="ua-note">没有当前可用或可见的位置依据，不能把停报当成飞离。</p>
        <p class="ua-note">依据：{{ ({SMS_AIRSPACE:'通知送达时所处空域与后续实测位置',LATEST_LEGALITY:'通知后的实测位置及最新合法性研判',AIRSPACE_BOUNDARY:'位置压在空域边界，无法确认',NO_CURRENT_POSITION:'没有时效内的新实测位置'})[observation.basis] || '尚未形成判断' }}；本次核对 {{ observationTime(observation.evaluated_at) }}。</p>
      </div>
      <details v-if="historicalObservations.length" class="ua-history">
        <summary>历史现场观察记录（{{ historicalObservations.length }}）</summary>
        <AdvisoryRecords :records="historicalObservations" />
      </details>
      <div v-if="handoff.handoffId || handoff.canSubmit || data.auto_handoff" class="ua-handoff" aria-label="处罚移送进度" :data-state="data.auto_handoff?.status">
        <p><span :class="`ua-${handoff.tone}`">{{ handoff.title }}</span><button v-if="handoff.handoffId" type="button" class="ua-link" @click="openHandoff">查看处罚交接</button></p>
        <p v-if="handoff.reason" class="ua-note">{{ userFacingMessage(handoff.reason) }}</p>
        <p v-if="handoff.partyUnidentified" class="ua-note">当事人不明：{{ handoff.partyReasons.join('；') || '没有可用的当事人信息' }}。移送时会写明按待补线索移送。</p>
        <button v-if="handoff.canSubmit" type="button" class="btn sm ua-submit" :disabled="!current" @click="submitHandoff">选择接收单位并移送</button>
        <template v-if="handoff.awaitingSend">
          <p class="ua-note">下一步：{{ sendStep.who }}</p>
          <p v-if="sendStep.blocked" class="ua-note" role="status">暂不能发送：{{ userFacingMessage(sendStep.blocked) }}</p>
          <p v-if="send.pending && sendPermitted" class="ua-note" role="status">上次发送的结果还没确认，再点会沿用原请求，不会重复发送。</p>
          <button v-if="sendPermitted" type="button" class="btn sm pri ua-submit" :disabled="!current || !sendStep.canSend || send.sending" @click="sendHandoff">{{ send.sending ? '正在发送' : '发送移送' }}</button>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.uav-advisory{margin:12px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-width:0}
.ua-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ua-head h3{font-size:16px;margin:0}
.ua-note{color:var(--muted);font-size:12px!important;line-height:1.6}.ua-error{font-size:13px;color:var(--red);line-height:1.6}
.ua-link{padding:0;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;white-space:normal}
.ua-handoff{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.ua-handoff p{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:13px;line-height:1.65;margin:0;overflow-wrap:anywhere}.ua-handoff .ua-note{margin-top:6px}
.ua-success{color:var(--green,#52d6a5)}.ua-warning{color:var(--amber,#ffc160)}.ua-muted{color:var(--txt)}
.ua-submit{margin-top:8px;white-space:normal;height:auto;min-height:30px}
.ua-counter-facts{display:grid;grid-template-columns:64px minmax(0,1fr);gap:4px 10px;font-size:12px;line-height:1.6;margin:6px 0 0}.ua-counter-facts dt{color:var(--muted)}.ua-counter-facts dd{margin:0;overflow-wrap:anywhere}
.ua-history{margin-top:12px}.ua-history summary{cursor:pointer;font-size:13px;line-height:1.6}.ua-history summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
.uav-advisory button:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.uav-advisory button:disabled{opacity:.5;cursor:not-allowed}
</style>
