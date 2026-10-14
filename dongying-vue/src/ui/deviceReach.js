/* 反制设备能不能照到目标（2026-10-14 rose：选设备时只显示覆盖范围内的反制设备）。
   用设备台账里的扫描半径、射程、朝向和张角，和飞行任务设备检查同一套几何；
   缺坐标、缺覆盖参数都不算覆盖到。正式提交时后台复查放到验收后的第二步。 */
import { coverageContainsPoint, distanceMeters, normalizeCoverage } from '../services/situationData.js';

const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));

export function validPoint(point) {
  return !!point && finite(point.lon) && finite(point.lat) && Math.abs(point.lon) <= 180 && Math.abs(point.lat) <= 90;
}

/** @returns {{ inRange: boolean, distanceM: number|null, reason: string }} */
export function deviceReach(device, point) {
  if (!validPoint(point)) return { inRange: false, distanceM: null, reason: '没有目标位置' };
  if (!finite(device?.longitude) || !finite(device?.latitude)) return { inRange: false, distanceM: null, reason: '设备没有安装坐标' };
  const lon = Number(device.longitude), lat = Number(device.latitude);
  const distanceM = distanceMeters(lon, lat, Number(point.lon), Number(point.lat));
  // 在线与否另由 deviceUnavailableReason 判断；这里只看几何，所以按“可用”归一化。
  const coverage = normalizeCoverage(device.coverage ? { ...device.coverage, status: 'available' } : null, true);
  if (coverage.status !== 'available') return { inRange: false, distanceM, reason: '没有配置覆盖范围' };
  const inRange = coverageContainsPoint({ lon, lat, coverage }, { lon: Number(point.lon), lat: Number(point.lat) });
  const reach = coverage.radiusM ?? coverage.rangeM;
  return { inRange, distanceM, reason: inRange ? '' : `超出覆盖（${distanceText(reach)}）` };
}

export function distanceText(meters) {
  if (!Number.isFinite(meters)) return '距离未知';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}
