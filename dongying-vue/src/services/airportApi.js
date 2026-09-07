import { apiRequestTimed, buildQuery } from './apiClient.js';

/* 机场基础数据：只读与只增，没有修改与删除方法。失败由页面显示，绝不回退 window.MOCK。 */
export const airportApi = {
  listAirports: params => apiRequestTimed(`/airports${buildQuery(params)}`),
  getAirport: airportId => apiRequestTimed(`/airports/${encodeURIComponent(airportId)}`),
  createAirport: (body, idempotencyKey) => apiRequestTimed('/airports', { method: 'POST', body, mutation: true, idempotencyKey }),
  addRunway: (airportId, body, idempotencyKey) => apiRequestTimed(`/airports/${encodeURIComponent(airportId)}/runways`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  addProcedureRoute: (airportId, body, idempotencyKey) => apiRequestTimed(`/airports/${encodeURIComponent(airportId)}/procedure-routes`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  addProtectedTarget: (airportId, body, idempotencyKey) => apiRequestTimed(`/airports/${encodeURIComponent(airportId)}/protected-targets`, {
    method: 'POST', body, mutation: true, idempotencyKey
  }),
  addNotificationTarget: (airportId, body, idempotencyKey) => apiRequestTimed(`/airports/${encodeURIComponent(airportId)}/notification-targets`, {
    method: 'POST', body, mutation: true, idempotencyKey
  })
};
