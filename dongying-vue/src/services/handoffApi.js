import { apiRequestTimed, buildQuery, mapPool } from './apiClient.js';
import { readDistributionCounts } from '@/services/distributionStatistics.js';

/* 阶段 5 交接适配层：只包装后端 /handoff-recipients 与 /handoffs 接口，不复制任何状态机。
   提交成功保证材料入库；后端尝试投递，发送与送达以返回事实为准，不表示处罚办结。
   超时/断网由 apiClient 统一抛 TIMEOUT/NETWORK_ERROR；页面用 isUncertainOutcome 判断“结果未知”。 */

export function newHandoffIdempotencyKey() {
  return `handoff-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function listHandoffRecipients(handoffType) {
  return apiRequestTimed(`/handoff-recipients${buildQuery({ handoff_type: handoffType })}`);
}

/* body 只允许 source_kind/source_id/handoff_type/recipient_id/expected_version；
   幂等键由调用方保存并在重试时沿用，服务端 409 IDEMPOTENCY_REPLAY 表示已提交过。 */
export function createHandoff(body, idempotencyKey) {
  return apiRequestTimed('/handoffs', { method: 'POST', body, mutation: true, idempotencyKey });
}

export function listHandoffs(params) {
  return apiRequestTimed(`/handoffs${buildQuery(params)}`);
}

export async function getHandoffStatistics(filters, options = {}) {
  const result = await readDistributionCounts(listHandoffs, filters, [
    { key: 'by_delivery', field: 'delivery_status', codes: ['PENDING_DELIVERY', 'SUBMITTED', 'DELIVERED', 'FAILED'] },
    { key: 'by_receipt', field: 'receipt_status', codes: ['NOT_EXPECTED', 'PENDING', 'ACKNOWLEDGED', 'TIMEOUT'] }
  ], options);
  // Day boundaries use business time (UTC+8), independent of the browser timezone.
  const dayMs = 86400000, offset = 8 * 3600000;
  const today = Math.floor((Date.now() + offset) / dayMs) * dayMs - offset;
  result.by_day = await mapPool(Array.from({ length: 7 }, (_, i) => today - (6 - i) * dayMs), 3, async day => {
    const code = new Date(day + offset).toISOString().slice(0, 10);
    const from = Math.max(day, filters.created_from ?? day);
    const to = Math.min(day + dayMs, filters.created_to ?? day + dayMs);
    if (options.isCurrent && !options.isCurrent()) return { code, count: null };
    if (from >= to || !result.total) return { code, count: 0 };
    const data = await listHandoffs({ ...filters, created_from: from, created_to: to, page: 1, size: 1 });
    return { code, count: data.total };
  });
  return result;
}

export function getHandoff(handoffId) {
  return apiRequestTimed(`/handoffs/${encodeURIComponent(handoffId)}`);
}

export function listHandoffDeliveries(handoffId, params) {
  return apiRequestTimed(`/handoffs/${encodeURIComponent(handoffId)}/deliveries${buildQuery(params)}`);
}

export function getHandoffNotification(handoffId) {
  return apiRequestTimed(`/handoffs/${encodeURIComponent(handoffId)}/notifications`);
}

export function notifyHandoff(handoffId, expectedAttemptNo, idempotencyKey) {
  return apiRequestTimed(`/handoffs/${encodeURIComponent(handoffId)}/notifications`, {
    method: 'POST', mutation: true, idempotencyKey, body: { expected_attempt_no: expectedAttemptNo }
  });
}

export const handoffApi = { listHandoffRecipients, createHandoff, listHandoffs, getHandoff, listHandoffDeliveries, getHandoffNotification, notifyHandoff };
