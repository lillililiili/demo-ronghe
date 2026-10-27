/* 航班避让：反制设备附近有没有民航航班。数据来自后台登记的 ADS-B 航班接收机。 */
import { apiRequestTimed, buildQuery } from './apiClient.js';

export const flightAvoidanceApi = {
  /* 反制弹窗：所选设备、所选反制方式下附近航班的情况。level：OFF / CLEAR / WARN / NO_DATA / BLOCK */
  check: (deviceId, countermeasureMode) => apiRequestTimed(`/flight-avoidance/check${buildQuery({ device_id: deviceId, countermeasure_mode: countermeasureMode })}`),
  /* 地图「民航航班」图层：接收机、最近收到的航班、范围圈的规则 */
  traffic: () => apiRequestTimed('/flight-avoidance/traffic'),
  /* 告警详情：这起告警反制前、反制中的航班检查记录 */
  checks: eventId => apiRequestTimed(`/flight-avoidance/checks${buildQuery({ event_id: eventId })}`)
};
