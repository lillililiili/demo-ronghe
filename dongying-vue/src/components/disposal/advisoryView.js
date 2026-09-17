import { autoSmsView } from './autoSmsView.js';
import { autoVoiceView } from './autoVoiceView.js';

export const ADVISORY_KIND = {
  SMS_SIMULATED: '模拟短信劝离', VOICE_SIMULATED: '模拟电话录音通知', CONTACT_RECORDED: '人工联系记录', OBSERVATION: '现场观察记录'
};
export function isAdvisoryContact(record) {
  return ['SMS_SIMULATED', 'CONTACT_RECORDED'].includes(record.kind)
    || (record.kind === 'VOICE_SIMULATED' && record.delivery_status === 'SIMULATED_PLAYED');
}
export const OBSERVATION_OUTCOME = {
  DEPARTED: '已确认飞离', STILL_INSIDE: '仍在违规区域', UNKNOWN: '无法确认 / 目标失联'
};
export const OBSERVATION_DANGER = { HIGH: '高', MEDIUM: '中', LOW: '低', UNKNOWN: '待核查' };
export function orderedRecords(records = []) {
  return [...records].sort((a, b) => Number(a.created_at) - Number(b.created_at));
}
export function lastObservation(records = []) {
  return orderedRecords(records).filter(r => r.kind === 'OBSERVATION').at(-1) || null;
}
// 只带入已经保存的现场记录作为申请草稿，不生成不存在的紧急事由或授权。
export function advisoryRequestReason(data) {
  const observation = lastObservation(data?.records);
  if (!observation) return '';
  const at = observation.created_at == null ? null : new Date(observation.created_at);
  const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleString('zh-CN', { hour12: false }) : '时间未提供';
  return [
    `现场记录（${time}）：${OBSERVATION_OUTCOME[observation.outcome] || '结果未知'}，危险度${OBSERVATION_DANGER[observation.danger] || '待核查'}。`,
    observation.note ? `已记录依据：${observation.note}` : '',
    observation.simulated ? '来源：模拟现场记录。' : ''
  ].filter(Boolean).join('\n');
}
// 仅编排展示与主操作；是否允许写入、反制和移送仍由服务端裁决。
export function advisoryActionView(data, { confirmed, counterActive = false, counterBlock = '', handoffId = '' } = {}) {
  const records = orderedRecords(data?.records);
  const observation = lastObservation(records);
  const latest = records.filter(r => r.kind === 'OBSERVATION' || isAdvisoryContact(r)).at(-1);
  const contacted = records.some(isAdvisoryContact);
  const needsObservation = !!latest && latest.kind !== 'OBSERVATION';
  const departed = !needsObservation && observation?.outcome === 'DEPARTED';
  const mayCounter = !!confirmed && !!data?.can_request_counter && !counterActive && !counterBlock && !departed && !needsObservation;
  let primary = 'observe';
  if (!confirmed || !data) primary = '';
  else if (counterActive) primary = 'authorization';
  else if (departed) primary = handoffId ? 'handoff' : 'punish';
  else if (mayCounter) primary = 'counter';
  else if (!contacted && !observation) primary = ['WAITING', 'SENDING'].includes(data.auto_sms?.status)
    || ['WAITING', 'CALLING'].includes(data.auto_voice?.status) || autoSmsView(data).canRetry || autoVoiceView(data).canRetry ? '' : 'contact';
  return { primary, contacted, needsObservation, departed, observation, mayCounter };
}
export function advisoryProgress(data) {
  if (!data) return '正在读取处置进度';
  const latest = orderedRecords(data.records).filter(r => r.kind === 'OBSERVATION' || isAdvisoryContact(r)).at(-1);
  if (latest && isAdvisoryContact(latest)) return '已联系，等待观察结果';
  const observation = lastObservation(data.records);
  if (observation?.outcome === 'DEPARTED') return '现场已确认飞离';
  if (observation?.outcome === 'UNKNOWN') return '现场情况待核查';
  if (data.can_request_counter) return '持续高风险，可申请反制';
  if (observation?.outcome === 'STILL_INSIDE') return '仍在区域内，继续观察';
  if ((data.records || []).some(isAdvisoryContact)) return '已联系，等待观察结果';
  if (['WAITING', 'CALLING', 'UNKNOWN', 'FAILED'].includes(data.auto_voice?.status)) return autoVoiceView(data).title;
  return autoSmsView(data).title;
}
