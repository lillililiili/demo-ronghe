/* 融合感知页的数据装配层：把只读接口的返回整理成 map.js 与 HUD 需要的形状。
   纯函数、不发请求、不碰 DOM，因此可以用 node 直接跑单测（tools/situationData.test.cjs）。

   一条贯穿全文件的规矩：**缺的就是缺的，不补默认值**。
   没有研判的目标显示"待确认"而不是"合法"；没有位置的目标进列表但不画点；
   没有当前生效版本的空域不画。把未知补成一个具体值，屏幕上就再也分不出"确实如此"和"没拿到"。 */

/* 用相对路径而不是 @/ 别名：本模块要能被 node 直接 import 跑单测（tools/situationData.test.cjs），
   而别名只有 Vite 认得。文案一律走共享字典，本页不另建一套中文。 */
import { measuredMapPoints } from './trackPoints.js';
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
const DEVICE_PRESENTATION = {
  RADAR: { icon: 'radar', color: '#36d1dc' },
  EO: { icon: 'camera', color: '#a97bff' },
  FIVE_G_A: { icon: 'bolt', color: '#2fd06e' },
  TDOA: { icon: 'api', color: '#ffb020' }
};
const DEVICE_TYPE_CODE = {
  RADAR: 'RADAR', radar: 'RADAR', EO: 'EO', eo: 'EO',
  FIVE_G_A: 'FIVE_G_A', five_g_a: 'FIVE_G_A', '5GA': 'FIVE_G_A', '5ga': 'FIVE_G_A',
  TDOA: 'TDOA', tdoa: 'TDOA'
};
/** 未关闭的告警状态：地图与 HUD 只展示还在处理中的。 */
export const OPEN_ALARM_STATES = ['PENDING_VERIFICATION', 'CONFIRMED'];
/** 融合域已确认的“当前风险”口径：通知/回执/排除都不再点亮实时航线。 */
export const OPEN_ROUTE_RISK_STATES = ['PENDING_VERIFICATION', 'PENDING_NOTIFICATION'];

/** 空中目标的稳定图标键。气球/风筝/孔明灯是推断细类，不伪造为设备原生大类。 */
export function targetIconKind(objectTypeCode, subtypeCode) {
  if (objectTypeCode === 'UAV') return 'uav';
  if (objectTypeCode === 'BIRD' || ['BIRD_FLOCK', 'MIGRATORY_BIRD', 'RAPTOR'].includes(subtypeCode)) return 'bird';
  if (subtypeCode === 'BALLOON') return 'balloon';
  if (subtypeCode === 'KITE') return 'kite';
  if (subtypeCode === 'LANTERN' || subtypeCode === 'SKY_LANTERN') return 'lantern';
  return 'unknown';
}

export function routeRiskIsActive(risk) {
  return !!risk && OPEN_ROUTE_RISK_STATES.includes(risk.state)
    && ['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.riskType || risk.risk_type)
    && !!(risk.planId || risk.plan_id) && !!(risk.routeVersionId || risk.route_version_id);
}

/** 风险只能关联到同一计划的同一条航线版本，避免旧版本风险误点亮当前航线。 */
export function riskMatchesPlan(risk, plan) {
  if (!risk || !plan) return false;
  const riskPlanId = risk.planId || risk.plan_id;
  const riskRouteVersionId = risk.routeVersionId || risk.route_version_id;
  const planId = plan.planId || plan.plan_id || plan.id;
  const routeVersionId = plan.routeVersionId || plan.route_version_id;
  return !!riskPlanId && !!riskRouteVersionId && !!planId && !!routeVersionId
    && String(riskPlanId) === String(planId)
    && String(riskRouteVersionId) === String(routeVersionId);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const COVERAGE_STATES = ['available', 'unavailable', 'unknown'];

/**
 * 设备覆盖参数的统一形状。未知参数绝不补默认半径；设备不在线时，
 * 即使有配置范围也只能标为 unavailable，不能画成正在有效监测。
 */
export function normalizeCoverage(coverage, online = true) {
  const raw = coverage || {};
  const rawKind = String(raw.kind || raw.coverage_kind || '').toLowerCase();
  const kind = rawKind === 'sector' ? 'sector' : rawKind === 'circle' ? 'circle' : null;
  const radiusM = num(raw.radiusM ?? raw.radius_m);
  const rangeM = num(raw.rangeM ?? raw.range_m ?? raw.distanceM ?? raw.distance_m);
  const azimuthDeg = num(raw.azimuthDeg ?? raw.azimuth_deg ?? raw.bearingDeg ?? raw.bearing_deg);
  const fovDeg = num(raw.fovDeg ?? raw.fov_deg ?? raw.horizontalFovDeg ?? raw.horizontal_fov_deg);
  const geometryValid = kind === 'circle'
    ? radiusM !== null && radiusM > 0
    : kind === 'sector' && rangeM !== null && rangeM > 0
      && azimuthDeg !== null && fovDeg !== null && fovDeg > 0 && fovDeg <= 360;
  if (!geometryValid) {
    return {
      kind,
      status: 'unknown',
      availabilityReason: raw.availabilityReason || raw.availability_reason || '覆盖参数未知',
      sourceLabel: raw.sourceLabel || raw.source_label || '参数来源未提供',
      updatedAt: num(raw.updatedAt ?? raw.updated_at)
    };
  }
  const rawStatus = String(raw.status || '').toLowerCase();
  const requested = COVERAGE_STATES.includes(rawStatus) ? rawStatus : 'available';
  return {
    kind,
    status: online && requested !== 'unavailable' ? requested : 'unavailable',
    radiusM: kind === 'circle' ? radiusM : null,
    rangeM: kind === 'sector' ? rangeM : null,
    azimuthDeg: kind === 'sector' ? ((azimuthDeg % 360) + 360) % 360 : null,
    fovDeg: kind === 'sector' ? fovDeg : null,
    availabilityReason: raw.availabilityReason || raw.availability_reason || (online ? '' : '设备非在线，覆盖能力不可用'),
    sourceLabel: raw.sourceLabel || raw.source_label || '参数来源未提供',
    updatedAt: num(raw.updatedAt ?? raw.updated_at)
  };
}

export function coverageSummary(coverage) {
  if (!coverage || coverage.status === 'unknown') return '覆盖参数未知';
  if (coverage.kind === 'sector') {
    return `${Math.round(coverage.azimuthDeg)}°方位 · ${Math.round(coverage.fovDeg)}°视场 · ${(coverage.rangeM / 1000).toFixed(0)} km`;
  }
  return `${(coverage.radiusM / 1000).toFixed(0)} km 覆盖半径`;
}

function distanceMeters(aLon, aLat, bLon, bLat) {
  const rad = Math.PI / 180;
  const y = (bLat - aLat) * rad;
  const x = (bLon - aLon) * rad * Math.cos((aLat + bLat) * .5 * rad);
  return Math.hypot(x, y) * 6371000;
}

function bearingDegrees(aLon, aLat, bLon, bLat) {
  const rad = Math.PI / 180;
  const a = aLat * rad, b = bLat * rad, d = (bLon - aLon) * rad;
  const y = Math.sin(d) * Math.cos(b);
  const x = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** 仅用于展示层验证航迹是否落在已知且可用的覆盖几何内，不参与任何业务判定。 */
export function coverageContainsPoint(device, point) {
  const coverage = device && device.coverage;
  if (!device || !point || coverage?.status !== 'available') return false;
  const distance = distanceMeters(device.lon, device.lat, point.lon, point.lat);
  if (coverage.kind === 'circle') return distance <= coverage.radiusM;
  if (coverage.kind !== 'sector' || distance > coverage.rangeM) return false;
  const bearing = bearingDegrees(device.lon, device.lat, point.lon, point.lat);
  const delta = Math.abs(((bearing - coverage.azimuthDeg + 540) % 360) - 180);
  return delta <= coverage.fovDeg / 2;
}

/** MultiPolygon → 每个多边形的全部环（第 0 环是外环，其余是孔洞，决策 16-3）。
    外环画不出来（点数不足）就整个多边形不画；坐标里有非数字则整条几何作废。 */
export function polygonRings(boundary) {
  if (!boundary || boundary.type !== 'MultiPolygon' || !Array.isArray(boundary.coordinates)) return [];
  const polygons = [];
  for (const polygon of boundary.coordinates) {
    if (!Array.isArray(polygon) || !polygon.length) continue;
    const rings = [];
    let voided = false;
    for (const [index, ring] of polygon.entries()) {
      if (!Array.isArray(ring) || ring.length < 3) {
        if (index === 0) { voided = true; break; }
        continue;
      }
      const points = [];
      for (const point of ring) {
        const lon = num(Array.isArray(point) ? point[0] : null);
        const lat = num(Array.isArray(point) ? point[1] : null);
        if (lon === null || lat === null) return [];
        points.push([lon, lat]);
      }
      rings.push(points);
    }
    if (!voided && rings.length) polygons.push(rings);
  }
  return polygons;
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
    const polygons = polygonRings(version.boundary);
    polygons.forEach((rings, index) => {
      const center = ringCenter(rings[0]);
      if (!center) return;
      // id 会被 map.js 直接画到图上（标注第二行），所以这里放**业务编号**而不是内部 ID。
      // 内部 ID 另存 airspaceId，只用于程序内引用，不上屏。
      const airspaceNo = detail.airspace_no || detail.airspace_id;
      out.push({
        id: polygons.length > 1 ? `${airspaceNo}#${index + 1}` : airspaceNo,
        airspaceId: detail.airspace_id,
        name: detail.name || airspaceNo || '',
        kindCode: meta.kindCode,
        type: meta.type,
        color: meta.color,
        layer: meta.layer,
        // rings 是全部环（第 0 环外环，其余是孔洞），map.js 按 even-odd 填充。
        rings,
        center,
        alt: num(version.max_altitude_m),
        // map.js 的空域提示读 limit/limitTx/unit；没有的字段写"未提供"，不能让 undefined 上屏。
        limit: num(version.max_altitude_m) != null,
        limitTx: num(version.max_altitude_m) != null ? `${num(version.max_altitude_m)} m` : (meta.kindCode === 'PROHIBITED' ? '禁止飞行' : '未提供'),
        unit: detail.managing_org_name || detail.owner_org_name || version.managing_org_name || '未提供'
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
    const status = DEVICE_STATUS[device.connectivity] || '未知';
    const hasAlarm = !!(device.has_alarm || device.alarm);
    const rawTypeCode = device.device_type_code || device.type_code || '';
    const typeCode = DEVICE_TYPE_CODE[rawTypeCode] || String(rawTypeCode).toUpperCase();
    const presentation = DEVICE_PRESENTATION[typeCode] || { icon: 'device', color: '#72d6ff' };
    const coverage = normalizeCoverage(device.coverage, status === '在线');
    out.push({
      deviceId: device.device_id,
      fusionDeviceId: device.fusion_device_id || device.device_id,
      id: device.device_no || device.device_id,
      name: device.name || device.device_no || '',
      lon,
      lat,
      status,
      connectivity: device.connectivity || 'UNKNOWN',
      statusCode: DEVICE_STATUS[device.connectivity] ? device.connectivity : 'UNKNOWN',
      alarm: hasAlarm,
      hasAlarm,
      // has_alarm 来自当前设备状态快照；历史 relatedAlerts 不参与当前故障判断。
      health_code: device.health_code || 'UNKNOWN',
      activeRisk: device.active_risk === true || device.activeRisk === true,
      abnormal: device.abnormal === true || device.has_alarm === true,
      type: device.device_type_name || device.device_type || '',
      typeCode,
      icon: presentation.icon,
      color: presentation.color,
      channel: device.channel || '',
      lastReportAt: num(device.observed_at ?? device.last_heartbeat_at ?? device.received_at),
      relatedAlerts: Array.isArray(device.related_alerts) ? device.related_alerts : [],
      coverage,
      coverageText: coverageSummary(coverage),
      sourceMode: device.source_mode || '',
      simulated: !!device.simulated
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
    const objectTypeCode = target.object_type_code || 'UNKNOWN';
    const subtypeCode = target.subtype || '';
    return {
      id: target.target_no || target.target_id,
      targetId: target.target_id,
      // type 是筛选与"是不是无人机"的判定依据，必须是稳定的大类；
      // typeLabel 才是上屏用的名字（有细类就用细类），两者都走共享字典，本页不另建一套中文。
      type: labelOf(OBJECT_TYPE_LABEL, objectTypeCode, '未分类'),
      typeLabel: targetTypeLabel(subtypeCode, objectTypeCode, '未分类'),
      objectTypeCode,
      subtypeCode,
      iconKind: targetIconKind(objectTypeCode, subtypeCode),
      legal: objectTypeCode === 'UAV'
        ? (legal[target.target_id] || LEGAL_TEXT[target.legality_summary?.legal_status] || LEGAL_FALLBACK)
        : '不适用',
      lon: posValid ? lon : null,
      lat: posValid ? lat : null,
      posValid,
      alt: num(state && state.altitude_amsl_m),
      speed: num(state && state.speed_mps),
      heading: num(state && state.heading_deg),
      fusedConf: percent(state && state.fusion_confidence),
      uavSn: target.uav_sn || '',
      district: target.district_name || '',
      lastSeenAt: num(target.last_seen_at),
      trackStatus: target.track_status?.status || '',
      statusCode: target.status_code || target.track_status?.status || '',
      freshness: target.freshness || '',
      stale: target.stale === true,
      historical: target.historical === true,
      activeRisk: target.active_risk === true || target.activeRisk === true,
      abnormal: target.abnormal === true,
      sourceMode: target.source_mode || '',
      sourceDeviceIds: Array.isArray(target.source_links)
        ? target.source_links.map(link => link.device_id).filter(Boolean) : [],
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
    const lon = num(device.longitude ?? device.lon), lat = num(device.latitude ?? device.lat);
    const deviceId = device.device_id || device.deviceId;
    const fusionDeviceId = device.fusion_device_id || device.fusionDeviceId;
    if (lon === null || lat === null || !deviceId) continue;
    origins[deviceId] = { lon, lat };
    if (fusionDeviceId) origins[fusionDeviceId] = { lon, lat };
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
      eventId: alarm.event_id || null,
      targetId: alarm.target_no || alarm.target_id,
      targetInternalId: alarm.target_id || null,
      level: SEVERITY_LEVEL[alarm.severity] || '低',
      type: alarm.alarm_type || '',
      state: alarm.state,
      eventState: alarm.state,
      severity: alarm.severity,
      ts: num(alarm.occurred_at ?? alarm.raised_at ?? alarm.received_at) || 0,
      district: alarm.district_name || '',
      sourceMode: alarm.source_mode || ''
    });
  }
  return out.sort((left, right) => right.ts - left.ts);
}

/** 轨迹点 → map.js 的 track 数组；kind 小写透传（map.js 用它区分实测点与预测点）。
    读接口把坐标放在 location 里（与 latest_state 同形）；顶层 longitude 只作为兼容。 */
export function toTrack(points) {
  return measuredMapPoints(points);
}

export function toFlightPlans(plans, routeVersions = {}) {
  const out = [];
  for (const plan of plans || []) {
    const route = plan.route || {};
    const routeVersionId = route.route_version_id;
    const version = routeVersions[routeVersionId];
    const coordinates = version?.centerline?.coordinates;
    if (!plan.plan_id || !routeVersionId || !Array.isArray(coordinates) || coordinates.length < 2) continue;
    const valid = coordinates.every(point => Array.isArray(point) && num(point[0]) !== null && num(point[1]) !== null);
    if (!valid) continue;
    out.push({
      id: plan.plan_id,
      planId: plan.plan_id,
      planNo: plan.plan_no || plan.plan_id,
      routeVersionId,
      statusCode: plan.status_code,
      startAt: num(plan.start_at),
      endAt: num(plan.end_at),
      uavId: plan.uav_sn || '',
      coordinates: coordinates.map(point => [Number(point[0]), Number(point[1])]),
      sourceMode: plan.source_mode || plan.source?.source_mode || ''
    });
  }
  return out;
}

/** 设备事件只附着到同一内部 device_id；事件流没有告警 ID 时使用自身 event_id。 */
export function attachDeviceEvents(devices, events) {
  const grouped = new Map();
  for (const event of events || []) {
    if (!event?.device_id) continue;
    const rows = grouped.get(event.device_id) || [];
    rows.push({
      id: event.event_id,
      level: SEVERITY_LEVEL[event.level_code] || '低',
      title: event.message || event.event_type || '设备事件',
      state: event.event_type || '',
      occurredAt: num(event.occurred_at) || 0
    });
    grouped.set(event.device_id, rows);
  }
  return (devices || []).map(device => ({
    ...device,
    relatedAlerts: (grouped.get(device.deviceId) || []).sort((a, b) => b.occurredAt - a.occurredAt)
  }));
}

export function toRisks(risks) {
  return (risks || []).map(risk => {
    const fact = risk.space_fact || null;
    return {
      id: risk.risk_no || risk.risk_id,
      riskId: risk.risk_id, risk_id: risk.risk_id,
      riskType: risk.risk_type,
      severity: risk.severity,
      level: SEVERITY_LEVEL[risk.severity] || '低',
      state: risk.state,
      version: num(risk.version) ?? 0,
      planId: risk.plan_id,
      routeVersionId: risk.route_version_id,
      targetId: risk.target_no || risk.target_id,
      targetInternalId: risk.target_id || null,
      occurredAt: num(risk.occurred_at ?? risk.received_at) || 0,
      ts: num(risk.occurred_at ?? risk.received_at) || 0,
      reasonText: risk.reason_text || '',
      sourceMode: risk.source_mode || '',
      spaceFact: fact ? {
        subtypeCode: fact.subtype_code,
        subtypeName: fact.subtype_name,
        distanceToRouteM: num(fact.distance_to_route_m),
        corridorRelation: fact.corridor_relation,
        altitudeBand: fact.altitude_band,
        objectCount: num(fact.object_count),
        trend: fact.trend,
        longitude: num(fact.longitude),
        latitude: num(fact.latitude)
      } : null
    };
  });
}

/** 批量轨迹仅显示已有观测位置，不在刷新间隔补出无人机运动。 */
export function attachRecentTracks(targets, recentTracks, previousTargets = []) {
  const tracks = new Map((recentTracks?.items || []).map(item => [item.target_id, toTrack(item.points)]));
  const previous = new Map((previousTargets || []).map(target => [target.targetId, target]));
  return (targets || []).map(target => ({
    ...target,
    track: tracks.get(target.targetId) || target.track || [],
    sourceDeviceIds: target.sourceDeviceIds?.length ? target.sourceDeviceIds : (previous.get(target.targetId)?.sourceDeviceIds || [])
  }));
}

export function attachTargetSourceLinks(targets, targetId, detail) {
  const links = Array.isArray(detail?.source_links) ? detail.source_links : [];
  return (targets || []).map(target => target.targetId === targetId
    ? { ...target, sourceDeviceIds: links.map(link => link.device_id).filter(Boolean) }
    : target);
}
