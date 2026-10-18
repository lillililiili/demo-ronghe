/* 风险详情标题上的通知状态（2026-10-18 rose 确认，流程 6）：已通知过的风险，标题和下面“通知与回执”的同一条记录
   用同一套判断——都按这条通知记录的发送和签收状态说，不再出现标题“已回执”、记录却“送达待确认、等待签收回执”。
   记录还没读到时沿用风险自身状态；只整理展示，不改风险或通知的状态。 */

const NOTICE_STATES = ['NOTIFIED', 'ACKNOWLEDGED'];

/** 本风险当前有效的那条通知：取最近一条没有发送失败的；都失败了取最近一条。列表按创建时间新到旧。 */
export function currentRiskNotice(notices) {
  const rows = (Array.isArray(notices) ? notices : []).filter(Boolean);
  return rows.find(row => row.delivery_status && row.delivery_status !== 'FAILED') || rows[0] || null;
}

/**
 * @param {object|null} risk 风险详情
 * @param {Array|null} notices 通知记录（handoffs 列表行，含 delivery_status / receipt_status）
 * @param {{ label: (state:string)=>string, tag: (state:string)=>string, loaded?: boolean }} base 风险状态的原有说法
 * @returns {{ label: string, tag: string }}
 */
export function riskHeaderState(risk, notices, { label, tag, loaded = true }) {
  const fallback = { label: label(risk?.state), tag: tag(risk?.state) };
  if (!risk || !NOTICE_STATES.includes(risk.state) || !loaded) return fallback;
  const notice = currentRiskNotice(notices);
  if (!notice) return fallback;
  if (notice.receipt_status === 'ACKNOWLEDGED') return { label: '已回执', tag: 't-green' };
  if (notice.receipt_status === 'TIMEOUT') return { label: '回执超时', tag: 't-red' };
  if (notice.delivery_status === 'FAILED') return { label: '通知发送失败', tag: 't-red' };
  if (notice.delivery_status === 'DELIVERED') return { label: '已送达，等待回执', tag: 't-blue' };
  if (notice.delivery_status === 'SUBMITTED') return { label: '送达待确认', tag: 't-blue' };
  if (notice.delivery_status === 'PENDING_DELIVERY') return { label: '等待发送', tag: 't-amber' };
  return fallback;
}

/** 风险状态变了（例如对方签收后变成已回执）而通知记录还停在旧状态时，需要重读通知记录。 */
export function noticesLagBehindRisk(risk, notices) {
  if (!risk || !NOTICE_STATES.includes(risk.state)) return false;
  const notice = currentRiskNotice(notices);
  if (!notice) return true;
  return risk.state === 'ACKNOWLEDGED' && notice.receipt_status !== 'ACKNOWLEDGED';
}
