/* 处罚移送进度（2026-10-18 rose 确认）：只有真正发出（已提交给接收方或已送达）才算“已移送处罚”；
   交接已建立但还没有发出写“待发送移送”。告警列表、融合感知和后台报表用同一口径。
   这里只整理已读到的事实，不推进投递，也不替人发送。 */

/** 最近一次投递已经发出的状态。PENDING_DELIVERY 是还没发，FAILED 是发送失败。 */
export const PUNISHMENT_SENT_DELIVERY = ['SUBMITTED', 'DELIVERED'];

export const HANDED_OFF = 'HANDED_OFF';
export const HANDOFF_PENDING = 'HANDOFF_PENDING';

/**
 * 按 /handoffs 列表行判断本事件的处罚移送进度。
 * @param {Array<{handoff_type?:string,delivery_status?:string}>} rows
 * @returns {'HANDED_OFF'|'HANDOFF_PENDING'|null}
 */
export function punishmentHandoffProgress(rows) {
  const live = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.handoff_type === 'UAV_PUNISHMENT' && row.delivery_status && row.delivery_status !== 'FAILED');
  if (!live.length) return null;
  // 状态读不懂的也不说成已移送：只有明确发出的才算。
  return live.some(row => PUNISHMENT_SENT_DELIVERY.includes(row.delivery_status)) ? HANDED_OFF : HANDOFF_PENDING;
}

/**
 * 按处置进度摘要里的 auto_handoff 判断（后台：SUBMITTED=已发出，PENDING=交接已建立未发出）。
 * 通知决定流程（待决定、已选择不通知）另有说法，不在这里归类。
 * @returns {'HANDED_OFF'|'HANDOFF_PENDING'|null}
 */
export function autoHandoffProgress(autoHandoff) {
  if (!autoHandoff?.handoff_id) return null;
  if (autoHandoff.status === 'SUBMITTED') return HANDED_OFF;
  if (autoHandoff.status === 'PENDING') return HANDOFF_PENDING;
  return null;
}

/** 两处来源合并：任一处已确认发出就是已移送，否则只要交接已建立就是待发送。 */
export function mergeHandoffProgress(...values) {
  if (values.includes(HANDED_OFF)) return HANDED_OFF;
  if (values.includes(HANDOFF_PENDING)) return HANDOFF_PENDING;
  return null;
}
