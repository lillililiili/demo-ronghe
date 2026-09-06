import { apiRequest, apiRequestTimed, buildQuery } from './apiClient.js';

// 只读取后端已经保存的研判，不包含前端重算、人工改判或把空结果补成“合法”的规则。
// 阶段 3 的计划维度投影接口保留；阶段 7 引擎研判/复核/规则效果统一走 apiRequestTimed：
// 超时抛 TIMEOUT/408，写请求超时按“结果未知”回读，绝不回退 window.MOCK。
const encode = value => encodeURIComponent(String(value));
const mutation = (path, body, idempotencyKey) => apiRequestTimed(path, { method: 'POST', body, mutation: true, idempotencyKey });

export const legalityApi = {
  history: (planId, params) => apiRequest(`/flight-plans/${encode(planId)}/legality-assessments${buildQuery(params)}`),
  detail: assessmentId => apiRequest(`/legality-assessments/${encode(assessmentId)}`),

  /* 阶段 7：引擎研判读取 */
  listEvaluations: params => apiRequestTimed(`/legality-evaluations${buildQuery(params)}`),
  getEvaluation: evaluationId => apiRequestTimed(`/legality-evaluations/${encode(evaluationId)}`),
  listRevisions: (evaluationId, params) => apiRequestTimed(`/legality-evaluations/${encode(evaluationId)}/revisions${buildQuery(params)}`),

  /* 阶段 7：写动作（Idempotency-Key 由调用方保留，直到服务端给出明确结果） */
  evaluate: (body, idempotencyKey) => mutation('/legality-evaluations', body, idempotencyKey),
  reviseEvaluation: (evaluationId, body, idempotencyKey) => mutation(`/legality-evaluations/${encode(evaluationId)}/revisions`, body, idempotencyKey),
  recomputeEvaluation: (evaluationId, body, idempotencyKey) => mutation(`/legality-evaluations/${encode(evaluationId)}/recompute`, body, idempotencyKey),
  escalateEvaluation: (evaluationId, body, idempotencyKey) => mutation(`/legality-evaluations/${encode(evaluationId)}/alarms`, body, idempotencyKey),

  /* 阶段 7：规则集只读（激活/回滚/阴影不在合法性页操作） */
  listRuleSets: () => apiRequestTimed('/rule-sets'),
  listRuleVersions: code => apiRequestTimed(`/rule-sets/${encode(code)}/versions`),
  getRuleVersion: id => apiRequestTimed(`/rule-set-versions/${encode(id)}`),
  listRuleRuns: params => apiRequestTimed(`/rule-runs${buildQuery(params)}`),

  /* 阶段 7：规则效果 */
  ruleEffectsSummary: params => apiRequestTimed(`/rule-effects/summary${buildQuery(params)}`),
  ruleEffectsFacts: params => apiRequestTimed(`/rule-effects/facts${buildQuery(params)}`)
};
