/* 新事件按规则自动移送；已有人工通知决定只按后端冻结事实兼容展示。 */
export const AUTO_HANDOFF_STATUS = {
  WAITING: '等待移送到处罚', MANUAL_REQUIRED: '需要选择处罚接收单位', BLOCKED: '暂时不能移送到处罚',
  PENDING: '处罚交接已建立，还没有发出', FAILED: '移送处罚发送失败', DISABLED: '自动移送尚未启用',
  INDEPENDENT: '移送按事件事实另行判断', NOT_REQUIRED: '不需要自动移送',
  PENDING_DECISION: '现场处置结束 · 待决定通知', DO_NOT_NOTIFY: '本次不通知（已记录）'
};
const TRIGGER_TITLE = { COUNTERMEASURE_COMPLETED: '已自动移送到处罚', JAMMING_COMPLETED: '已自动移送到处罚', MANUAL: '已选定接收单位移送到处罚' };

export function notificationProgressView(handoff) {
  if (!handoff || (!handoff.notification_decision && !['PENDING_DECISION', 'DO_NOT_NOTIFY'].includes(handoff.status))) return null;
  if (!handoff.handoff_id) return { title: '通知待办尚未建立', tone: 'warning' };
  if (handoff.status === 'PENDING_DECISION') return { title: AUTO_HANDOFF_STATUS.PENDING_DECISION, tone: 'warning' };
  if (handoff.status === 'DO_NOT_NOTIFY') return { title: AUTO_HANDOFF_STATUS.DO_NOT_NOTIFY, tone: 'muted' };
  if (handoff.notification_decision?.state === 'NOTIFY') {
    if (handoff.status === 'SUBMITTED') return { title: '已通知上级', tone: 'success' };
    if (handoff.status === 'FAILED') return { title: '通知上级发送失败', tone: 'warning' };
    if (handoff.status === 'PENDING') return { title: '已通知上级 · 送达待确认', tone: 'warning' };
  }
  return { title: '通知进度待确认', tone: 'warning' };
}

export function autoHandoffView(data, handoffId = '') {
  const handoff = data?.auto_handoff;
  const linked = handoff?.handoff_id || handoffId || '';
  if (!handoff?.status) {
    return { title: handoffId ? '已移送到处罚' : '移送状态暂不可用', reason: '', tone: handoffId ? 'success' : 'muted',
      handoffId: linked, canSubmit: false, partyUnidentified: false, partyReasons: [] };
  }
  const submitted = handoff.status === 'SUBMITTED';
  const notification = notificationProgressView({ ...handoff, handoff_id: linked });
  const title = notification?.title || (submitted ? TRIGGER_TITLE[handoff.trigger_source] || '已移送到处罚'
      : AUTO_HANDOFF_STATUS[handoff.status] || '移送状态暂不可用');
  return {
    title,
    reason: submitted ? '' : handoff.reason || '',
    tone: notification?.tone || (submitted ? 'success' : ['MANUAL_REQUIRED', 'BLOCKED', 'PENDING', 'FAILED', 'PENDING_DECISION'].includes(handoff.status) ? 'warning' : 'muted'),
    handoffId: linked,
    canSubmit: !notification && handoff.status === 'MANUAL_REQUIRED' && data?.can_handoff === true && !linked,
    partyUnidentified: handoff.party_status === 'UNIDENTIFIED',
    partyReasons: Array.isArray(handoff.party_reasons) ? handoff.party_reasons : []
  };
}

/* 提交前的当事人提示。当事人不明时仍可移送，但要提交人先确认知道这一点。 */
export function partyWarning(view) {
  if (!view?.partyUnidentified) return '';
  const reasons = view.partyReasons.length ? `${view.partyReasons.join('；')}。` : '';
  return `当事人不明，按待补线索移送：${reasons}处罚部门要凭无人机序列号、遥控器位置等线索继续查找当事人。`;
}

export function handoffSubmitError(error) {
  if (error?.code === 'VERSION_CONFLICT') return '事件已有更新，请关闭弹窗，刷新后再提交。';
  if (error?.code === 'HANDOFF_ALREADY_EXISTS') return '这条事件已经移送给这个单位，请刷新查看移送记录。';
  if (error?.code === 'IDEMPOTENCY_REPLAY') return '这次移送已经提交过，请刷新查看移送记录。';
  if (error?.code === 'RECIPIENT_NOT_CONFIGURED' || error?.code === 'RECIPIENT_NOT_FOUND') return '所选接收单位已停用或不存在，请重新选择。';
  if (error?.code === 'TIMEOUT' || error?.code === 'NETWORK_ERROR') return '提交结果还没确认，请先刷新查看移送记录，不要重复提交。';
  return error?.message || '提交失败，请稍后重试。';
}
