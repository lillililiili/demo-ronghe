/* 设备（TDOA / AOA / DCD / RID）测算的遥控器（飞手）大概位置，2026-10-04 用户确认用于找飞手。
   这只是设备推算的位置，不是现场核实的位置，页面一律注明；没有位置时写“没有遥控器位置”。 */
export const NO_PILOT_LOCATION = '没有遥控器位置';
export const PILOT_LOCATION_NOTE = '设备测算的大概位置';
/** 告警的目标已不在地图上时，页面手里没有它的遥控器位置，不能写成“没有”。 */
export const PILOT_LOCATION_IN_ALARM_DETAIL = '目标已不在地图上，请在告警详情里查看';

function coordinate(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 接口的 { longitude, latitude } → { lon, lat }；任一缺失或越界即视为没有位置。 */
export function pilotPoint(location) {
  const lon = coordinate(location?.longitude), lat = coordinate(location?.latitude);
  if (lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

export function pilotLocationText(location) {
  const point = pilotPoint(location);
  return point ? `${point.lon.toFixed(6)}, ${point.lat.toFixed(6)}（${PILOT_LOCATION_NOTE}）` : NO_PILOT_LOCATION;
}
