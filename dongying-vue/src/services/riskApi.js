import { apiBinary, apiRequestTimed, buildQuery } from './apiClient.js';

// 业务地图、列表、当前风险与导出同源排除预设样例和直接 QA 风险输入。
// 有效模拟观测、预报规则派生风险及真实来源由服务端按来源契约保留。
const displayQuery = params => buildQuery({ exclude_demo_samples: true, ...params });

export function newRiskIdempotencyKey() {
  return `risk-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// 只经 apiRequestTimed 访问服务端：超时统一抛 TIMEOUT/408，页面按“结果未知”回读，绝不回退 window.MOCK。
export const riskApi = {
  listRisks: params => apiRequestTimed(`/risks${displayQuery(params)}`),
  listCurrentRisks: params => apiRequestTimed(`/risks/current${displayQuery(params)}`),
  /* 导出与列表同参（含 sort/order 与筛选）；文件名取服务端的 Content-Disposition。
     上限 5000 行由服务端判，超限回 400 EXPORT_TOO_LARGE。 */
  exportRisksCsv: params => apiBinary(`/risks/export.csv${displayQuery(params)}`),
  /* 区域字典按页取（15-22），语义同 /alarms/districts。 */
  listDistricts: () => apiRequestTimed('/risks/districts'),
  getRisk: riskId => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}`),
  getWeatherFact: riskId => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/weather-fact`),
  listRiskVerifications: (riskId, params) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/verifications${buildQuery(params)}`),
  verifyRisk: (riskId, body, idempotencyKey) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/verifications`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  /* 阶段 9 空间安全风险：细类字典、空间事实、汇总与评估运行记录。 */
  listSpaceObjectSubtypes: () => apiRequestTimed('/space-object-subtypes'),
  getSpaceFact: riskId => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/space-fact`),
  /* P03：鸟群风险的评估历史（共评估几次、每段离航线多远、当时是否构成风险）；不是鸟群风险时 applicable=false。 */
  getEvaluationHistory: (riskId, params) => apiRequestTimed(`/risks/${encodeURIComponent(riskId)}/evaluation-history${buildQuery(params)}`),
  spaceRiskSummary: params => apiRequestTimed(`/space-risks/summary${displayQuery(params)}`),
  listRuleEvaluations: params => apiRequestTimed(`/rule-evaluations${buildQuery(params)}`),
  triggerRuleEvaluation: (body, idempotencyKey) => apiRequestTimed('/rule-evaluations', {
    method: 'POST', body, mutation: true, idempotencyKey
  })
};
