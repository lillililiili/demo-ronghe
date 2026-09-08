import { apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  });
  const value = search.toString();
  return value ? `?${value}` : '';
}

const id = value => encodeURIComponent(String(value));

async function allPages(loadPage, params = {}) {
  const size = Math.max(1, Math.min(100, Number(params.size) || 100));
  const common = { ...params, size };
  const items = [];
  let pageNumber = 1;
  let total = 0;
  let first = null;
  do {
    const page = await loadPage({ ...common, page: pageNumber });
    if (!first) first = page || {};
    const batch = Array.isArray(page?.items) ? page.items : [];
    items.push(...batch);
    total = Math.max(0, Number(page?.total) || 0);
    if (!batch.length || items.length >= total) break;
    pageNumber += 1;
  } while (true);
  return { ...(first || {}), items, page: 1, size, total };
}

export const targetApi = {
  list: params => apiRequest(`/targets${query(params)}`),
  detail: targetId => apiRequest(`/targets/${id(targetId)}`),
  tracks: (targetId, params) => apiRequest(`/targets/${id(targetId)}/tracks${query(params)}`),
  points: (trackId, params) => apiRequest(`/tracks/${id(trackId)}/points${query(params)}`),
  listAll(params) {
    return allPages(page => this.list(page), params);
  },
  tracksAll(targetId, params) {
    return allPages(page => this.tracks(targetId, page), params);
  },
  pointsAll(trackId, params) {
    return allPages(page => this.points(trackId, page), params);
  },
  /* 融合来源在线态：融合感知页用它把目标详情里的来源标成在线/离线。 */
  fusionStatus: () => apiRequest('/fusion/status')
};
