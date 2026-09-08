/* 融合感知页的数据装配层：把只读接口的返回整理成 map.js 与 HUD 需要的形状。
   纯函数、不发请求、不碰 DOM，因此可以用 node 直接跑单测（tools/situationData.test.cjs）。

   一条贯穿全文件的规矩：**缺的就是缺的，不补默认值**。
   没有研判的目标显示"待确认"而不是"合法"；没有位置的目标进列表但不画点；
   没有当前生效版本的空域不画。把未知补成一个具体值，屏幕上就再也分不出"确实如此"和"没拿到"。 */

/* 用相对路径而不是 @/ 别名：本模块要能被 node 直接 import 跑单测（tools/situationData.test.cjs），
   而别名只有 Vite 认得。文案一律走共享字典，本页不另建一套中文。 */
import { OBJECT_TYPE_LABEL, labelOf, targetTypeLabel } from '../ui/labels.js';

/* 空域图层字典（决策 11-6 定名与配色，12-3 定归属来源）。
   阶段 12 起 mock.js 已删除，map.js 的图层归属直接读这里给出的 `layer` 字段——
   所以本表是唯一事实来源：改这里就同时改了地图归属与图例，不会再出现"图例勾选框与地图隐藏的图层对不上"。 */
export const AIRSPACE_LAYERS = [
  { kindCode: 'PROHIBITED', type: '禁飞空域', color: '#ff4d5e', layer: 'nofly', legend: '禁飞区' },
  { kindCode: 'TEMPORARY_CONTROL', type: '临时管制区', color: '#2fd06e', layer: 'nofly', legend: '禁飞区' },
  { kindCode: 'ALTITUDE_LIMIT', type: '限高区域', color: '#ffb020', layer: 'limit', legend: '限高区域' },
  { kindCode: 'RESTRICTED', type: '重点防控区域', color: '#3d8bff', layer: 'limit', legend: '重点防控区域' },
  { kindCode: 'PERMITTED', type: '适飞空域', color: '#a97bff', layer: 'suit', legend: '适飞空域' }
];

/** 认不出的种类不猜图层：返回 null，调用方据此跳过，不会画出一个颜色和归属都是编造的多边形。 */
export function airspaceKindMeta(kindCode) {
  return AIRSPACE_LAYERS.find(item => item.kindCode === kindCode) || null;
}

const LEGAL_TEXT = { LEGAL: '合法', ABNORMAL: '异常', ILLEGAL: '非法', UNDETERMINED: '待确认', NOT_APPLICABLE: '不适用' };
/** 没有 ACTIVE 研判就是"待确认"，不是"合法"（决策 11-3）。 */
export const LEGAL_FALLBACK = '待确认';

const SEVERITY_LEVEL = { CRITICAL: '高', HIGH: '高', MEDIUM: '中', LOW: '低' };
const DEVICE_STATUS = { ONLINE: '在线', OFFLINE: '离线', ABNORMAL: '异常', UNKNOWN: '未知' };
/** 未关闭的告警状态：地图与 HUD 只展示还在处理中的。 */
export const OPEN_ALARM_STATES = ['PENDING_VERIFICATION', 'EVIDENCE_REQUIRED', 'CONFIRMED'];

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** MultiPolygon 只取每个多边形的外环（决策 11-2）；孔洞 map.js 画不了，本期忽略。TODO：孔洞需要 map.js 支持多环。 */
export function outerRings(boundary) {
  if (!boundary || boundary.type !== 'MultiPolygon' || !Array.isArray(boundary.coordinates)) return [];
  const rings = [];
  for (const polygon of boundary.coordinates) {
    if (!Array.isArray(polygon) || !polygon.length) continue;
    const ring = polygon[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const points = [];
    for (const point of ring) {
      const lon = num(Array.isArray(point) ? point[0] : null);
      const lat = num(Array.isArray(point) ? point[1] : null);
      if (lon === null || lat === null) return [];
      points.push([lon, lat]);
    }
    rings.push(points);
  }
  return rings;
}

/** 外环的包围盒中心：map.js 画标注时必须有 center，缺了会直接抛错。 */
export function ringCenter(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
}

/**
 * 空域详情（含 current_version）→ 地图空域数组。
 * 没有当前生效版本、种类不在字典里、几何画不出来的，一律不进地图——不画比画错好。
 */
export function toAirspaces(details) {
  const out = [];
  for (const detail of details || []) {
    const version = detail && detail.current_version;
    if (!version) continue;
    const meta = airspaceKindMeta(version.kind_code);
    if (!meta) continue;
    const rings = outerRings(version.boundary);
    rings.forEach((ring, index) => {
      const center = ringCenter(ring);
      if (!center) return;
      // id 会被 map.js 直接画到图上（标注第二行），所以这里放**业务编号**而不是内部 ID。
      // 内部 ID 另存 airspaceId，只用于程序内引用，不上屏。
      const airspaceNo = detail.airspace_no || detail.airspace_id;
      out.push({
        id: rings.length > 1 ? `${airspaceNo}#${index + 1}` : airspaceNo,
        airspaceId: detail.airspace_id,
        name: detail.name || airspaceNo || '',
        type: meta.type,
        color: meta.color,
        layer: meta.layer,
        poly: ring,
        center,
        alt: num(version.max_altitude_m)
      });
    });
  }
  return out;
}

/** 设备 → 地图点位；没有经纬度就不画（画到 (0,0) 等于凭空造一台设备在几内亚湾）。 */
export function toDevices(devices) {
  const out = [];
  for (const device of devices || []) {
    const lon = num(device.longitude), lat = num(device.latitude);
    if (lon === null || lat === null) continue;
    out.push({
      id: device.device_no || device.device_id,
      name: device.name || device.device_no || '',
      lon,
      lat,
      status: DEVICE_STATUS[device.connectivity] || '未知',
      alarm: false,
      type: device.device_type_name || device.device_type || '',
      channel: device.channel || ''
    });
  }
  return out;
}

/** 研判列表 → target_id → 合法性中文。同一目标多条时取最新（列表已按 evaluated_at 倒序，仍显式取大者）。 */
export function legalByTarget(evaluations) {
  const latest = new Map();
  for (const evaluation of evaluations || []) {
    const targetId = evaluation.target_id;
    if (!targetId) continue;
    const at = num(evaluation.evaluated_at) || 0;
    const seen = latest.get(targetId);
    if (!seen || at >= seen.at) latest.set(targetId, { at, status: evaluation.legal_status });
  }
  const out = {};
  for (const [targetId, value] of latest) out[targetId] = LEGAL_TEXT[value.status] || LEGAL_FALLBACK;
  return out;
}

/**
 * 目标 → 地图/列表用的形状。
 * 没有位置的目标（AOA 只给方位）保留在列表里但 posValid=false，地图不画点；
 * 阶段 15 起把 bearing_deg 与来源设备带出来，由页面从设备位置画一条方位线——
 * 设备没有坐标就不画：凭方位角在地图上随便找个原点画线等于伪造位置。
 */
export function toTargets(targets, legalMap) {
  const legal = legalMap || {};
  return (targets || []).map(target => {
    const state = target.latest_state || null;
    const location = state && state.location ? state.location : null;
    const lon = num(location && location.longitude), lat = num(location && location.latitude);
    const posValid = lon !== null && lat !== null;
    return {
      id: target.target_no || target.target_id,
      targetId: target.target_id,
      // type 是筛选与"是不是无人机"的判定依据，必须是稳定的大类；
      // typeLabel 才是上屏用的名字（有细类就用细类），两者都走共享字典，本页不另建一套中文。
      type: labelOf(OBJECT_TYPE_LABEL, target.object_type_code, '未分类'),
      typeLabel: targetTypeLabel(target.subtype, target.object_type_code, '未分类'),
      legal: legal[target.target_id] || LEGAL_FALLBACK,
      lon: posValid ? lon : null,
      lat: posValid ? lat : null,
      posValid,
      alt: num(state && state.altitude_amsl_m),
      speed: num(state && state.speed_mps),
      heading: num(state && state.heading_deg),
      fusedConf: percent(state && state.fusion_confidence),
      uavSn: target.uav_sn || '',
      district: target.district_name || '',
      /* 阶段 15 追加的三段摘要：缺哪段就是 null，页面缺哪行不渲染哪行，不写"—"占位。 */
      riskSummary: target.risk_summary || null,
      legalitySummary: target.legality_summary || null,
      disposalSummary: target.disposal_summary || null,
      /* 只报方位的目标：方位角与观测它的设备，供页面画方位线。 */
      bearing: num(target.latest_state && target.latest_state.bearing_deg),
      bearingDeviceId: (target.latest_state && target.latest_state.bearing_device_id) || null,
      track: [],
      layerKey: 'track'
    };
  });
}

/**
 * 只报方位的目标 → 方位线的起点。按 device_id 建索引（toDevices 会丢掉无坐标设备并改用 device_no 作 id，
 * 这里要的是原始 device_id 与真实坐标）。设备没坐标就不进这张表——没有起点就不画线，
 * 凭方位角在地图上随便找个原点等于伪造位置。
 */
export function bearingOrigins(devices) {
  const origins = {};
  for (const device of devices || []) {
    const lon = num(device.longitude), lat = num(device.latitude);
    if (lon === null || lat === null || !device.device_id) continue;
    origins[device.device_id] = { lon, lat };
  }
  return origins;
}

/** 给只报方位的目标补上方位线所需的三个字段；补不上的保持不可画。 */
export function attachBearing(targets, origins) {
  const map = origins || {};
  for (const target of targets || []) {
    if (target.posValid || target.bearing == null) continue;
    const origin = map[target.bearingDeviceId];
    if (!origin) continue;
    target.azimuth = target.bearing;
    target.fromDeviceLon = origin.lon;
    target.fromDeviceLat = origin.lat;
  }
  return targets;
}

/** 置信度是 0–1 的小数，屏幕上按百分比显示；没有就是没有，不补 0。 */
export function percent(value) {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

/** 告警 → HUD 列表；只保留未关闭的。 */
export function toAlarms(alarms) {
  const out = [];
  for (const alarm of alarms || []) {
    if (!OPEN_ALARM_STATES.includes(alarm.state)) continue;
    out.push({
      id: alarm.alarm_no || alarm.alarm_id,
      alarmId: alarm.alarm_id,
      targetId: alarm.target_no || alarm.target_id,
      level: SEVERITY_LEVEL[alarm.severity] || '低',
      type: alarm.alarm_type || '',
      state: alarm.state,
      ts: num(alarm.raised_at) || 0,
      district: alarm.district_name || ''
    });
  }
  return out.sort((left, right) => right.ts - left.ts);
}

/** 轨迹点 → map.js 的 track 数组；kind 小写透传（map.js 用它区分实测点与预测点）。 */
export function toTrack(points) {
  const out = [];
  for (const point of points || []) {
    const lon = num(point.longitude), lat = num(point.latitude);
    if (lon === null || lat === null) continue;
    out.push({ lon, lat, kind: String(point.point_kind || point.kind || 'meas').toLowerCase() });
  }
  return out;
}
