import { coverageContainsPoint, coverageSummary } from '../../services/situationData.js';

const validPosition = p => p && p.posValid !== false && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
  && Number.isFinite(p.lat) && Math.abs(p.lat) <= 85.051129;
const radians = Math.PI / 180;

function destination(device, meters, bearing) {
  const angle = meters / 6371000, azimuth = bearing * radians, lat = device.lat * radians;
  const latitude = Math.asin(Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(azimuth));
  const longitude = device.lon * radians + Math.atan2(Math.sin(azimuth) * Math.sin(angle) * Math.cos(lat),
    Math.cos(angle) - Math.sin(lat) * Math.sin(latitude));
  return [longitude / radians, latitude / radians];
}

/** 地图查看范围，只使用台账配置；离线时仍可参照范围，不宣称光电正在探测。 */
export function eoCoverageView(device, targets = []) {
  const empty = reason => ({ coordinates: [], targets: [], reason, notice: '', summary: '范围无法确认' });
  if (!validPosition(device)) return empty('未取得本机有效位置，无法显示覆盖范围');
  const c = device.coverage;
  const radius = c?.kind === 'circle' ? c.radiusM : c?.rangeM;
  if (!c || c.status === 'unknown' || !['circle', 'sector'].includes(c.kind) || !Number.isFinite(radius) || radius <= 0
    || (c.kind === 'sector' && (!Number.isFinite(c.azimuthDeg) || !Number.isFinite(c.fovDeg) || c.fovDeg <= 0 || c.fovDeg > 360))) {
    return empty('本机覆盖参数未知，无法确定范围内的无人机');
  }
  const span = c.kind === 'circle' ? 360 : c.fovDeg;
  const start = c.kind === 'circle' ? 0 : c.azimuthDeg - span / 2;
  const steps = Math.ceil(span / 3);
  const coordinates = span < 360 ? [[device.lon, device.lat]] : [];
  for (let i = 0; i <= steps; i++) coordinates.push(destination(device, radius, start + span * i / steps));
  // 在线性展示筛选中复用平台范围算法；设备不可用不会抹去配置，也不会授予任何操作资格。
  const geometry = { ...device, coverage: { ...c, status: 'available' } };
  return {
    coordinates,
    targets: targets.filter(t => t.objectTypeCode === 'UAV' && validPosition(t)
      && ((t.lon === device.lon && t.lat === device.lat) || coverageContainsPoint(geometry, t))),
    reason: '', summary: coverageSummary(c),
    notice: c.status === 'unavailable' ? '光电当前不可用，按配置范围显示其他感知来源的当前目标' : ''
  };
}

export function drawEoCoverageMask(view, coordinates) {
  const c = view.ctx;
  c.save();
  c.beginPath(); c.rect(0, 0, view.w, view.h);
  coordinates.forEach((point, i) => { const p = view.px(...point); i ? c.lineTo(...p) : c.moveTo(...p); });
  if (coordinates.length) c.closePath();
  c.fillStyle = 'rgba(4, 12, 26, .66)'; c.fill('evenodd');
  c.restore();
}
