/* 无人机事件人工核实弹窗：告警页与工作台共用同一实现，避免出现第二套表单和第二套幂等键逻辑。
   只调用 alarmApi.verifyUavEvent；结果以服务端为准，不写 window.MOCK/window.EVT。 */
import { displayAlarmNo, displayTargetNo } from '@/ui/deviceNumber.js';
import { openFormModal } from './formModal.js';
import { closeModal, openModal } from './modal.js';
import { h, shallowRef } from 'vue';
import RiskVerificationForm from '@/components/modals/RiskVerificationForm.vue';
import { createRiskVerificationSession } from '@/services/uavRiskVerificationSession.js';
import { readSessionToken } from '@/services/apiClient.js';
import { toast } from './nv.js';
import { getUavRiskCase, getUavEvent, getAlarm, verifyUavRiskCase, verifyUavEvent } from '@/services/alarmApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { ALARM_TYPE_LABEL, labelOf, readableNo } from '@/ui/labels.js';
import { predictionVerificationState } from '@/services/predictionView.js';
import { riskCaseOf, riskActionContext, riskConfirmed, riskCaseVerificationLabel } from '@/services/riskCaseView.js';
import { serverNow } from '@/services/serverClock.js';

export const UAV_STATE_TEXT = {
  PENDING_VERIFICATION: '待人工核实',
  CONFIRMED: '告警已确认',
  FALSE_POSITIVE: '误报'
};
export const uavStateText = code => UAV_STATE_TEXT[code] || (code ? String(code) : '—');

/* 同一事件的幂等键在“结果未知”期间保留；只有服务端给出明确结果后才丢弃，避免超时重试重复写历史。 */
const pendingKeys = new Map();

function newKey() {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `uav-verify-${id}`;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
/* 服务端按目标、本次告警的研判和目标数据时效现算的核实依据；缺依据时不能选“属实”，误报不受限。
   没有返回依据（旧接口或无核实权限）时按原样处理，最终仍以提交时服务端的检查为准。 */
export function verificationBasisState(event) {
  const basis = event?.verification_basis;
  if (!basis || basis.confirmable !== false) return { blocked: false, message: '' };
  return { blocked: true, message: String(basis.message || '缺少依据，不能核实为属实。确认是误报的，可以核实为误报。') };
}
function messageOf(error, fallback) {
  if (!error) return fallback;
  // 401 在受理前就被拒绝：这次没有保存，弹窗和已选内容保留，重新登录后再提交（ZT-29）。
  if (error.status === 401) return '登录已过期，这次提交没有保存。重新登录后请再提交一次。';
  if (error.status === 403) return '当前账号没有核实此事件的权限。';
  return error.message || fallback;
}

/**
 * @param {object} o
 * @param {object} o.event   服务端无人机事件（含 event_id/version/allowed_actions）
 * @param {object} [o.alarm] 关联告警（仅用于展示安全字段）
 * @param {(result:object|null)=>Promise<object|null>} [o.refresh] 成功或结果未知时回读当前事件，返回最新事件对象
 * @param {(result:object)=>void} [o.onDone] 明确成功后的回调
 */
export function openUavVerification({ event, alarm, refresh, onDone, initialValues } = {}) {
  if (!event) { toast('尚未创建核实事件，无法核实', 'err'); return false; }
  const risk = riskCaseOf(alarm);
  if (riskConfirmed(alarm)) { toast('本次风险已核实，无需重复核实', 'ok'); return false; }
  if (!(risk?.allowed_actions || event.allowed_actions || []).includes('VERIFY')) { toast('当前风险不可核实或缺少核实权限', 'err'); return false; }
  if (risk?.risk_case_id) return openLiveRiskVerification({ event, alarm, refresh, onDone, initialValues });
  const eventId = risk?.risk_case_id || event.event_id;
  const expectedVersion = Number(event.version);
  const predicted = risk ? risk.stage === 'PREDICTED' : alarm?.origin_kind === 'PREDICTED_AIRSPACE_ENTRY' || event.origin_kind === 'PREDICTED_AIRSPACE_ENTRY';
  const predictionId = predicted ? event.verification_basis?.prediction_id || event.prediction?.prediction_id || alarm?.prediction?.prediction_id : null;
  const prediction = predictionVerificationState(event, alarm, serverNow());
  if (prediction?.terminal) { toast(prediction.message, 'err'); return false; }
  const basis = prediction || verificationBasisState(event);
  if (!pendingKeys.has(eventId)) pendingKeys.set(eventId, newKey());
  const intro = [
    ['当前状态', esc(risk ? riskCaseVerificationLabel(alarm) : uavStateText(event.state))],
    alarm ? ['告警', `${displayAlarmNo(readableNo(alarm.alarm_no)) ? `<span class="mono" title="${esc(alarm.alarm_id)}">${esc(displayAlarmNo(readableNo(alarm.alarm_no)))}</span> ` : ''}${esc(labelOf(ALARM_TYPE_LABEL, alarm.alarm_type, ''))}`] : null,
    alarm ? ['关联目标', alarm.target_id ? `<span class="mono" title="${esc(alarm.target_id)}">${esc(displayTargetNo(alarm.target_no) || alarm.target_id)}</span>` : '无关联目标或无目标读取权限'] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  let modal;
  modal = openFormModal({
    title: '人工核实 · ' + esc(displayAlarmNo(readableNo(alarm?.alarm_no)) || '核实事件'),
    width: '600px',
    introHtml: `<dl class="kv">${intro}</dl>${risk ? '<p>本次核实用于这一次区域风险处置，持续风险无需重复核实；实际违法及处罚须有独立实测依据。</p>' : predicted ? '<p>本次核实的是预测入区风险。是否可通知或反制以当前证据与授权校验为准。</p>' : ''}`,
    warning: basis.blocked ? esc(basis.message) : '',
    fields: [
      { key: 'conclusion', label: '核实结论', type: 'radio', required: true, options: [
        { value: 'CONFIRMED', label: risk ? basis.blocked ? '风险属实（依据不足，暂不能选）' : '风险属实（确认本次处置风险）' : basis.blocked ? predicted ? '预测风险成立（依据不足，暂不能选）' : '属实（缺少依据，暂不能选）' : predicted ? '预测风险成立（确认本次预警）' : '属实（置为“告警已确认”）', disabled: basis.blocked },
        { value: 'FALSE_POSITIVE', label: '误报（终态）' }
      ] },
      { key: 'note', label: '核实依据与说明（选填）', type: 'textarea', placeholder: '可填写已查看的证据及判断理由；误报时可说明原识别或关联为何不成立', maxlength: 1000 }
    ],
    // 缺依据时不预选结论，由核实人明确选择误报。
    initial: { ...(basis.blocked ? {} : { conclusion: 'CONFIRMED' }), ...initialValues },
    validate: ({ conclusion, note }) => basis.blocked && conclusion === 'CONFIRMED' ? predicted ? '当前预测依据不足，不能提交预测风险属实。' : '缺少依据，不能核实为属实。'
      : String(note || '').trim().length > 1000 ? '核实说明不能超过1000字。' : '',
    confirmText: '提交核实结论',
    onRefresh: async values => {
      const current = () => !modal?.isCurrent || modal.isCurrent();
      let latestEvent, latestAlarm;
      if (risk) {
        const detail = await getUavRiskCase(eventId, { purpose: 'verification' });
        if (!current()) return;
        if (detail?.risk_case?.risk_case_id !== eventId
          || (alarm?.target_id && detail.alarm?.target_id !== alarm.target_id)
          || (risk.airspace_id && detail.risk_case.airspace_id !== risk.airspace_id)
          || (alarm?.source_mode && detail.alarm?.source_mode !== alarm.source_mode)) throw new Error('风险详情与当前记录不一致，请重新读取。');
        latestEvent = detail.event; latestAlarm = { ...detail.alarm, risk_case: detail.risk_case };
      } else {
        [latestEvent, latestAlarm] = await Promise.all([getUavEvent(eventId), alarm?.alarm_id ? getAlarm(alarm.alarm_id) : Promise.resolve(alarm)]);
        if (!current()) return;
        if (latestEvent?.event_id !== eventId) throw new Error('核实事件与当前记录不一致，请重新读取。');
      }
      const opened = openUavVerification({ event: latestEvent, alarm: latestAlarm, refresh, onDone,
        initialValues: { note: values.note || '', conclusion: undefined } });
      if (!opened && current()) modal?.close?.();
    },
    onSubmit: async ({ conclusion, note }) => {
      // 保留打开时选择的同周期快照；提交时由服务端重验最新依据，避免快照持续更新迫使重复核实。
      if (prediction?.blocked && conclusion === 'CONFIRMED') throw new Error(prediction.message);
      const key = pendingKeys.get(eventId);
      try {
        const result = await (risk ? verifyUavRiskCase : verifyUavEvent)(eventId, { ...riskActionContext(alarm), conclusion, note: String(note || '').trim(), expected_version: expectedVersion, ...(predicted && predictionId ? { prediction_id: predictionId } : {}) }, key);
        pendingKeys.delete(eventId);
        closeModal();
        toast(`核实完成：${result?.risk_case?.verification_status ? riskCaseVerificationLabel({ risk_case: result.risk_case }) : uavStateText(result?.event?.state || result?.state)}`, 'ok');
        if (refresh) await refresh(result);
        if (onDone) onDone(result);
      } catch (error) {
        if (isUncertainOutcome(error)) {
          // 409 / 超时 / 断网：服务端可能已落库。保留原键，先回读事件核对，不自动换键重试、不提示成功。
          const latest = refresh ? await refresh(null) : null;
          if (latest && (Number(latest.version) !== expectedVersion || !(latest.allowed_actions || []).includes('VERIFY'))) {
            pendingKeys.delete(eventId);
            closeModal();
            // 版本变化与终态要分开说明：前者仍可重新打开表单核实，后者不能再核实。
            const stillVerifiable = (latest.allowed_actions || []).includes('VERIFY');
            toast(stillVerifiable
              ? `提交结果未确认，已刷新当前状态：${uavStateText(latest.state)}，请核对后重新打开核实表单。`
              : `提交结果未确认，已刷新当前状态：当前事件为「${uavStateText(latest.state)}」，不能再次核实。`, 'err');
            return;
          }
          throw new Error(`提交结果未确认，请刷新核对：${messageOf(error, '未返回明确结果')}`);
        }
        // 明确失败（400/403/404 等）：请求未被受理，下次提交换新键。
        pendingKeys.delete(eventId);
        pendingKeys.set(eventId, newKey());
        throw new Error(messageOf(error, '核实提交失败'));
      }
    }
  });
  return true;
}

/** The same form stays mounted while its regional risk changes stage; only the server context is replaced. */
function openLiveRiskVerification({ event, alarm, refresh, onDone, initialValues }) {
  let modal, session;
  const snapshot = shallowRef(null), token = readSessionToken();
  const requireSession = () => {
    if (token !== readSessionToken()) throw new Error('登录账号已变化，请关闭后重新打开核实窗口。');
  };
  session = createRiskVerificationSession({ event, alarm, now: serverNow, makeKey: newKey,
    scope: token, isCurrent: () => !modal || modal.isCurrent(),
    read: async (...args) => { requireSession(); return getUavRiskCase(...args); },
    verify: async (...args) => { requireSession(); return verifyUavRiskCase(...args); },
    isUncertain: cause => isUncertainOutcome(cause) || Number(cause?.status) >= 500,
    onChange: current => { snapshot.value = current; },
    onSettled: async detail => {
      if (refresh) await refresh(detail);
    },
    onSaved: async result => {
      session.stop(); modal?.close();
      toast(`核实完成：${riskCaseVerificationLabel({ risk_case: result?.risk_case })}`, 'ok');
      if (refresh) await refresh(result);
      if (onDone) onDone(result);
    }
  });
  snapshot.value = session.view();
  const current = () => snapshot.value;
  const initialBlocked = current().blocked;
  const form = {
    title: '人工核实 · ' + esc(displayAlarmNo(readableNo(alarm?.alarm_no)) || '核实事件'),
    initial: { ...(initialBlocked ? {} : { conclusion: 'CONFIRMED' }), ...initialValues },
    get introHtml() {
      const value = current();
      return `<dl class="kv"><dt>风险阶段</dt><dd>${esc(value.stageLabel)}</dd><dt>当前状态</dt><dd>${esc(value.verificationLabel)}</dd><dt>关联目标</dt><dd>${esc(displayTargetNo(value.alarm.target_no) || value.alarm.target_id || '未提供')}</dd></dl><p>本次核实用于同一次区域风险处置；实际违法及处罚须有独立实测依据。</p>`;
    },
    get warning() {
      const value = current();
      return esc(value.readError || (value.done ? '本次风险已核实，无需重复提交。' : value.ended ? '本次风险已结束，保留原核实记录。'
        : !value.allowed ? '当前风险不可核实或缺少核实权限。' : value.basis.blocked ? value.basis.message : ''));
    },
    get notice() {
      const value = current();
      return value.awaitingResult ? '核实已保存，正在核对当前结果，请勿重复提交。' : value.uncertain ? '上次提交结果尚未确认；再次提交仅重试原请求，不会自动重复核实。'
        : [value.notice, '当前依据自动更新，已填写内容保留；提交时仍由服务端复核。'].filter(Boolean).join(' ');
    },
    get fields() {
      const value = current();
      return [
        { key: 'conclusion', label: '核实结论', type: 'radio', required: true, options: [
          { value: 'CONFIRMED', label: value.blocked ? '风险属实（当前暂不可提交）' : '风险属实（确认本次处置风险）', disabled: value.blocked },
          { value: 'FALSE_POSITIVE', label: '误报（终态）', disabled: !value.allowed || !!value.readError }
        ] },
        { key: 'note', label: '核实依据与说明（选填）', type: 'textarea', placeholder: '可填写已查看的证据及判断理由；误报时说明原识别或关联为何不成立', maxlength: 1000 }
      ];
    },
    get confirmText() { return current().done ? '本次风险已核实' : current().awaitingResult ? '核实已保存，等待读取结果' : current().uncertain ? '重试上次核实提交' : '提交核实结论'; },
    submitEnabled: values => {
      const value = current();
      return value.allowed && !value.awaitingResult && !value.readError && !value.submitting && (values.conclusion !== 'CONFIRMED' || !value.blocked);
    },
    validate: values => {
      const value = current();
      return value.readError || (!value.allowed ? '当前风险不可重复核实或缺少核实权限。'
        : values.conclusion === 'CONFIRMED' && value.blocked ? value.basis.message
        : String(values.note || '').trim().length > 1000 ? '核实说明不能超过1000字。' : '');
    },
    onRefresh: () => session.refresh(),
    onSubmit: values => session.submit(values),
    onCancel: () => { session.stop(); modal?.close(); }
  };
  modal = openModal({ title: form.title, width: '600px', footer: false,
    render: () => h(RiskVerificationForm, { form, start: session.start, stop: session.stop }) });
  return true;
}