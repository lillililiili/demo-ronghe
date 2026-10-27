<script setup>
import { h, ref, computed, watch, onUnmounted, nextTick } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { disposalApi } from '@/services/disposalApi.js';
import { readSessionToken } from '@/services/apiClient.js';
import { getUavEvent, getUavRiskCase } from '@/services/alarmApi.js';
import { targetApi } from '@/services/targetApi.js';
import { coordOf } from '@/services/positionMap.js';
import { openDisposalRequest, openDisposalDirect, loadEnabledDevices } from '@/ui/disposalAuthModal.js';
import { openModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { noCounterApi } from '@/services/noCounterApi.js';
import NoCounterDecisionModal from './NoCounterDecisionModal.vue';
import NoCounterBasis from './NoCounterBasis.vue';
import { counterLaunchLabel, counterPermissionHint, noCounterEntryVisible } from '@/components/disposal/counterNextStep.js';
import { riskActionContext, riskSummaryMatches } from '@/services/riskCaseView.js';
import { hasPermission } from '@/services/accessControl.js';

const U = window.UI;
const props = defineProps({ eventId: { type: String, required: true }, eventLabel: String, targetId: String, active: Boolean, confirmed: Boolean, summary: Object, riskCase: Object, showLaunch: Boolean, handedOff: Boolean, counterStopped: Boolean, showRecords: { type: Boolean, default: true } });
const emit = defineEmits(['records', 'decision', 'updated', 'unavailable']);
const busy = ref(false);
const currentSummary = computed(() => riskSummaryMatches(props.summary, props.eventId, props.riskCase?.risk_case_id, props.riskCase) ? props.summary : null);
const noCounter = computed(() => currentSummary.value?.no_counter);
const unavailableReason = computed(() => !props.active ? '请返回当前告警后操作' : busy.value ? '正在检查处置条件，请稍候' : '');
const noCounterBlock = computed(() => unavailableReason.value || (noCounter.value?.can_decide === true ? ''
  : noCounter.value?.block_reason || '尚未确认不反制条件，请刷新后重试'));
const launchBlock = computed(() => unavailableReason.value || (currentSummary.value?.can_direct_counter === true || currentSummary.value?.can_request_counter === true ? ''
  : currentSummary.value?.counter_block_reason || '尚未确认反制资格，请刷新后重试'));
const launchLabel = computed(() => counterLaunchLabel(currentSummary.value));
const launchHint = computed(() => launchBlock.value ? '' : counterPermissionHint(currentSummary.value));
const completed = computed(() => noCounter.value?.decision_active === true);
/* 没有告警核实权限的账号（只读领导、执行员等）不显示“无风险不反制”入口；只是隐藏，后端照常校验。 */
const noCounterVisible = computed(() => !props.riskCase?.risk_case_id && !props.counterStopped && noCounterEntryVisible(hasPermission));
const time = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
let generation = 0, mounted = true, feedback = null, preparationCancelled = false;
function cancelPreparation() {
  if (busy.value && !preparationCancelled) { preparationCancelled = true; toast('风险状态或当前页面已变化，本次未发起反制，请重新核对当前风险。', 'warn'); }
}
// 绑定只随事件、页面或停止状态变化失效；同事件的资格刷新不算切换。
// showLaunch 仍由提交时的 isCurrent 实时校验，读取失败或风险失效时不能提交。
watch(() => [props.riskCase?.risk_case_id || props.eventId, props.active, props.counterStopped], (current, previous) => {
  if (previous && current.every((value, index) => value === previous[index])) return;
  cancelPreparation(); ++generation; busy.value = false; feedback?.close();
}, { flush: 'sync' });
onUnmounted(() => { cancelPreparation(); mounted = false; ++generation; feedback?.close(); });

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

/** 目标现在的位置，用来只列出覆盖范围照得到目标的反制设备；读不到时返回 null，弹窗里如实说明。 */
async function currentTargetPoint(eventId, knownTargetId) {
  try {
    const event = knownTargetId ? null : await getUavEvent(eventId);
    const targetId = knownTargetId || event?.target_id || event?.targetId;
    if (!targetId) return null;
    const latest = (await targetApi.detailTimed(targetId))?.latest_state;
    return latest ? coordOf(latest.location, latest.field_issues, 'location') : null;
  } catch { return null; }
}

async function launch() {
  if (launchBlock.value || !props.showLaunch) return;
  const initialId = props.eventId, initialRisk = props.riskCase, caseId = initialRisk?.risk_case_id;
  const token = readSessionToken(), request = ++generation, startedAt = Date.now();
  // 风险身份不随预测转实测变化；办理事件在读取及明确提交时重新解析。
  const isCurrent = () => mounted && props.active && request === generation && token === readSessionToken()
    && (caseId ? props.riskCase?.risk_case_id === caseId : props.showLaunch && !props.riskCase?.risk_case_id && props.eventId === initialId);
  let currentId = initialId;
  busy.value = true; preparationCancelled = false;
  async function readQualification(requiredDirect) {
    if (!isCurrent()) throw new Error('当前风险已切换，本次未发起反制。');
    let id = props.eventId, eligibility;
    if (caseId) {
      const detail = await getUavRiskCase(caseId);
      if (!isCurrent()) throw new Error('当前风险已切换，本次未发起反制。');
      const risk = detail?.risk_case;
      if (risk?.risk_case_id !== caseId || !risk.action_event_id
          || (initialRisk.airspace_id && risk.airspace_id !== initialRisk.airspace_id)
          || (initialRisk.source_mode && risk.source_mode !== initialRisk.source_mode)
          || (props.targetId && detail.alarm?.target_id !== props.targetId)
          || Number(risk.version) < Number(props.riskCase?.version)) throw new Error('风险身份或版本不一致，请重新读取当前风险。');
      id = risk.action_event_id;
      eligibility = detail.advisory || await uavAdvisoryApi.get(id, caseId);
      if (!riskSummaryMatches(eligibility, id, caseId, risk)) throw new Error('当前风险及反制资格不一致，请稍后重试。');
    } else eligibility = await uavAdvisoryApi.get(id);
    if (!isCurrent()) throw new Error('当前风险已切换，本次未发起反制。');
    if (!riskSummaryMatches(eligibility, id, caseId)) throw new Error('未取得当前风险的反制资格，请稍后重试。');
    emit('updated', { ...eligibility, _riskCaseId: caseId, _fetchedAt: Date.now() });
    await nextTick();
    if (!isCurrent()) throw new Error('当前风险已切换，本次未发起反制。');
    if (caseId && !riskSummaryMatches(eligibility, id, caseId, props.riskCase)) throw new Error('当前风险已更新，正在同步处置资格，请稍后重试。');
    if (eligibility.counter_launch_visible !== true || (requiredDirect === true ? eligibility.can_direct_counter !== true
      : requiredDirect === false ? eligibility.can_request_counter !== true
        : eligibility.can_direct_counter !== true && eligibility.can_request_counter !== true)) {
      throw new Error(eligibility.counter_block_reason || '当前反制资格未确认，暂不能发起。');
    }
    currentId = id;
    const riskContext = riskActionContext({ risk_case: eligibility.risk_case || (eligibility.risk_case_id
      ? { risk_case_id: eligibility.risk_case_id, version: eligibility.risk_case_version } : null) });
    if (caseId && !riskContext.risk_case_id) throw new Error('风险版本未提供，请重新读取当前风险。');
    return { subjectId: id, riskContext, eligibility };
  }
  try {
    const [binding, policy, targetPoint, preparedDevices] = await Promise.all([
      readQualification(), disposalApi.policies(), currentTargetPoint(initialId, props.targetId),
      loadEnabledDevices().then(items => ({ items }), error => ({ error }))
    ]);
    if (!isCurrent()) { cancelPreparation(); return; }
    const direct = binding.eligibility.can_direct_counter === true;
    const open = direct ? openDisposalDirect : openDisposalRequest;
    await open({
      actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: binding.subjectId,
      subjectText: props.eventLabel || binding.subjectId, policy, isCurrent, targetPoint, preparedDevices,
      riskContext: binding.riskContext,
      // 只在操作员点击确认后重验，保留已选择设备与事由，不自动发起或复活授权。
      prepareSubmit: caseId ? () => readQualification(direct) : undefined,
      onDone: result => {
        if (isCurrent()) emit('records', { eventId: result?.subject_id || currentId, riskCaseId: caseId || '', authorizationId: result?.authorization_id || '' });
      }
    });
    if (!isCurrent()) cancelPreparation();
  } catch (cause) {
    if (isCurrent()) {
      emit('unavailable', props.eventId, startedAt, caseId);
      showFeedback('反制条件检查失败', cause?.message || '读取反制资格失败，请稍后重试。');
    } else cancelPreparation();
  } finally {
    if (request === generation) busy.value = false;
  }
}

async function decideNoCounter() {
  if (!noCounterVisible.value || noCounterBlock.value) return;
  const id = props.eventId, caseId = props.riskCase?.risk_case_id, token = readSessionToken(), request = ++generation;
  const isCurrent = () => mounted && props.active && props.eventId === id && props.riskCase?.risk_case_id === caseId && request === generation && token === readSessionToken();
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
          toast(result.decision_active ? '已记录不反制决定，现场处置结束' : '已记录决定，当前风险已有变化，请核对最新状态', result.decision_active ? 'ok' : 'err');
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
  <section class="counter-launch" :class="{ 'is-completed': completed }" aria-label="处置选择">
    <div v-if="completed" class="counter-decision is-completed">
      <header><h3>已决定不反制</h3><span class="tag t-cyan">现场处置结束</span></header>
      <p>继续监测，出现新的风险依据时重新判断。</p>
      <details><summary>查看决定依据</summary><NoCounterBasis :basis="noCounter.decision?.basis" /></details>
    </div>
    <div v-else-if="confirmed && !handedOff && (noCounterVisible || showLaunch || noCounter?.decision)" class="counter-decision is-choice">
      <div v-if="noCounterVisible || showLaunch" class="counter-choice-actions">
        <div v-if="noCounterVisible" class="counter-choice-action">
          <button class="btn no-counter-choice" type="button" :disabled="!!noCounterBlock" :aria-describedby="noCounterBlock ? `no-counter-block-${eventId}` : undefined" :aria-busy="busy" @click="decideNoCounter">无风险不反制</button>
          <p v-if="noCounterBlock" :id="`no-counter-block-${eventId}`" class="counter-action-note">{{ noCounterBlock }}</p>
        </div>
        <div v-if="showLaunch" class="counter-choice-action">
          <button class="btn pri" type="button" :disabled="!!launchBlock" :aria-describedby="launchBlock ? `counter-block-${eventId}` : undefined" :aria-busy="busy" @click="launch"><span class="counter-action-icon" aria-hidden="true" v-html="U.icon('shield')"></span>{{ busy ? '正在检查反制条件' : launchLabel }}</button>
          <p v-if="launchBlock" :id="`counter-block-${eventId}`" class="counter-action-note">{{ launchBlock }}</p>
          <p v-if="launchHint" class="counter-action-note">{{ launchHint }}</p>
        </div>
      </div>
      <details v-if="noCounter?.decision"><summary>此前不反制决定</summary><p>{{ noCounter.decision.actor_name || '未提供' }} · {{ time(noCounter.decision.decided_at) }}</p><p>{{ noCounter.decision.reason }}</p><NoCounterBasis :basis="noCounter.decision.basis" /></details>
    </div>
    <div v-if="showLaunch && !confirmed && !completed" class="counter-launch-actions">
      <button class="btn pri" type="button" :disabled="!!launchBlock" :aria-describedby="launchBlock ? `counter-block-${eventId}` : undefined" :aria-busy="busy" @click="launch">
        <span class="counter-action-icon" aria-hidden="true" v-html="U.icon('shield')"></span>{{ busy ? '正在检查反制条件' : launchLabel }}
      </button>
      <p v-if="launchBlock" :id="`counter-block-${eventId}`" class="counter-action-note">{{ launchBlock }}</p>
      <p v-if="launchHint" class="counter-action-note">{{ launchHint }}</p>
    </div>
  </section>
</template>

<style scoped>
.counter-launch { margin-left: auto; min-width: 0; max-width: 100%; width:100%; }
.counter-launch.is-completed .counter-decision { padding: 8px 10px; margin-bottom: 0; }
.counter-launch.is-completed p { margin: 5px 0; line-height: 1.6; }
.counter-decision{padding:13px;border:1px solid var(--control-line);border-radius:var(--r);background:var(--surface-3);margin-bottom:10px}.counter-decision header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.counter-decision h3{margin:0;font-size:13px;font-weight:600}.counter-decision p{font-size:12px;line-height:1.8;color:var(--txt-2);margin:9px 0}.counter-choice-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:0}.counter-decision .no-counter-choice{border-color:var(--cyan);color:var(--cyan);background:var(--input-bg)}.counter-decision .counter-block{color:var(--txt-3)}.counter-decision .counter-review{color:var(--amber)}.counter-decision.is-completed{border-color:var(--cyan)}.counter-decision dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:7px 12px;font-size:12px;line-height:1.65;margin:13px 0}.counter-decision dt{color:var(--txt-3)}.counter-decision dd{margin:0;color:var(--txt-2);overflow-wrap:anywhere}.counter-decision summary{cursor:pointer;color:var(--txt-3);font-size:12px}.counter-decision summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
.counter-launch-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
.counter-decision.is-choice { padding: 6px 8px; margin-bottom: 0; }
.counter-choice-action { flex: 1 1 180px; min-width: 0; display: flex; flex-direction: column; justify-content: flex-start; gap: 6px; }
.counter-launch .counter-action-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--txt-3); overflow-wrap: anywhere; white-space: pre-wrap; }
.counter-launch-actions .counter-action-note { flex-basis: 100%; }
.counter-launch .btn:disabled { background: var(--surface-2); border-color: var(--line); color: var(--txt-3); }
.counter-launch .btn { white-space: normal; height: auto; min-height: 40px; padding: 8px 12px; line-height: 1.5; }
.counter-action-icon { display: inline-flex; flex: none; }
.counter-action-icon :deep(.svg-icon) { width: 16px; height: 16px; }
</style>
