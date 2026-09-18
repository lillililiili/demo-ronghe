// 送达与签收分别读取后台事实；列表、详情和筛选共用，不从按钮点击推定成功。
export const DELIVERY_OPTIONS = [
  { value: 'PENDING_DELIVERY', label: '待发送', tag: 't-amber', tone: 'warn', color: 'amber', icon: 'alert' },
  { value: 'SUBMITTED', label: '送达待确认', tag: 't-cyan', tone: 'info', color: 'cyan', icon: 'clock' },
  { value: 'DELIVERED', label: '已送达', tag: 't-green', tone: 'good', color: 'green', icon: 'check' },
  { value: 'FAILED', label: '发送失败', tag: 't-red', tone: 'bad', color: 'red', icon: 'alert' }
];
export const RECEIPT_OPTIONS = [
  { value: 'NOT_EXPECTED', label: '未进入签收', tag: 't-gray' },
  { value: 'PENDING', label: '等待签收回执', tag: 't-amber' },
  { value: 'ACKNOWLEDGED', label: '已签收', tag: 't-green' },
  { value: 'TIMEOUT', label: '回执超时', tag: 't-red' }
];
const reasonOf = row => row?.latest_delivery?.blocked_reason ?? row?.blocked_reason;
export function deliveryView(row) {
  if (row?.delivery_status === 'SUBMITTED') {
    if (reasonOf(row) === 'DELIVERY_OUTCOME_UNKNOWN') return { label: '发送结果未知', tag: 't-amber', tone: 'warn' };
    if (reasonOf(row) === 'DELIVERY_IN_PROGRESS') return { label: '发送处理中', tag: 't-cyan', tone: 'info' };
  }
  return DELIVERY_OPTIONS.find(item => item.value === row?.delivery_status) || { label: '送达状态未知', tag: 't-gray', tone: 'warn' };
}
export function receiptView(row) {
  if (row?.receipt_status === 'PENDING' && row?.delivery_status === 'SUBMITTED'
    && ['DELIVERY_IN_PROGRESS', 'DELIVERY_OUTCOME_UNKNOWN'].includes(reasonOf(row))) {
    return { label: '回执待确认', tag: 't-gray' };
  }
  if (row?.receipt_status === 'NOT_EXPECTED' && row?.delivery_status === 'DELIVERED') return { label: '未要求签收回执', tag: 't-gray' };
  return RECEIPT_OPTIONS.find(item => item.value === row?.receipt_status) || { label: '回执状态未知', tag: 't-gray' };
}
export function statusQuery(delivery, receipt) {
  const query = {};
  if (DELIVERY_OPTIONS.some(item => item.value === delivery)) query.delivery_status = delivery;
  if (RECEIPT_OPTIONS.some(item => item.value === receipt)) query.receipt_status = receipt;
  return query;
}
