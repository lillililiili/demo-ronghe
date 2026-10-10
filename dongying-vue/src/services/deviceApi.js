import { apiRequest, apiRequestTimed } from './apiClient.js';

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
  onboard: (body, key = newIdempotencyKey('onboard')) => apiRequest('/devices/onboard', { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
  update: (id, body, key = newIdempotencyKey('device-update')) => apiRequest(`/devices/${id}`, { method: 'PUT', body, headers: { 'Idempotency-Key': key } }),
  setEnabled: (id, body, key = newIdempotencyKey('device-enabled')) => apiRequest(`/devices/${id}/enabled`, { method: 'PATCH', body, headers: { 'Idempotency-Key': key } }),
  saveSensingProfile: (id, body, key = newIdempotencyKey('sensing-profile')) => apiRequest(`/devices/${encodeURIComponent(id)}/sensing-profile`, {
    method: 'PUT', body, mutation: true, idempotencyKey: key
  }),
  deleteSensingProfile: (id, expectedVersion, key = newIdempotencyKey('sensing-profile-delete')) => apiRequest(`/devices/${encodeURIComponent(id)}/sensing-profile`, {
    method: 'DELETE', body: { expected_version: expectedVersion }, mutation: true, idempotencyKey: key
  }),
  overview: params => apiRequest(`/device-monitor/overview${query(params)}`),
  tree: params => apiRequest(`/device-monitor/tree${query(params)}`),
  state: id => apiRequest(`/devices/${id}/state`),
  history: (id, params) => apiRequest(`/devices/${id}/state-history${query(params)}`),
  incidents: params => apiRequest(`/device-incidents${query(params)}`),
  incident: id => apiRequest(`/device-incidents/${id}`),
  rebootIncident: (id, reason, idempotencyKey) => apiRequest(`/device-incidents/${id}/reboot`, {
    method: 'POST', body: { reason }, headers: { 'Idempotency-Key': idempotencyKey }
  }),
  checkIncidentRecovery: (id, idempotencyKey) => apiRequest(`/device-incidents/${id}/recovery-checks`, {
    method: 'POST', body: {}, headers: { 'Idempotency-Key': idempotencyKey }
  }),
  events: params => apiRequest(`/device-events${query(params)}`),
  reboot: (id, reason, idempotencyKey) => apiRequest(`/devices/${id}/commands/reboot`, {
    method: 'POST', body: { reason }, headers: { 'Idempotency-Key': idempotencyKey }
  }),
  command: (id, options = {}) => apiRequest(`/device-commands/${id}`, options),
  protocolStatus: id => apiRequest(`/devices/${id}/protocol-status`),
  targets: params => apiRequest(`/sensing/targets${query(params)}`),
  targetTrack: (id, params) => apiRequest(`/sensing/targets/${id}/track${query(params)}`),
  beginEoTrack: (targetId, body = {}, key = newIdempotencyKey('eo-track')) =>
    apiRequest(`/targets/${targetId}/eo-tracking-tasks`, {
      method: 'POST', body, headers: { 'Idempotency-Key': key }
    }),
  eoTrackingStatus: (targetId, options = {}) => apiRequest(`/targets/${encodeURIComponent(targetId)}/eo-tracking-status`, options),
  pauseEoTracking: (targetId, key = newIdempotencyKey('eo-track-pause')) =>
    apiRequest(`/targets/${encodeURIComponent(targetId)}/eo-tracking-pause`, {
      method: 'POST', body: {}, headers: { 'Idempotency-Key': key }
    }),
  resumeEoTracking: (targetId, key = newIdempotencyKey('eo-track-resume')) =>
    apiRequest(`/targets/${encodeURIComponent(targetId)}/eo-tracking-resume`, {
      method: 'POST', body: {}, headers: { 'Idempotency-Key': key }
    }),
  targetVideo: (targetId, options = {}) => apiRequest(`/targets/${encodeURIComponent(targetId)}/video`, options),
  /* 跟踪画面截图（EO_STILL）或录像（EO_VIDEO）存为证据；设备与任务由服务端按当前跟踪任务核定。
     取证时刻只报“距截图或开始录像过了多少毫秒”，由服务端换算，不依赖本机时钟。
     上传可能较慢，超时属于“结果未知”，调用方保留同一幂等键重试。 */
  captureTargetVideo: (targetId, { file, kindCode, streamId, eventId, captureAgeMs }, key = newIdempotencyKey('eo-capture')) => {
    const body = new FormData();
    body.append('file', file);
    body.append('kind_code', kindCode);
    body.append('stream_id', streamId);
    if (eventId) body.append('event_id', eventId);
    if (captureAgeMs != null) body.append('capture_age_ms', String(Math.max(0, Math.round(captureAgeMs))));
    return apiRequestTimed(`/targets/${encodeURIComponent(targetId)}/video/captures`, {
      method: 'POST', body, mutation: true, idempotencyKey: key
    }, 60_000);
  },
  currentEoTrack: (targetId, options = {}) => apiRequest(`/targets/${targetId}/eo-tracking-tasks`, options),
  eoTrackAvailability: targetId => apiRequest(`/targets/${targetId}/eo-tracking-availability`),
  endEoTrack: (taskId, key = newIdempotencyKey('eo-track-end')) =>
    apiRequest(`/eo-tracking-tasks/${taskId}/end`, {
      method: 'POST', body: {}, headers: { 'Idempotency-Key': key }
    })
};

export const mqttApi = {
  list: () => apiRequest('/mqtt-brokers'),
  options: () => apiRequest('/devices/mqtt-options'),
  scopes: () => apiRequest('/mqtt-brokers/scopes'),
  create: (body, key) => apiRequest('/mqtt-brokers', { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
  update: (id, body, key) => apiRequest(`/mqtt-brokers/${id}`, { method: 'PUT', body, headers: { 'Idempotency-Key': key } }),
  setEnabled: (id, body, key) => apiRequest(`/mqtt-brokers/${id}/enabled`, { method: 'PATCH', body, headers: { 'Idempotency-Key': key } })
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
