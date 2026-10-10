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
export function commandSource(command = {}, sourceMode = command.source_mode) {
  // 本地协议模拟器也使用 live 通道；模拟属性必须读指令/回执的明确标记，不能猜设备名。
  const simulated = sourceMode === 'mock' || command.simulated === true
    || (Array.isArray(command.receipts) && command.receipts.some(row => parseObject(row.payload)?.simulated === true));
  if (sourceMode === 'replay') return { simulated, label: '回放来源', note: '回放数据，非现场实时执行。' };
  if (simulated) return { simulated, label: '模拟来源', note: '模拟数据，不代表现场实际执行结果。' };
  return { simulated: false, label: sourceMode === 'live' ? '现场来源' : '来源未记录', note: '' };
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
function receiptView(receipt, type, source) {
  const kind = receipt.receipt_kind;
  const relaySetting = type === 'COUNTERMEASURE_4CH' && kind === 'PROTOCOL_4CH'
    && receipt.device_result_code === 'COUNTERMEASURE_SET_OK';
  const late = kind === 'PROTOCOL_B_LATE';
  const lingyun = kind === 'PROTOCOL_B' || late;
  const known = type === 'LINGYUN_CONTROL' && lingyun
    && ['PROTOCOL_B_OK', 'PROTOCOL_B_FAILED'].includes(receipt.device_result_code);
  const feedback = relaySetting
    ? { success: true, text: `${source.simulated ? '模拟设备' : '设备'}反馈：通道设置成功` }
    : kind === 'PROTOCOL_C' ? eoFeedback(receipt.payload, type) : known
    ? { success: receipt.device_result_code === 'PROTOCOL_B_OK', text: (late ? '迟到设备反馈：' : '设备反馈：')
      + (receipt.device_result_code === 'PROTOCOL_B_OK' ? '本次指令返回成功' : '本次指令返回失败') + (late ? '（原任务）' : '') } : null;
  const outcome = feedback ? (feedback.success ? 'success' : 'failure')
    : kind === 'SUCCEEDED' ? 'success' : kind === 'FAILED' ? 'failure' : null;
  const labels = { ACCEPTED: '设备已受理指令，等待执行结果', ACK: '设备已接收指令，等待执行结果',
    SUCCEEDED: '设备反馈：执行完成', FAILED: '设备反馈：执行失败', COMPLETED: '已收到设备执行反馈',
    RESULT: '已收到设备结果反馈', PROTOCOL_B: '已收到设备反馈，具体结果待核对',
    PROTOCOL_B_LATE: '迟到设备反馈：具体结果待核对（原任务）', PROTOCOL_C: '已收到光电设备反馈，具体结果待核对',
    PROTOCOL_4CH: '已收到四通道反馈，通道设置结果待核对' };
  return { id: receipt.receipt_id, time: receipt.occurred_at ?? receipt.received_at,
    text: feedback?.text || labels[kind] || '已收到设备反馈，类型尚未识别', outcome,
    relaySetting, lingyunResult: known && !late, late, terminal: !late && (outcome != null || kind === 'COMPLETED') };
}

export function buildCommandView(command = {}, sourceMode = command.source_mode) {
  const source = commandSource(command, sourceMode);
  const receipts = (Array.isArray(command.receipts) ? command.receipts : []).map(row => receiptView(row, command.command_type, source));
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
  if (['TIMED_OUT', 'CANCELLED'].includes(command.status) && receipts.some(row => row.late)) {
    return { ...view, status: command.status === 'TIMED_OUT' ? '原任务超时，已收到迟到反馈' : '原任务已取消，已收到迟到反馈',
      explanation: '迟到反馈已保存在原任务下，保留原超时或取消结论，不自动重发或续链；请结合实际设备状态核查。' };
  }
  switch (command.status) {
    case 'QUEUED': return { ...view, status: '等待下发', tone: 'neutral', explanation: '指令已进入队列，尚未下发到设备。' };
    case 'SENT': return { ...view, status: '已下发，等待设备反馈', tone: 'neutral', explanation: '已下发指令，执行结果尚未确认。' };
    case 'ACCEPTED': return { ...view, status: '设备已接收，等待执行结果', tone: 'neutral', explanation: '设备已受理指令，尚不能据此认定执行完成。' };
    case 'SUCCEEDED':
      if (receipts.some(row => row.relaySetting)) return { ...view,
        status: sourceMode === 'replay' ? '回放记录：通道设置成功' : `${source.simulated ? '模拟设备' : '设备'}已确认通道设置成功`, tone: 'success',
        explanation: '已收到本次指令的四通道设置回执，仅确认通道设置成功，不代表射频已发射或目标已被反制。' };
      if (command.command_type === 'COUNTERMEASURE_4CH') return { ...view, status: '平台记录完成，通道设置待核对',
        explanation: '尚缺可确认通道设置成功的四通道回执，请核对原始记录。' };
      if (command.command_type === 'LINGYUN_CONTROL') {
        if (receipts.some(row => row.lingyunResult && row.outcome === 'success')) return { ...view,
          status: sourceMode === 'replay' ? '回放记录：指令返回成功' : `${source.simulated ? '模拟设备' : '设备'}已返回成功回执`, tone: 'success',
          explanation: '仅表示设备对本次指令返回成功；不据此认定整次处置结束、设备已经停止或现场效果已确认。' };
        return { ...view, status: '平台记录完成，结果待核对',
          explanation: '尚缺与本次指令匹配的明确设备成功回执，请核对原始记录。' };
      }
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
