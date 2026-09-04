import { apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) search.set(key, String(value));
  });
  const value = search.toString();
  return value ? `?${value}` : '';
}

export const deviceApi = {
  list: params => apiRequest(`/devices${query(params)}`),
  options: () => apiRequest('/devices/options'),
  detail: id => apiRequest(`/devices/${id}`),
  create: body => apiRequest('/devices', { method: 'POST', body }),
  onboard: body => apiRequest('/devices/onboard', { method: 'POST', body }),
  update: (id, body) => apiRequest(`/devices/${id}`, { method: 'PUT', body }),
  setEnabled: (id, body) => apiRequest(`/devices/${id}/enabled`, { method: 'PATCH', body }),
  overview: () => apiRequest('/device-monitor/overview'),
  tree: params => apiRequest(`/device-monitor/tree${query(params)}`),
  state: id => apiRequest(`/devices/${id}/state`),
  history: (id, params) => apiRequest(`/devices/${id}/state-history${query(params)}`),
  incidents: params => apiRequest(`/device-incidents${query(params)}`),
  events: params => apiRequest(`/device-events${query(params)}`),
  reboot: (id, reason, idempotencyKey) => apiRequest(`/devices/${id}/commands/reboot`, {
    method: 'POST', body: { reason }, headers: { 'Idempotency-Key': idempotencyKey }
  }),
  command: id => apiRequest(`/device-commands/${id}`),
  protocolStatus: id => apiRequest(`/devices/${id}/protocol-status`),
  targets: params => apiRequest(`/sensing/targets${query(params)}`),
  targetTrack: (id, params) => apiRequest(`/sensing/targets/${id}/track${query(params)}`)
};

export const integrationApi = {
  protocols: () => apiRequest('/device-protocols'),
  sources: params => apiRequest(`/integration-sources${query(params)}`),
  source: id => apiRequest(`/integration-sources/${id}`),
  createSource: body => apiRequest('/integration-sources', { method: 'POST', body }),
  updateSource: (id, body) => apiRequest(`/integration-sources/${id}`, { method: 'PUT', body }),
  setSourceEnabled: (id, body) => apiRequest(`/integration-sources/${id}/enabled`, { method: 'PATCH', body })
};

export const commissionApi = {
  list: params => apiRequest(`/commission-tasks${query(params)}`),
  get: id => apiRequest(`/commission-tasks/${id}`),
  create: body => apiRequest('/commission-tasks', { method: 'POST', body }),
  connect: (id, version) => apiRequest(`/commission-tasks/${id}/connect`, { method: 'POST', body: { version } }),
  configure: (id, body) => apiRequest(`/commission-tasks/${id}/configuration`, { method: 'PUT', body }),
  start: (id, version) => apiRequest(`/commission-tasks/${id}/start`, { method: 'POST', body: { version } }),
  cancel: (id, version) => apiRequest(`/commission-tasks/${id}/cancel`, { method: 'POST', body: { version } }),
  events: (id, params) => apiRequest(`/commission-tasks/${id}/events${query(params)}`),
  report: id => apiRequest(`/commission-tasks/${id}/report`)
};

export function newIdempotencyKey(prefix = 'request') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
