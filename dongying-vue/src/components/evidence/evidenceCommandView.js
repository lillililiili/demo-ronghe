// 只整理展示，不修改指令状态，也不把历史结果说明补造成独立设备回执。
const actions = {
  EO_BEGIN_TRACK: '让摄像机开始自动跟踪目标', EO_TRACK_BEGIN: '让摄像机开始自动跟踪目标',
  EO_END_TRACK: '停止摄像机对目标的自动跟踪', EO_TRACK_END: '停止摄像机对目标的自动跟踪',
  EO_CAMERA_STATUS: '查询摄像机当前状态', EMERGENCY_STOP: '要求设备立即停止当前执行的操作',
  COUNTERMEASURE_4CH: '向反制设备下发通道控制指令', LINGYUN_CONTROL: '向设备下发控制指令',
};
const reasons = {
  OPERATOR_BEGIN_TRACK: '操作员手动开始跟踪', OPERATOR_END_TRACK: '操作员手动结束跟踪',
  AUTO_TRACK_CONDITION_CLEARED: '自动跟踪条件已不满足，系统结束跟踪',
};
const eoEvents = { EO_BEGIN_TRACK: 'BeginTracking', EO_TRACK_BEGIN: 'BeginTracking',
  EO_END_TRACK: 'EndTracking', EO_TRACK_END: 'EndTracking', EO_CAMERA_STATUS: 'CameraStatus' };
const eoResults = { BeginTracking: '已开始光电跟踪', EndTracking: '已结束光电跟踪', CameraStatus: '已返回摄像机状态' };
const eoNames = { BeginTracking: '开始光电跟踪', EndTracking: '结束光电跟踪', CameraStatus: '查询摄像机状态' };

function parseObject(value) {
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  } catch { return null; }
}
function eoFeedback(value, type) {
  const payload = parseObject(value), event = eoEvents[type];
  if (!event || payload?.event !== event) return null;
  const code = payload.metadata?.codeStatus;
  if (code == null || !/^\d+$/.test(String(code))) return null;
  return { success: Number(code) === 200, name: eoNames[event], text: Number(code) === 200
    ? `设备反馈：${eoResults[event]}` : `设备反馈：${eoNames[event]}未成功` };
}
function readableReason(value) {
  if (!value) return '未记录发起原因';
  if (Object.hasOwn(reasons, value)) return reasons[value];
  return /^[\s]*[\[{]/.test(value) || /^[A-Z][A-Z0-9_:-]*$/.test(value)
    ? '操作原因尚未转为中文，可展开原始记录查看' : value;
}
function receiptView(receipt, type) {
  const feedback = receipt.receipt_kind === 'PROTOCOL_C' ? eoFeedback(receipt.payload, type) : null;
  const kind = receipt.receipt_kind;
  const outcome = feedback ? (feedback.success ? 'success' : 'failure')
    : kind === 'SUCCEEDED' ? 'success' : kind === 'FAILED' ? 'failure' : null;
  const labels = { ACCEPTED: '设备已受理指令，等待执行结果', ACK: '设备已接收指令，等待执行结果',
    SUCCEEDED: '设备反馈：执行完成', FAILED: '设备反馈：执行失败', COMPLETED: '已收到设备执行反馈',
    RESULT: '已收到设备结果反馈', PROTOCOL_C: '已收到光电设备反馈，具体结果待核对' };
  return { id: receipt.receipt_id, time: receipt.occurred_at ?? receipt.received_at,
    text: feedback?.text || labels[kind] || '已收到设备反馈，类型尚未识别', outcome,
    terminal: outcome != null || kind === 'COMPLETED' };
}

export function buildCommandView(command = {}) {
  const receipts = (Array.isArray(command.receipts) ? command.receipts : []).map(row => receiptView(row, command.command_type));
  const legacy = eoFeedback(command.result_detail, command.command_type);
  const view = { action: actions[command.command_type] || '设备操作，具体内容见原始记录',
    reason: readableReason(command.reason), receipts, status: '执行结果未知', tone: 'warning',
    explanation: '当前记录不足以确认执行结果，请核对设备反馈。' };
  const success = receipts.some(row => row.outcome === 'success');
  const failure = receipts.some(row => row.outcome === 'failure');
  if ((success && failure) || (command.status === 'SUCCEEDED' && (failure || legacy?.success === false))
      || (command.status === 'FAILED' && (success || legacy?.success === true))) {
    return { ...view, status: '记录不一致，结果待核对', explanation: '平台状态与已保存的设备反馈不一致，请核对原始记录。' };
  }
  switch (command.status) {
    case 'QUEUED': return { ...view, status: '等待下发', tone: 'neutral', explanation: '指令已进入队列，尚未下发到设备。' };
    case 'SENT': return { ...view, status: '已下发，等待设备反馈', tone: 'neutral', explanation: '已下发指令，执行结果尚未确认。' };
    case 'ACCEPTED': return { ...view, status: '设备已接收，等待执行结果', tone: 'neutral', explanation: '设备已受理指令，尚不能据此认定执行完成。' };
    case 'SUCCEEDED':
      if (receipts.some(row => row.terminal)) return { ...view, status: '设备反馈执行完成', tone: 'success',
        explanation: '平台完成记录与设备执行回执一致。' };
      return { ...view, status: '平台记录完成，结果待核对', explanation: legacy?.success
        ? `已保存“${legacy.name}”的成功反馈，但尚缺可确认执行结果的独立设备回执，请核对原始记录。`
        : '平台记录为完成，但当前缺少可确认执行结果的设备回执。' };
    case 'FAILED': return { ...view, status: failure ? '设备反馈执行失败' : '指令处理失败', tone: 'danger',
      explanation: failure ? '设备反馈本次操作未成功，请联系设备管理人员核查。'
        : '平台记录本次指令处理失败，具体原因见原始记录。' };
    case 'TIMED_OUT': return { ...view, status: '设备反馈超时，结果待确认',
      explanation: '未在规定时间内确认执行结果；超时不代表设备未执行，请先核对，避免重复下发。' };
    case 'CANCELLED': return { ...view, status: '指令已取消', tone: 'neutral',
      explanation: '平台已取消本次指令；如指令已经下发，仍需核对设备是否执行或停止。' };
    default: return view;
  }
}
