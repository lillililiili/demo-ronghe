import { apiRequestTimed } from './apiClient.js';

const one = eventId => `/uav-events/${encodeURIComponent(eventId)}/no-counter-decision`;
export const noCounterApi = {
  get: eventId => apiRequestTimed(one(eventId)),
  decide: (eventId, body, idempotencyKey) => apiRequestTimed(one(eventId), {
    method: 'POST', body, mutation: true, idempotencyKey
  })
};
