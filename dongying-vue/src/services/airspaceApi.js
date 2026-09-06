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
  conflicts: planId => apiRequest(`/flight-plans/${encodeURIComponent(planId)}/airspace-conflicts`)
};
