import { predictionVerificationState } from './predictionView.js';
import { riskActionContext, riskCaseOf, riskCaseVerificationLabel, RISK_STAGE_LABEL } from './riskCaseView.js';

// Pending writes retain their exact payload and key across modal closes; an unknown result is never retried by polling.
const pendingRiskVerifications = new Map();
const terminalVerification = risk => ['CONFIRMED', 'FALSE_POSITIVE'].includes(risk?.verification_status);
const versioned = value => value != null && String(value).trim() !== '' && Number.isInteger(Number(value));

export function createRiskVerificationSession({ event, alarm, read, verify, now = Date.now,
  isUncertain = () => false, makeKey = () => globalThis.crypto.randomUUID(), onChange = () => {},
  onSaved = () => {}, onSettled = () => {}, isCurrent = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout, interval = 1500,
  pending = pendingRiskVerifications, scope = '' } = {}) {
  const originalRisk = riskCaseOf(alarm), id = originalRisk?.risk_case_id, pendingId = `${scope}\u0000${id}`;
  let state = { event, alarm, reading: false, submitting: false, readError: '', notice: '', updatedAt: null };
  let active = true, started = false, timer = null, reading = null, notifiedTerminal = false;
  const current = () => active && isCurrent();
  const publish = patch => { if (current()) { state = { ...state, ...patch }; onChange(view()); } };
  const terminal = () => terminalVerification(riskCaseOf(state.alarm));
  function view() {
    const risk = riskCaseOf(state.alarm);
    const prediction = predictionVerificationState(state.event, state.alarm, now());
    const basis = prediction || { blocked: state.event?.verification_basis?.confirmable === false,
      message: state.event?.verification_basis?.message || '缺少当前有效依据，暂不能确认风险属实。' };
    const allowed = (risk?.allowed_actions || state.event?.allowed_actions || []).includes('VERIFY');
    const done = terminalVerification(risk), ended = ['CLEARED', 'ENDED'].includes(risk?.stage);
    return { ...state, risk, basis, allowed: allowed && !done && !ended, done, ended,
      blocked: !!state.readError || basis.blocked || !allowed || done || ended,
      stageLabel: RISK_STAGE_LABEL[risk?.stage] || '当前阶段未提供',
      verificationLabel: riskCaseVerificationLabel(state.alarm),
      uncertain: pending.get(pendingId)?.uncertain === true, awaitingResult: pending.get(pendingId)?.saved === true };
  }
  function validateDetail(detail) {
    const risk = detail?.risk_case, nextAlarm = detail?.alarm, nextEvent = detail?.event;
    if (!risk || risk.risk_case_id !== id || !nextAlarm || !nextEvent?.event_id
      || !versioned(risk.version) || !versioned(nextEvent.version)
      || (risk.action_event_id && risk.action_event_id !== nextEvent.event_id)
      || (alarm.target_id && alarm.target_id !== nextAlarm.target_id)
      || (originalRisk.airspace_id && originalRisk.airspace_id !== risk.airspace_id)
      || ['source_mode', 'owner_org_id', 'district_id'].some(key => alarm[key] && alarm[key] !== nextAlarm[key])
      || ['target_id', 'source_mode', 'owner_org_id', 'district_id'].some(key => originalRisk[key] && originalRisk[key] !== risk[key]))
      throw new Error('风险详情与当前记录不一致，已暂停核实，请重新打开所选风险。');
    return { event: nextEvent, alarm: { ...nextAlarm, risk_case: risk } };
  }
  async function refresh() {
    if (!current()) return null;
    if (reading) return reading;
    publish({ reading: true });
    reading = (async () => {
      try {
        const detail = await read(id, { purpose: 'verification' });
        if (!current()) return null;
        const context = validateDetail(detail), previousStage = riskCaseOf(state.alarm)?.stage;
        const notice = previousStage !== context.alarm.risk_case.stage
          ? `阶段已更新为“${RISK_STAGE_LABEL[context.alarm.risk_case.stage] || '当前阶段'}”，仍办理同一次风险。`
          : state.notice;
        publish({ ...context, readError: '', notice, updatedAt: now() });
        if (terminal() && !notifiedTerminal) {
          notifiedTerminal = true; pending.delete(pendingId);
          await onSettled(detail);
        }
        return detail;
      } catch (error) {
        if (current()) publish({ readError: error?.message || '当前依据读取失败，正在重试。' });
        throw error;
      } finally { reading = null; publish({ reading: false }); }
    })();
    return reading;
  }
  function schedule() {
    if (!current() || !started || terminal()) return;
    timer = setTimer(async () => {
      timer = null;
      if (!current()) return;
      if (!state.submitting) { try { await refresh(); } catch { /* Kept inline; no repeating toast. */ } }
      schedule();
    }, interval);
  }
  function start() {
    if (started || !current()) return;
    started = true;
    void refresh().catch(() => {}).finally(schedule);
  }
  function stop() {
    active = false; started = false;
    if (timer != null) clearTimer(timer);
    timer = null;
  }
  async function submit({ conclusion, note = '' }) {
    if (!current() || state.submitting) return;
    if (!['CONFIRMED', 'FALSE_POSITIVE'].includes(conclusion)) throw new Error('请选择核实结论。');
    if (String(note).trim().length > 1000) throw new Error('核实说明不能超过1000字。');
    const beforeStage = riskCaseOf(state.alarm)?.stage;
    publish({ submitting: true });
    let request, attempted = false, previouslyUncertain = false;
    try {
      // Wait for an existing poll, then re-read immediately before a new submission.
      if (reading) await reading;
      if (!current()) return;
      await refresh();
      if (!current()) return;
      const latest = view();
      if (latest.done) return;
      if (!latest.allowed) throw new Error(latest.ended ? '本次风险已结束，保留核实和处置历史。' : '当前风险不可核实或缺少核实权限。');
      if (conclusion === 'CONFIRMED' && latest.blocked) throw new Error(latest.readError || latest.basis.message);
      request = pending.get(pendingId);
      if (request?.saved) throw new Error('核实已保存，正在读取本次结果；请重新读取当前依据，不要重复提交。');
      if (!request?.uncertain) {
        if (beforeStage !== latest.risk.stage) throw new Error(`风险阶段已更新为“${latest.stageLabel}”，输入已保留，请核对后再次提交。`);
        const predictionId = latest.risk.stage === 'PREDICTED'
          ? latest.event.verification_basis?.prediction_id || latest.event.prediction?.prediction_id || latest.alarm.prediction?.prediction_id : null;
        request = { key: makeKey(), uncertain: false, body: { ...riskActionContext(latest.alarm), conclusion,
          note: String(note).trim(), expected_version: Number(latest.event.version), ...(predictionId ? { prediction_id: predictionId } : {}) } };
        pending.set(pendingId, request);
      } else if (request.body.conclusion !== conclusion || request.body.note !== String(note).trim()) {
        throw new Error('上次提交结果尚未确认；重试必须保留原核实结论和说明，请先核对当前记录。');
      }
      previouslyUncertain = request.uncertain === true;
      attempted = true;
      const result = await verify(id, request.body, request.key);
      pending.delete(pendingId);
      request = null;
      if (current()) await onSaved(result);
      return result;
    } catch (error) {
      if (request && attempted) {
        // Even an error response may follow a committed write; first reconcile the regional ledger.
        if (!previouslyUncertain && (error?.code === 'RISK_CASE_CHANGED' || !isUncertain(error))) pending.delete(pendingId);
        else { request.uncertain = true; request.saved = request.saved || error?.code === 'VERIFICATION_RESPONSE_UNAVAILABLE'; }
        if (current()) {
          try { await refresh(); } catch { /* Preserve the original write outcome. */ }
          if (terminal()) return;
        }
        if (request.saved) throw new Error('核实已保存，当前详情暂时无法读取；正在核对同一风险结果，请勿重复提交。');
        if (request.uncertain) throw new Error(`提交结果未确认，已保留原请求。请核对当前状态；再次点击仅重试这一次提交。${error?.message || ''}`);
      }
      throw error;
    } finally { publish({ submitting: false }); }
  }
  return { view, refresh, start, stop, submit };
}