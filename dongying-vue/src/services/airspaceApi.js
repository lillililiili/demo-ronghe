import { apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  });
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

// 冲突接口返回服务端计算的水平/高度/时间关系事实，不宣判合法性，也不等同已保存研判；失败不回退演示 Mock。
export const airspaceApi = {
  list: params => apiRequest(`/airspaces${query(params)}`),
  detail: id => apiRequest(`/airspaces/${encodeURIComponent(id)}`),
  versions: (id, params) => apiRequest(`/airspaces/${encodeURIComponent(id)}/versions${query(params)}`),
  version: id => apiRequest(`/airspace-versions/${encodeURIComponent(id)}`),
  conflicts: planId => apiRequest(`/flight-plans/${encodeURIComponent(planId)}/airspace-conflicts`),
  // 阶段 9 写入：新建空域、接替式追加版本、版本差异、GeoJSON 导入（暂存 → 确认/放弃）。
  create: (body, idempotencyKey) => apiRequest('/airspaces', { method: 'POST', body, mutation: true, idempotencyKey }),
  addVersion: (id, body, idempotencyKey) =>
    apiRequest(`/airspaces/${encodeURIComponent(id)}/versions`, { method: 'POST', body, mutation: true, idempotencyKey }),
  diff: (id, fromVersionId, toVersionId) =>
    apiRequest(`/airspaces/${encodeURIComponent(id)}/versions/${encodeURIComponent(fromVersionId)}/diff/${encodeURIComponent(toVersionId)}`),
  stageImport: (body, idempotencyKey) =>
    apiRequest('/airspaces/import-batches', { method: 'POST', body, mutation: true, idempotencyKey }),
  importBatch: batchId => apiRequest(`/airspaces/import-batches/${encodeURIComponent(batchId)}`),
  confirmImport: (batchId, body, idempotencyKey) =>
    apiRequest(`/airspaces/import-batches/${encodeURIComponent(batchId)}/confirm`, { method: 'POST', body, mutation: true, idempotencyKey }),
  discardImport: (batchId, body, idempotencyKey) =>
    apiRequest(`/airspaces/import-batches/${encodeURIComponent(batchId)}/discard`, { method: 'POST', body, mutation: true, idempotencyKey })
};
