/* 事项位置的共享取数（决策 15-54）：把工作台、飞行计划页要画的点位统一从已有读接口取出来，
   转成 MapView 能画的对象。规则与告警页一致：只画可信 WGS-84 坐标，缺坐标就明说，不以 (0,0) 补位。
   - 感知目标：/targets/{id} 的 latest_state.location 作锚点；/targets/{id}/tracks 最新一条轨迹的点位作轨迹。
   - 航线：/route-versions/{id} 的 centerline（LineString，WGS84）。
   - 设备：/devices/{id} 的 longitude/latitude。 */
import { targetApi } from './targetApi.js';
import { deviceApi } from './deviceApi.js';
import { flightApi } from './flightApi.js';
import { airspaceApi } from './airspaceApi.js';
import { targetTypeLabel } from '@/ui/labels.js';

/** GeoJSON 点 → {lon, lat}；坐标系不是 WGS84、被标为不可信或越界时返回 null。 */
export function coordOf(loc, issues, field) {
  if (!loc || loc.coordinate_system !== 'WGS84') return null;
  if (field && Array.isArray(issues) && issues.some(i => i && i.field === field)) return null;
  const lon = Number(loc.longitude), lat = Number(loc.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

/** 航线版本中心线 → [[lon, lat], …]；不可信时 null。 */
export function trustedCenterline(version) {
  const line = version?.centerline;
  if (line?.type !== 'LineString' || line?.coordinate_system !== 'WGS84'
    || version?.field_issues?.some(issue => issue.field === 'centerline') || !Array.isArray(line.coordinates)) return null;
  const coordinates = line.coordinates.map(point => [Number(point?.[0]), Number(point?.[1])]);
  return coordinates.length > 1 && coordinates.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)) ? coordinates : null;
}

/** 目标位置与轨迹；legal 是给标记着色用的合法性文案（不知道就传 '—'）。 */
export async function loadTargetPosition(targetId, { legal = '—', risk = '—' } = {}) {
  const target = await targetApi.detail(targetId);
  const ls = target?.latest_state;
  const pos = ls ? coordOf(ls.location, ls.field_issues, 'location') : null;
  let points = [];
  let trackError = '';
  try {
    const tracks = await targetApi.tracks(targetId, { page: 1, size: 1 });
    const track = tracks?.items?.[0];
    if (track) {
      let page = await targetApi.points(track.track_id, { page: 1, size: 100 });
      const total = Number(page?.total || 0);
      if (total > 100) page = await targetApi.points(track.track_id, { page: Math.ceil(total / 100), size: 100 });
      points = (page?.items || []).map(p => {
        const c = coordOf(p.location);
        return c ? { lon: c.lon, lat: c.lat, alt: p.altitude_amsl_m == null ? null : Number(p.altitude_amsl_m), t: p.sort_time, kind: 'meas' } : null;
      }).filter(Boolean);
    }
  } catch (error) { trackError = error?.message || '轨迹读取失败'; }
  const anchor = pos || (points.length ? points[points.length - 1] : null);
  if (!anchor) return { target, anchor: null, mapTarget: null, points, trackError };
  const mapTarget = {
    id: target.target_no || target.target_id, lon: anchor.lon, lat: anchor.lat,
    alt: ls?.altitude_amsl_m == null ? null : Number(ls.altitude_amsl_m),
    speed: ls?.speed_mps == null ? null : Number(ls.speed_mps),
    heading: ls?.heading_deg == null ? 0 : Number(ls.heading_deg),
    type: targetTypeLabel(null, target.object_type_code, '目标'), subtype: targetTypeLabel(target.subtype, target.object_type_code, '目标'),
    legal, risk, tracked: true, track: points.length > 1 ? points : []
  };
  return { target, anchor, mapTarget, points, trackError };
}

/** 设备点位；台账没有坐标时 mapDevice 为 null。 */
export async function loadDevicePosition(deviceId) {
  // /devices/{id} 的坐标在顶层，台账字段（编号、名称、类型、连接状态）在 detail.device 里。
  const detail = await deviceApi.detail(deviceId);
  const device = detail?.device || detail || {};
  const lon = Number(detail?.longitude ?? device.longitude), lat = Number(detail?.latitude ?? device.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) return { device, mapDevice: null };
  const connectivity = device.connectivity || detail?.latest_state?.connectivity;
  return {
    device,
    mapDevice: {
      id: device.device_no || device.device_id || deviceId, name: device.name || device.device_no || '设备', lon, lat,
      type: device.device_type_name || device.device_type_code || '设备', channel: device.channel || '—',
      status: connectivity === 'ONLINE' ? '在线' : connectivity === 'OFFLINE' ? '离线' : '异常', alarm: false
    }
  };
}

export async function loadRouteCenterline(routeVersionId) {
  return trustedCenterline(await flightApi.routeVersion(routeVersionId));
}

/** 在 MapView 的 draw 之后补画一条中心线（青色）。 */
export function installCenterline(map, coordinates) {
  if (!map || !coordinates) return;
  const drawBase = map.draw.bind(map);
  map.draw = function drawWithCenterline() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    context.save();
    context.beginPath();
    coordinates.forEach(([lon, lat], index) => {
      const point = this.px(lon, lat);
      if (index) context.lineTo(point[0], point[1]);
      else context.moveTo(point[0], point[1]);
    });
    context.strokeStyle = '#22d3ee';
    context.lineWidth = 2.4;
    context.lineJoin = 'round';
    context.stroke();
    context.restore();
  };
}

export function centerOf(coordinates) {
  return coordinates?.[Math.floor(coordinates.length / 2)] || null;
}

/** 计划涉及的空域边界（MultiPolygon，WGS84）→ 可画的多边形组；读不到或几何不可信的空域直接跳过。 */
export async function loadAirspaceOverlays(planId) {
  if (!planId) return [];
  const facts = await flightApi.conflicts(planId);
  const versionIds = [...new Set((facts || []).map(fact => fact.airspace_version_id).filter(Boolean))];
  const versions = await Promise.all(versionIds.map(id => airspaceApi.version(id).catch(() => null)));
  const byVersion = new Map(versions.filter(Boolean).map(version => [version.airspace_version_id, version]));
  return (facts || []).flatMap(conflict => {
    const version = byVersion.get(conflict.airspace_version_id);
    const boundary = version?.boundary;
    if (boundary?.type !== 'MultiPolygon' || boundary.coordinate_system !== 'WGS84'
      || version.field_issues?.some(issue => issue.field === 'boundary') || !Array.isArray(boundary.coordinates)) return [];
    const polygons = boundary.coordinates.map(polygon => polygon.map(ring => ring.map(point => [Number(point?.[0]), Number(point?.[1])])))
      .filter(polygon => polygon.length && polygon.every(ring => ring.length >= 4 && ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))));
    return polygons.length ? [{ conflict, version, polygons }] : [];
  });
}

/** 在 MapView 的 draw 之后补画空域边界（紫色虚线）与航线中心线（青色）。 */
export function installOverlays(map, { centerline = null, airspaces = [] } = {}) {
  if (!map || (!centerline && !airspaces.length)) return;
  const drawBase = map.draw.bind(map);
  map.draw = function drawWithOverlays() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    context.save();
    airspaces.forEach(({ polygons }) => {
      context.beginPath();
      polygons.forEach(polygon => polygon.forEach(ring => ring.forEach(([lon, lat], index) => {
        const point = this.px(lon, lat);
        if (index) context.lineTo(point[0], point[1]);
        else context.moveTo(point[0], point[1]);
      })));
      context.fillStyle = '#a97bff18';
      context.fill('evenodd');
      context.setLineDash([6, 4]);
      context.strokeStyle = '#7545c7';
      context.lineWidth = 1.35;
      context.stroke();
      context.setLineDash([]);
    });
    if (centerline) {
      context.beginPath();
      centerline.forEach(([lon, lat], index) => {
        const point = this.px(lon, lat);
        if (index) context.lineTo(point[0], point[1]);
        else context.moveTo(point[0], point[1]);
      });
      context.strokeStyle = '#22d3ee';
      context.lineWidth = 2.4;
      context.lineJoin = 'round';
      context.stroke();
    }
    context.restore();
  };
}

/** 把中心线、空域、轨迹点、目标锚点合成一组 [lon, lat]，供 MapView.fitTo 取包围盒。 */
export function overlayPoints({ centerline = null, airspaces = [], points = [], anchor = null } = {}) {
  const out = [];
  if (centerline) out.push(...centerline);
  airspaces.forEach(({ polygons }) => polygons.forEach(polygon => polygon.forEach(ring => out.push(...ring))));
  points.forEach(point => out.push([point.lon, point.lat]));
  if (anchor) out.push([anchor.lon, anchor.lat]);
  return out;
}
