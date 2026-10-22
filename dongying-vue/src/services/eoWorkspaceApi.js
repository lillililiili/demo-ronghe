import { apiRequest, apiRequestTimed } from './apiClient.js';
const batch = (action, items) => apiRequestTimed(`/uav-events/batch/${action}`, {
  method: 'POST', body: { items }, mutation: action !== 'precheck'
});
export const eoWorkspaceApi = {
  video: (deviceId, options = {}) => apiRequest(`/devices/${encodeURIComponent(deviceId)}/video`, options),
  precheck: eventIds => batch('precheck', eventIds.map(event_id => ({ event_id }))),
  verify: items => batch('verify', items),
  counter: items => batch('counter', items)
};
