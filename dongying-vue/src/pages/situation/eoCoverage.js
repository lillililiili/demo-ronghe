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

function sectorCoordinates(device, radius, azimuth, fov) {
  const steps = Math.max(2, Math.ceil(fov / 3));
  const coordinates = [[device.lon, device.lat]];
  for (let i = 0; i <= steps; i++) coordinates.push(destination(device, radius, azimuth - fov / 2 + fov * i / steps));
  return coordinates;
}

function liveViewCoordinates(device, range, now) {
  const view = device.eoView;
  if (device.typeCode !== 'EO' || device.status !== '在线' || !view?.available
    || !Number.isFinite(view.validUntil) || view.validUntil <= now
    || !Number.isFinite(view.azimuth) || !Number.isFinite(view.fov) || view.fov <= 0 || view.fov > 180
    || !Number.isFinite(range) || range <= 0) return [];
  return sectorCoordinates(device, range, view.azimuth, view.fov);
}

/** 地图查看范围，只使用台账配置；离线时仍可参照范围，不宣称光电正在探测。 */
export function eoCoverageView(device, targets = [], now = Date.now()) {
  const empty = reason => ({ coordinates: [], viewCoordinates: [], targets: [], reason, notice: '', summary: '范围无法确认' });
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
  const viewCoordinates = liveViewCoordinates(device, radius, now);
  // 在线性展示筛选中复用平台范围算法；设备不可用不会抹去配置，也不会授予任何操作资格。
  const geometry = { ...device, coverage: { ...c, status: 'available' } };
  return {
    coordinates, viewCoordinates,
    targets: targets.filter(t => t.objectTypeCode === 'UAV' && validPosition(t)
      && ((t.lon === device.lon && t.lat === device.lat) || coverageContainsPoint(geometry, t))),
    reason: '', summary: `可转向覆盖 · ${coverageSummary(c)}`,
    notice: c.status === 'unavailable' ? '光电当前不可用，按配置范围显示其他感知来源的当前目标' : ''
  };
}

/** 取景只包住设备与当前目标；近距离保留周边空间，避免点位重合时放大到极限。 */
export function eoMapFraming(device, coverageView) {
  if (!validPosition(device) || !coverageView?.coordinates?.length) return { coordinates: [], padding: .24 };
  const targets = (coverageView.targets || []).filter(validPosition);
  if (!targets.length) return { coordinates: coverageView.coordinates, padding: .17 };
  return {
    coordinates: [
      [device.lon, device.lat],
      ...targets.map(target => [target.lon, target.lat]),
      // 仅作为相机取景余量，不用于设备覆盖、目标位置或业务判定。
      ...[0, 90, 180, 270].map(bearing => destination(device, 75, bearing))
    ],
    padding: .24
  };
}

/** Distinguish a confirmed empty coverage area from equipment or data that cannot be checked. */
export function eoCoveragePresentation({
  device, view, devicesUnavailable = false, targetsUnavailable = false, selectedCount = 0
} = {}) {
  const selectedNote = selectedCount > 0
    ? '已选告警仍保留，待观测和关联状态更新后可继续处理。'
    : '';
  const unknown = (coverageLabel, emptyMessage) => ({ coverageLabel, emptyMessage: `${emptyMessage}${selectedNote}` });

  if (devicesUnavailable) {
    return unknown('设备状态未知', '设备状态读取失败，无法确认光电覆盖范围内是否有无人机。');
  }
  if (targetsUnavailable) {
    return unknown('目标状态未知', '目标数据读取失败，无法确认光电覆盖范围内是否有无人机。');
  }
  if (!device) {
    return unknown('设备状态未知', '未取得当前光电设备信息，无法确认覆盖范围内是否有无人机。');
  }
  if (device.status !== '在线') {
    return unknown('当前视场未确认', `光电当前${device.status || '状态未知'}，无法确认镜头视场内是否有无人机。`);
  }
  if (view?.reason) {
    return unknown('范围未知', `${view.reason}。`);
  }

  const count = Array.isArray(view?.targets) ? view.targets.length : null;
  if (count === null) {
    return unknown('目标状态未知', '目标数据尚未就绪，无法确认光电覆盖范围内是否有无人机。');
  }
  if (count === 0) {
    return {
      coverageLabel: '0 架无人机',
      emptyMessage: `当前融合感知数据中，光电配置覆盖范围内暂无有效位置的无人机。${selectedNote}`
    };
  }
  return { coverageLabel: `${count} 架无人机`, emptyMessage: '' };
}

export function drawEoCoverageMask(view, coordinates = []) {
  const c = view.ctx;
  c.save();
  c.beginPath(); c.rect(0, 0, view.w, view.h);
  coordinates.forEach((point, i) => { const p = view.px(...point); i ? c.lineTo(...p) : c.moveTo(...p); });
  if (coordinates.length) c.closePath();
  c.fillStyle = 'rgba(4, 12, 26, .66)'; c.fill('evenodd');
  c.restore();
}
