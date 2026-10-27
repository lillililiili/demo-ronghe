import { apiRequest, apiRequestTimed } from './apiClient.js';
const batch = (action, items) => apiRequestTimed(`/uav-events/batch/${action}`, {
  method: 'POST', body: { items }, mutation: action !== 'precheck'
});
export const eoWorkspaceApi = {
  video: (deviceId, options = {}) => apiRequest(`/devices/${encodeURIComponent(deviceId)}/video`, options),
  precheck: entries => batch('precheck', entries.map(row => typeof row==='string'?{event_id:row}:{event_id:row.eventId,...(row.riskCaseId?{risk_case_id:row.riskCaseId,expected_case_version:row.riskCaseVersion}:{})})),
  verify: items => batch('verify', items),
  counter: items => batch('counter', items)
};
