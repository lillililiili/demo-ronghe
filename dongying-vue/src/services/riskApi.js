import { apiRequestTimed, buildQuery } from './apiClient.js';

export function newRiskIdempotencyKey() {
  return `risk-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// 只经 apiRequestTimed 访问服务端：超时统一抛 TIMEOUT/408，页面按“结果未知”回读，绝不回退 window.MOCK。
export const riskApi = {
  listRisks: params => apiRequestTimed(`/risks${buildQuery(params)}`),
  getRisk: riskId => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}`),
  listRiskVerifications: (riskId, params) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/verifications${buildQuery(params)}`),
  verifyRisk: (riskId, body, idempotencyKey) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/verifications`, {
    method: 'POST', body, mutation: true, idempotencyKey
  })
};
