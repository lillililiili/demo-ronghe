export const AUTO_SMS_STATUS = {
  WAITING: '等待自动通知', SENDING: '系统正在发送', SIMULATED_DELIVERED: '模拟已送达',
  UNKNOWN: '发送结果未知', FAILED: '发送失败，需人工处理', UNAVAILABLE: '短信通道未接通',
  BLOCKED: '暂不满足自动发送条件', DISABLED: '自动通知未启用', NOT_REQUIRED: '不需要发送短信'
};
/* 后端时效提示的开头，与 AutoSmsService.STALE_REASON 一致；旧记录只有前半句。 */
export const STALE_PREFIX = '事件已超过自动通知时效';
export const RECHECK_SOURCE = 'MANUAL_RECHECK';
export function smsExpired(sms) {
  return !!sms && !['SIMULATED_DELIVERED', 'SENDING', 'UNKNOWN', 'NOT_REQUIRED'].includes(sms.status)
    && String(sms.reason || '').startsWith(STALE_PREFIX);
}
function reasonText(reason) {
  // 只剥离已知的时效参数尾注（后台旧文案"本地演示策略"、新文案"自动通知时效"），未知失败原因完整保留。
  const text = String(reason || '').replace(/；(?:本地演示策略|自动通知时效)：目标和研判有效期\d+秒，事件及人工确认有效期\d+秒$/, '')
    // 标题已写“需核对最新情况”，原因只留后半句。
    .replace(/^事件已超过自动通知时效，需核对最新情况：/, '');
  const labels = {
    '事件已超过自动通知时效': '原告警已超过自动发送时效；本次核实不会更新原告警和目标观测时间。',
    '缺少近期目标观测，不能确认目标仍在场': '缺少近期观测，目标位置待确认',
    '最新规则结果不是时效内明确违规，不能自动通知': '缺少有效的违规研判依据',
    '目标类型尚未确认为无人机，不能仅凭身份识别猜测违规': '目标类型尚未确认为无人机',
    '最新违规研判未关联本事件，不能代替本事件依据': '最新违规研判未关联本事件',
    '正式短信渠道尚未接入，真实来源不能冒充模拟送达': '正式短信通道未接通',
    '正式短信渠道尚未接入，不能把模拟送达写成真实通知': '正式短信通道未接通',
    '已有劝离或人工联系记录，后台不重复自动通知': '已有联系记录，不重复发送',
    '触发条件满足，等待后台自动模拟发送': '',
    '告警已建立，等待后台自动模拟发送': '后台将自动发送模拟短信',
    '后台正在调用模拟短信接口': '',
    '后台自动短信尚未启用': '',
    '后台已自动模拟发送短信；模拟送达不代表飞手阅读或目标已飞离': '',
    '模拟短信接口未返回有效送达结果，可在条件仍满足时补发': '未收到有效送达结果',
    '等待后台检查触发条件': '',
    '已登记补发，等待后台发送': '已登记补发',
    '已核对最新情况并登记发送，等待后台发送': '已核对最新情况并登记发送，等待后台发送',
    '没有可通知的执行飞手，不能发送短信': '没有可通知的执行飞手，不能发送短信'
  };
  return Object.prototype.hasOwnProperty.call(labels, text) ? labels[text] : text;
}
/* BLOCK-03（2026-10-06 用户确认）：飞手信息只来自上级计划接口，本系统没有补录页面。后端 pilot_contact_missing
   为 true（关联任务没有执行飞手，或飞手没有电话）且这条通知还没发出时，直接写明“缺飞手联系方式”；
   正在发送、已送达、失败或结果未知的以发送记录为准，不改写。电话通知同一口径。 */
export const PILOT_CONTACT_MISSING_TITLE = '缺飞手联系方式';
export const PILOT_CONTACT_MISSING_GUIDANCE = '飞手信息以上级下发的任务为准，本系统不能补录；需要时请通过任务报备单位等其他途径联系飞手。';
export function pilotContactMissing(data, status) {
  return data?.pilot_contact_missing === true && ['WAITING', 'BLOCKED', 'UNAVAILABLE', 'DISABLED'].includes(status);
}
/* 没有报备飞手（2026-10-18 rose 确认，流程 3、4）：对不上报备任务、任务里没有执行飞手，或飞手与任务单位对不上。
   这是事实本身，不随核实、告警时长变化；从告警一出来就写“没有报备飞手，不发短信、不打电话”，之后也不变。
   原因文字与后台 NotificationDirectoryService / AutoSmsService 的说法一致；旧记录里“超过时效；同时……”的后半句同样认。 */
export const NO_REPORTED_PILOT_REASONS = [
  '当前事件尚无精确关联任务，不能把单位联系人当作执行飞手',
  '没有可通知的执行飞手，不能发送短信',
  '没有可通知的执行飞手，不能拨打电话',
  '未找到该任务的执行飞手联系人',
  '飞手身份与任务运营单位未形成有效关联'
];
export const NO_REPORTED_PILOT_TEXT = '没有报备飞手，不发短信、不打电话。';
function baseReason(reason) {
  const text = String(reason || '').trim();
  const tail = text.match(/；同时(.+)$/);
  return (tail ? tail[1] : text).trim().replace(/[。.]$/, '');
}
/** 通知还没发出、原因是没有报备飞手。已发送、送达、失败或结果未知的以发送记录为准，不改写。 */
export function noReportedPilot(data) {
  const sms = data?.auto_sms;
  if (!sms || !['WAITING', 'BLOCKED', 'UNAVAILABLE', 'DISABLED'].includes(sms.status) || Number(sms.attempt_count) > 0) return false;
  if (pilotContactMissing(data, sms.status)) return false;
  return NO_REPORTED_PILOT_REASONS.includes(baseReason(sms.reason));
}
export function autoSmsView(data) {
  const sms = data?.auto_sms;
  if (!sms) return { title: '自动通知状态暂不可用', reason: '', tone: 'muted', canRetry: false };
  const latest = [...(data.records || [])].reverse().find(row => row.kind === 'SMS_SIMULATED');
  const recipientSnapshot = latest ? latest.recipient_snapshot : sms.recipient_snapshot;
  // 告警超过通知时效才走到发送：不再自动发短信和打电话，先请人核对最新情况（2026-10-06）。
  const missing = pilotContactMissing(data, sms.status);
  const noPilot = !missing && noReportedPilot(data);
  // 没有飞手是根本原因：不再显示“需核对最新情况”“等待发送”这类会随时间变化的说法。
  const expired = !noPilot && smsExpired(sms);
  const canRetry = !!sms.can_retry && !['SENDING', 'WAITING', 'UNKNOWN', 'SIMULATED_DELIVERED', 'NOT_REQUIRED'].includes(sms.status);
  return {
    title: missing ? PILOT_CONTACT_MISSING_TITLE : noPilot ? '没有报备飞手，不发短信' : expired ? '需核对最新情况' : AUTO_SMS_STATUS[sms.status] || '通知结果待确认',
    reason: missing ? '上级下发的飞行任务里没有执行飞手的电话，无法给飞手发短信。' : noPilot ? NO_REPORTED_PILOT_TEXT : reasonText(sms.reason),
    pilotContactMissing: missing,
    noReportedPilot: noPilot,
    tone: missing || noPilot ? 'warning' : sms.status === 'SIMULATED_DELIVERED' ? 'success' : expired || ['FAILED', 'UNKNOWN', 'UNAVAILABLE', 'BLOCKED'].includes(sms.status) ? 'warning' : 'muted',
    canRetry: canRetry && !noPilot, expired, recheck: expired && canRetry,
    updatedAt: sms.updated_at, triggeredAt: sms.triggered_at, evaluatedAt: sms.evaluated_at, dataUpdatedAt: sms.data_updated_at,
    recipient: latest ? latest.recipient_name || recipientSnapshot?.recipient_name : recipientSnapshot ? recipientSnapshot.recipient_name : Number(sms.attempt_count) > 0 ? undefined : data.recipient?.name,
    recipientHint: recipientSnapshot?.contact_hint,
    simulated: data.sms_mode === 'SIMULATED' || sms.status === 'SIMULATED_DELIVERED',
    source: sms.trigger_source, policy: sms.policy_code,
    guidance: missing ? PILOT_CONTACT_MISSING_GUIDANCE : noPilot ? '这架无人机对不上报备飞手，系统找不到可以通知的人；需要时请按现场情况处置。' : !expired ? ''
      : canRetry ? '请先核对目标现在的位置和违规情况。确认仍需提醒飞手时，点“核对后发送飞手短信”；目标已离开或情况已变化，可以不再发送。'
        : sms.status === 'BLOCKED' && !String(sms.reason || '').includes('；同时')
          ? '请先核对目标现在的位置和违规情况。需要有权限的人员核对后才能登记发送。'
          : '请先核对目标现在的位置和违规情况。'
  };
}
