import { apiRequestTimed, buildQuery } from './apiClient.js';

/* 阶段 5 交接适配层：只包装后端 /handoff-recipients 与 /handoffs 接口，不复制任何状态机。
   提交成功只表示材料入库（PENDING_DELIVERY），不表示已发送、已送达或处罚办结。
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

export function getHandoff(handoffId) {
  return apiRequestTimed(`/handoffs/${encodeURIComponent(handoffId)}`);
}

export function listHandoffDeliveries(handoffId, params) {
  return apiRequestTimed(`/handoffs/${encodeURIComponent(handoffId)}/deliveries${buildQuery(params)}`);
}

export const handoffApi = { listHandoffRecipients, createHandoff, listHandoffs, getHandoff, listHandoffDeliveries };
