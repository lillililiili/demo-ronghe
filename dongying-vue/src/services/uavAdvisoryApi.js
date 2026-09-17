import { apiRequestTimed } from './apiClient.js';

const base = eventId => `/uav-events/${encodeURIComponent(eventId)}/advisory`;
export const uavAdvisoryApi = {
  get: eventId => apiRequestTimed(base(eventId)),
  act: (eventId, body, idempotencyKey) => apiRequestTimed(`${base(eventId)}/actions`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  retrySms: (eventId, body, idempotencyKey) => apiRequestTimed(`${base(eventId)}/auto-sms/retry`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  retryVoice: (eventId, body, idempotencyKey) => apiRequestTimed(`${base(eventId)}/auto-voice/retry`, {
    method: 'POST', body, mutation: true, idempotencyKey
  })
};
