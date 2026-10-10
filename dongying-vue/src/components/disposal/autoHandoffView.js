/* 处置进度里的“移送处罚”一行。只读后端 auto_handoff，状态和原因都以后端为准。
   MANUAL_REQUIRED（启用了多个处罚接收单位）时，有移送权限的人在这里选定接收单位后提交（2026-10-06）。 */
export const AUTO_HANDOFF_STATUS = {
  WAITING: '等待移送到处罚', MANUAL_REQUIRED: '需要选择处罚接收单位', BLOCKED: '暂时不能移送到处罚',
  PENDING: '处罚交接已建立，还没有发出', FAILED: '移送处罚发送失败', DISABLED: '自动移送尚未启用',
  INDEPENDENT: '移送按事件事实另行判断', NOT_REQUIRED: '不需要自动移送'
};
const TRIGGER_TITLE = { COUNTERMEASURE_COMPLETED: '已自动移送到处罚', JAMMING_COMPLETED: '已自动移送到处罚', MANUAL: '已选定接收单位移送到处罚' };

export function autoHandoffView(data, handoffId = '') {
  const handoff = data?.auto_handoff;
  const linked = handoff?.handoff_id || handoffId || '';
  if (!handoff?.status) {
    return { title: handoffId ? '已移送到处罚' : '移送状态暂不可用', reason: '', tone: handoffId ? 'success' : 'muted',
      handoffId: linked, canSubmit: false, partyUnidentified: false, partyReasons: [] };
  }
  const submitted = handoff.status === 'SUBMITTED';
  const title = submitted ? TRIGGER_TITLE[handoff.trigger_source] || '已移送到处罚'
    : AUTO_HANDOFF_STATUS[handoff.status] || '移送状态暂不可用';
  return {
    title,
    reason: submitted ? '' : handoff.reason || '',
    tone: submitted ? 'success' : ['MANUAL_REQUIRED', 'BLOCKED', 'PENDING', 'FAILED'].includes(handoff.status) ? 'warning' : 'muted',
    handoffId: linked,
    // 只有后端说要人选单位、且当前账号能移送时才给入口。
    canSubmit: handoff.status === 'MANUAL_REQUIRED' && data?.can_handoff === true && !linked,
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
