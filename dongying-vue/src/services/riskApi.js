import { apiBinary, apiRequestTimed, buildQuery } from './apiClient.js';

export function newRiskIdempotencyKey() {
  return `risk-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// 只经 apiRequestTimed 访问服务端：超时统一抛 TIMEOUT/408，页面按“结果未知”回读，绝不回退 window.MOCK。
export const riskApi = {
  listRisks: params => apiRequestTimed(`/risks${buildQuery(params)}`),
  /* 导出与列表同参（含 sort/order 与筛选）；文件名取服务端的 Content-Disposition。
     上限 5000 行由服务端判，超限回 400 EXPORT_TOO_LARGE。 */
  exportRisksCsv: params => apiBinary(`/risks/export.csv${buildQuery(params)}`),
  /* 区域字典按页取（15-22），语义同 /alarms/districts。 */
  listDistricts: () => apiRequestTimed('/risks/districts'),
  getRisk: riskId => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}`),
  listRiskVerifications: (riskId, params) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/verifications${buildQuery(params)}`),
  verifyRisk: (riskId, body, idempotencyKey) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/verifications`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  /* 阶段 9 空间安全风险：细类字典、空间事实、汇总与评估运行记录。 */
  listSpaceObjectSubtypes: () => apiRequestTimed('/space-object-subtypes'),
  getSpaceFact: riskId => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/space-fact`),
  spaceRiskSummary: params => apiRequestTimed(`/space-risks/summary${buildQuery(params)}`),
  listRuleEvaluations: params => apiRequestTimed(`/rule-evaluations${buildQuery(params)}`),
  triggerRuleEvaluation: (body, idempotencyKey) => apiRequestTimed('/rule-evaluations', {
    method: 'POST', body, mutation: true, idempotencyKey
  })
};
