export const AUTO_SMS_STATUS = {
  WAITING: '等待自动通知', SENDING: '系统正在发送', SIMULATED_DELIVERED: '已送达',
  UNKNOWN: '发送结果未知', FAILED: '发送失败，需人工处理', UNAVAILABLE: '短信通道未接通',
  BLOCKED: '暂不满足自动发送条件', DISABLED: '自动通知未启用'
};
function reasonText(reason) {
  // 只剥离已知的演示参数尾注，未知失败原因完整保留。
  const text = String(reason || '').replace(/；本地演示策略：目标和研判有效期\d+秒，事件及人工确认有效期\d+秒$/, '');
  const labels = {
    '事件已超过自动通知时效': '原告警已超过自动发送时效；本次核实不会更新原告警和目标观测时间。',
    '缺少近期目标观测，不能确认目标仍在场': '缺少近期观测，目标位置待确认',
    '最新规则结果不是时效内明确违规，不能自动通知': '缺少有效的违规研判依据',
    '目标类型尚未确认为无人机，不能仅凭身份识别猜测违规': '目标类型尚未确认为无人机',
    '最新违规研判未关联本事件，不能代替本事件依据': '最新违规研判未关联本事件',
    '正式短信渠道尚未接入，真实来源不能冒充模拟送达': '正式短信通道未接通',
    '已有劝离或人工联系记录，后台不重复自动通知': '已有联系记录，不重复发送',
    '触发条件满足，等待后台自动模拟发送': '',
    '后台正在调用模拟短信接口': '',
    '后台自动短信尚未启用': '',
    '后台已自动模拟发送短信；模拟送达不代表飞手阅读或目标已飞离': '',
    '模拟短信接口未返回有效送达结果，可在条件仍满足时补发': '未收到有效送达结果',
    '等待后台检查触发条件': '',
    '已登记补发，等待后台发送': '已登记补发'
  };
  return Object.prototype.hasOwnProperty.call(labels, text) ? labels[text] : text;
}
export function autoSmsView(data) {
  const sms = data?.auto_sms;
  if (!sms) return { title: '自动通知状态暂不可用', reason: '', tone: 'muted', canRetry: false };
  const latest = [...(data.records || [])].reverse().find(row => row.kind === 'SMS_SIMULATED');
  const recipientSnapshot = latest ? latest.recipient_snapshot : sms.recipient_snapshot;
  const expired = sms.status === 'BLOCKED' && String(sms.reason || '').startsWith('事件已超过自动通知时效');
  return {
    title: AUTO_SMS_STATUS[sms.status] || '通知结果待确认', reason: reasonText(sms.reason),
    tone: sms.status === 'SIMULATED_DELIVERED' ? 'success' : ['FAILED', 'UNKNOWN', 'UNAVAILABLE', 'BLOCKED'].includes(sms.status) ? 'warning' : 'muted',
    canRetry: !!sms.can_retry && !['SENDING', 'WAITING', 'UNKNOWN', 'SIMULATED_DELIVERED'].includes(sms.status),
    updatedAt: sms.updated_at, triggeredAt: sms.triggered_at, evaluatedAt: sms.evaluated_at, dataUpdatedAt: sms.data_updated_at,
    recipient: latest ? latest.recipient_name || recipientSnapshot?.recipient_name : recipientSnapshot ? recipientSnapshot.recipient_name : Number(sms.attempt_count) > 0 ? undefined : data.recipient?.name,
    recipientHint: recipientSnapshot?.contact_hint,
    simulated: data.sms_mode === 'SIMULATED' || sms.status === 'SIMULATED_DELIVERED',
    source: sms.trigger_source, policy: sms.policy_code,
    guidance: expired
      ? '请核对目标的最新观测和关联研判。测试自动通知需使用持续上报的新模拟场景，并配齐飞手信息；反复核实或刷新旧告警不会重新发送。'
      : ''
  };
}
