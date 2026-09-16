export const ADVISORY_KIND = {
  SMS_SIMULATED: '模拟短信劝离', CONTACT_RECORDED: '人工联系记录', OBSERVATION: '现场观察记录'
};
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
// 仅编排展示与主操作；是否允许写入、反制和移送仍由服务端裁决。
export function advisoryActionView(data, { confirmed, counterActive = false, counterBlock = '', handoffId = '' } = {}) {
  const records = orderedRecords(data?.records);
  const observation = lastObservation(records);
  const latest = records.at(-1);
  const contacted = records.some(r => ['SMS_SIMULATED', 'CONTACT_RECORDED'].includes(r.kind));
  const needsObservation = !!latest && latest.kind !== 'OBSERVATION';
  const departed = !needsObservation && observation?.outcome === 'DEPARTED';
  const mayCounter = !!confirmed && !!data?.can_request_counter && !counterActive && !counterBlock && !departed && !needsObservation;
  let primary = 'observe';
  if (!confirmed || !data) primary = '';
  else if (counterActive) primary = 'authorization';
  else if (departed) primary = handoffId ? 'handoff' : 'punish';
  else if (mayCounter) primary = 'counter';
  else if (!contacted && !observation) primary = data.sms_mode === 'SIMULATED' ? 'sms' : 'contact';
  return { primary, contacted, needsObservation, departed, observation, mayCounter };
}
export function advisoryProgress(data) {
  if (!data) return '正在读取处置进度';
  const latest = orderedRecords(data.records).at(-1);
  if (latest && ['SMS_SIMULATED', 'CONTACT_RECORDED'].includes(latest.kind)) return '已联系，等待观察结果';
  const observation = lastObservation(data.records);
  if (observation?.outcome === 'DEPARTED') return '现场已确认飞离';
  if (observation?.outcome === 'UNKNOWN') return '现场情况待核查';
  if (data.can_request_counter) return '持续高风险，可申请反制';
  if (observation?.outcome === 'STILL_INSIDE') return '仍在区域内，继续观察';
  if ((data.records || []).some(r => r.kind === 'SMS_SIMULATED' || r.kind === 'CONTACT_RECORDED')) return '已联系，等待观察结果';
  return '待短信劝离';
}
