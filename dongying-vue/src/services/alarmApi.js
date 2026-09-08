import { apiBinary, apiRequestTimed, buildQuery } from '@/services/apiClient.js';

// 只经 apiRequestTimed 访问服务端：超时统一抛 TIMEOUT/408，页面按“结果未知”回读，绝不回退 window.MOCK 伪造核实成功。
export const listAlarms = values => apiRequestTimed(`/alarms${buildQuery(values)}`);
/* 导出走 apiBinary：除 blob 外还解析服务端的 Content-Disposition 文件名——
   文件名由服务端定，前端另造一个既会与服务端不一致，也会引入第二个"当前时刻"。
   筛选与排序与列表同参；上限 5000 行由服务端判。 */
export const exportAlarmsCsv = values => apiBinary(`/alarms/export.csv${buildQuery(values)}`);
/* 区域字典按页取（15-22）：/districts 是系统管理的全量字典，告警页要的是本页数据可见范围内的区域。
   服务端未就绪时会回 404，页面据此显示"不可用"，不静默改读别的接口。 */
export const listAlarmDistricts = () => apiRequestTimed('/alarms/districts');
export const getAlarm = alarmId => apiRequestTimed(`/alarms/${encodeURIComponent(alarmId)}`);
export const getUavEvent = eventId => apiRequestTimed(`/uav-events/${encodeURIComponent(eventId)}`);
export const listUavVerifications = (eventId, values) => apiRequestTimed(`/uav-events/${encodeURIComponent(eventId)}/verifications${buildQuery(values)}`);
export const verifyUavEvent = (eventId, body, idempotencyKey) => apiRequestTimed(`/uav-events/${encodeURIComponent(eventId)}/verifications`, {
  method: 'POST', body, mutation: true, idempotencyKey
});
