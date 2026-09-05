import { apiRequestTimed, buildQuery } from '@/services/apiClient.js';

// 只经 apiRequestTimed 访问服务端：超时统一抛 TIMEOUT/408，页面按“结果未知”回读，绝不回退 window.MOCK 伪造核实成功。
export const listAlarms = values => apiRequestTimed(`/alarms${buildQuery(values)}`);
export const getAlarm = alarmId => apiRequestTimed(`/alarms/${encodeURIComponent(alarmId)}`);
export const getUavEvent = eventId => apiRequestTimed(`/uav-events/${encodeURIComponent(eventId)}`);
export const listUavVerifications = (eventId, values) => apiRequestTimed(`/uav-events/${encodeURIComponent(eventId)}/verifications${buildQuery(values)}`);
export const verifyUavEvent = (eventId, body, idempotencyKey) => apiRequestTimed(`/uav-events/${encodeURIComponent(eventId)}/verifications`, {
  method: 'POST', body, mutation: true, idempotencyKey
});
