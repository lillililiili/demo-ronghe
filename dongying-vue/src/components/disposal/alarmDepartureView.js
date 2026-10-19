import { AUTO_SMS_STATUS } from './autoSmsView.js';
import { AUTO_VOICE_STATUS } from './autoVoiceView.js';
import { notificationProgressView } from './autoHandoffView.js';
import { departureBasisText } from './uavNowStatus.js';

/** 只认本事件已留存的撤离事实；ASSESSED 和每次轮询的当前时间不能成为完成依据。 */
export function recordedDepartureKey(summary) {
  const d = summary?.departure_observation;
  if (summary?._unavailable || !summary?.event_id || d?.event_id !== summary.event_id
    || d.status !== 'RECORDED' || d.presence !== 'LEFT' || !['SMS', 'VOICE'].includes(d.channel)
    || !Number.isFinite(Number(d.evaluated_at)) || Number(d.evaluated_at) <= 0) return '';
  return JSON.stringify([summary.event_id, d.channel, Number(d.evaluated_at)]);
}

/** 展示后端已结束的撤离分支，不替代核实结论，也不覆盖审批、执行、急停或移送进度。 */
export function alarmDepartureView({ alarm, summary, progress, sources }) {
  if (alarm?.state !== 'CONFIRMED' || alarm.attention_group !== 'HISTORY'
    || summary?.event_id !== alarm.event_id || !recordedDepartureKey(summary)
    || progress || summary.notify_phase || summary.no_counter?.review_required || summary.no_counter?.decision_active
    || notificationProgressView(summary.auto_handoff)
    || (summary.auto_handoff?.handoff_id && !['FAILED', 'DISABLED', 'BLOCKED', 'WAITING'].includes(summary.auto_handoff.status))
    || !Array.isArray(sources?.auths?.items) || !Array.isArray(sources?.handoffs?.items)
    || sources.auths.failed || sources.handoffs.failed) return null;
  const d = summary.departure_observation, voice = summary.auto_voice;
  const called = (summary.records || []).some(row => row.kind === 'VOICE_SIMULATED')
    || Number(voice?.attempt_count) > 0 || Number(voice?.answered_at) > 0 || Number(voice?.playback_completed_at) > 0;
  const notCalled = voice?.attempt_count === 0 && !called
    && ['BLOCKED', 'NOT_REQUIRED', 'WAITING', 'DISABLED', 'UNAVAILABLE'].includes(voice?.status);
  return {
    title: '已撤离', evaluatedAt: Number(d.evaluated_at),
    notification: `短信：${AUTO_SMS_STATUS[summary.auto_sms?.status] || '结果待确认'}；电话：${notCalled ? '未拨打' : AUTO_VOICE_STATUS[voice?.status] || '结果待确认'}`,
    basis: departureBasisText(d), conclusion: '本轮处置已结束，无需再次确认。'
  };
}
