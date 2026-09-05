import { apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  });
  return search.toString() ? `?${search}` : '';
}

// 只读取后端已经保存的研判，不包含重算、人工改判或把空结果补成“合法”的前端规则。
export const legalityApi = {
  history: (planId, params) => apiRequest(`/flight-plans/${encodeURIComponent(planId)}/legality-assessments${query(params)}`),
  detail: assessmentId => apiRequest(`/legality-assessments/${encodeURIComponent(assessmentId)}`)
};
