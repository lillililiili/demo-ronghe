// 送达与签收分别读取后台事实；列表、详情和筛选共用，不从按钮点击推定成功。
export const DELIVERY_OPTIONS = [
  { value: 'PENDING_DELIVERY', label: '待发送', tag: 't-amber', tone: 'warn', color: 'amber', icon: 'alert' },
  { value: 'SUBMITTED', label: '送达待确认', tag: 't-cyan', tone: 'info', color: 'cyan', icon: 'clock' },
  { value: 'DELIVERED', label: '已送达', tag: 't-green', tone: 'good', color: 'green', icon: 'check' },
  { value: 'FAILED', label: '发送失败', tag: 't-red', tone: 'bad', color: 'red', icon: 'alert' }
];
export const DECISION_OPTIONS = [
  { value: 'PENDING_DECISION', label: '待决定通知', tag: 't-amber', tone: 'warn', color: 'amber', icon: 'clock' },
  { value: 'DO_NOT_NOTIFY', label: '已选择不通知', tag: 't-gray', tone: 'info', color: 'gray', icon: 'check' }
];
export const NOTIFICATION_OPTIONS = [...DECISION_OPTIONS, ...DELIVERY_OPTIONS];
export const RECEIPT_OPTIONS = [
  { value: 'NOT_EXPECTED', label: '未进入签收', tag: 't-gray' },
  { value: 'PENDING', label: '等待签收回执', tag: 't-amber' },
  { value: 'ACKNOWLEDGED', label: '已签收', tag: 't-green' },
  { value: 'TIMEOUT', label: '回执超时', tag: 't-red' }
];
const reasonOf = row => row?.latest_delivery?.blocked_reason ?? row?.blocked_reason;
export function deliveryView(row) {
  const decision = DECISION_OPTIONS.find(item => item.value === row?.notification_decision?.state);
  if (decision) return decision;
  if (row?.simulated && row.delivery_status === 'DELIVERED') return { label: '模拟已送达', tag: 't-amber', tone: 'warn' };
  if (row?.delivery_status === 'SUBMITTED') {
    if (reasonOf(row) === 'DELIVERY_OUTCOME_UNKNOWN') return { label: '发送结果未知', tag: 't-amber', tone: 'warn' };
    if (reasonOf(row) === 'DELIVERY_IN_PROGRESS') return { label: '发送处理中', tag: 't-cyan', tone: 'info' };
  }
  return DELIVERY_OPTIONS.find(item => item.value === row?.delivery_status) || { label: '送达状态未知', tag: 't-gray', tone: 'warn' };
}
export function receiptView(row) {
  if (row?.simulated && row.receipt_status === 'ACKNOWLEDGED') return { label: '模拟已签收', tag: 't-amber' };
  if (row?.receipt_status === 'PENDING' && row?.delivery_status === 'SUBMITTED'
    && ['DELIVERY_IN_PROGRESS', 'DELIVERY_OUTCOME_UNKNOWN'].includes(reasonOf(row))) {
    return { label: '回执待确认', tag: 't-gray' };
  }
  if (row?.receipt_status === 'NOT_EXPECTED' && row?.delivery_status === 'DELIVERED') return { label: '未要求签收回执', tag: 't-gray' };
  return RECEIPT_OPTIONS.find(item => item.value === row?.receipt_status) || { label: '回执状态未知', tag: 't-gray' };
}
export function statusQuery(delivery, receipt) {
  const query = {};
  if (DECISION_OPTIONS.some(item => item.value === delivery)) query.notification_decision = delivery;
  else if (DELIVERY_OPTIONS.some(item => item.value === delivery)) query.delivery_status = delivery;
  if (RECEIPT_OPTIONS.some(item => item.value === receipt)) query.receipt_status = receipt;
  return query;
}

// 统计使用同一通知维度，避免两个决定状态混入“待发送”。
export function notificationStatisticsFilters(filters) {
  const { notification_decision, delivery_status, ...query } = filters;
  const selected = notification_decision || delivery_status;
  if (selected) query.notification_status = selected;
  return query;
}

export function notificationActions(row, pending = null, pendingChecked = false) {
  const state = row?.notification_decision?.state;
  const waiting = state === 'PENDING_DECISION';
  const noUnknownOutcome = !['DELIVERY_OUTCOME_UNKNOWN', 'DELIVERY_IN_PROGRESS'].includes(reasonOf(row));
  const refreshOnly = !!pending || !noUnknownOutcome;
  const showNotify = !refreshOnly && state !== 'DO_NOT_NOTIFY'
    && ['PENDING_DELIVERY', 'FAILED'].includes(row?.delivery_status) && row?.receipt_status !== 'ACKNOWLEDGED';
  const showDecline = waiting && !refreshOnly && row?.delivery_status === 'PENDING_DELIVERY';
  const canRetryOriginal = !!pending && pendingChecked && noUnknownOutcome && (pending.kind === 'decline'
    ? waiting && row?.delivery_status === 'PENDING_DELIVERY' && row?.receipt_status === 'NOT_EXPECTED'
      && row?.can_decline === true && row.notification_decision.version === pending.version
    : ((waiting && row?.delivery_status === 'PENDING_DELIVERY') || (state === 'NOTIFY' && row?.delivery_status === 'FAILED'))
      && row?.can_notify === true && row.expected_attempt_no === pending.attempt);
  return { showNotify, canNotify: showNotify && row?.can_notify === true,
    showDecline, canDecline: showDecline && row?.can_decline === true, refreshOnly, canRetryOriginal };
}

export function declineReasonError(value) {
  const text = String(value || '').trim();
  return !text ? '请填写不通知原因。' : text.length > 1000 ? '不通知原因不能超过1000字。' : '';
}

export function pendingOperationSettled(pending, row) {
  if (!pending) return false;
  return pending.kind === 'decline' ? row?.notification_decision?.version > pending.version
    : row?.expected_attempt_no > pending.attempt || row?.notification_decision?.state === 'DO_NOT_NOTIFY';
}
