import { apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  });
  const value = search.toString();
  return value ? `?${value}` : '';
}

export const flightApi = {
  list: params => apiRequest(`/flight-plans${query(params)}`),
  detail: id => apiRequest(`/flight-plans/${encodeURIComponent(id)}`),
  routes: params => apiRequest(`/routes${query(params)}`),
  route: id => apiRequest(`/routes/${encodeURIComponent(id)}`),
  routeVersions: (id, params) => apiRequest(`/routes/${encodeURIComponent(id)}/versions${query(params)}`),
  routeVersion: id => apiRequest(`/route-versions/${encodeURIComponent(id)}`),
  conflicts: id => apiRequest(`/flight-plans/${encodeURIComponent(id)}/airspace-conflicts`),
  // 阶段 9：对照聚合各段自带 availability（缺权限的段不带任何数量）。
  actuals: id => apiRequest(`/flight-plans/${encodeURIComponent(id)}/actuals`)
};

// 后端分页才是计划真源；全量读取也必须逐页请求，不能回退到 window.MOCK 补齐数据。
export async function listAllFlightPlans(params = {}) {
  const items = [];
  let page = 1;
  let total = 0;
  do {
    const response = await flightApi.list({ ...params, page, size: 100 });
    total = response.total;
    items.push(...response.items);
    page += 1;
  } while (items.length < total);
  return items;
}
