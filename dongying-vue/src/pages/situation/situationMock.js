/* 融合感知页私有的确定性演示源。所有编号都带 SIM，页面同时显示“模拟数据”，
   不会在真实数据请求失败时暗中回退到这里。 */
import {
  airspaceKindMeta, coverageContainsPoint, coverageSummary, normalizeCoverage, targetIconKind
} from '../../services/situationData.js';

export const MOCK_TICK_MS = 1000;
export const MOCK_TRACK_LIMIT = 48;

const SENSOR_META = {
  RADAR: { label: '雷达', color: '#2dcfd0', icon: 'radar' },
  EO: { label: '光电', color: '#8e7dff', icon: 'camera' },
  FIVE_G_A: { label: '5G-A', color: '#4b9cff', icon: 'bolt' },
  TDOA: { label: 'TDOA', color: '#f1a43a', icon: 'api' }
};

const STATUS_CODE = { '在线': 'ONLINE', '异常': 'ABNORMAL', '离线': 'OFFLINE', '未知': 'UNKNOWN' };

/* 按东营全域的主要城镇与重点区域布点。这里只表达“多站组网”的页面形态，
   不是现场台账；单站能力采用公开资料中的保守量级，避免再画几十公里的确定覆盖。 */
const DEPLOYMENTS = [
  { code: 'DY', label: '东营城区', district: '东营区', lon: 118.58, lat: 37.45 },
  { code: 'KL', label: '垦利城区', district: '垦利区', lon: 118.56, lat: 37.59 },
  { code: 'HK', label: '河口城区', district: '河口区', lon: 118.53, lat: 37.89 },
  { code: 'LJ', label: '利津城区', district: '利津县', lon: 118.25, lat: 37.49 },
  { code: 'GR', label: '广饶城区', district: '广饶县', lon: 118.41, lat: 37.06 },
  { code: 'PORT', label: '东营港区', district: '河口区', lon: 118.96, lat: 38.08 }
];

function offsetPoint(site, eastM, northM) {
  return {
    lon: site.lon + eastM / (111320 * Math.cos(site.lat * Math.PI / 180)),
    lat: site.lat + northM / 111320
  };
}

function bearingDegrees(from, to) {
  const rad = Math.PI / 180;
  const a = from.lat * rad, b = to.lat * rad, d = (to.lon - from.lon) * rad;
  const y = Math.sin(d) * Math.cos(b);
  const x = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function createDeviceSeeds() {
  const seeds = [];
  DEPLOYMENTS.forEach((site, siteIndex) => {
    const radar = offsetPoint(site, -2400, 1500);
    seeds.push({
      deviceId: `sim-radar-${site.code.toLowerCase()}`, id: `SIM-RADAR-${site.code}`,
      name: `${site.label}低空雷达`, typeCode: 'RADAR', ...radar, status: '在线', channel: '低空雷达探测',
      alarm: false, coverage: { kind: 'circle', radiusM: 5000 }, relatedAlerts: []
    });

    const eo = offsetPoint(site, -900, -1200);
    const eoAbnormal = site.code === 'KL';
    seeds.push({
      deviceId: `sim-eo-${site.code.toLowerCase()}`, id: `SIM-EO-${site.code}`,
      name: `${site.label}光电转台`, typeCode: 'EO', ...eo, status: eoAbnormal ? '异常' : '在线', channel: '光电确认与跟踪',
      alarm: eoAbnormal, coverage: { kind: 'sector', rangeM: 2000, azimuthDeg: bearingDegrees(eo, site), fovDeg: 45 },
      relatedAlerts: eoAbnormal ? [{ id: 'SIM-DEV-ALM-EO-01', level: '中', title: '云台方位反馈异常', state: '风险持续' }] : []
    });

    [[-1500, 200], [1500, -300]].forEach(([eastM, northM], index) => {
      const point = offsetPoint(site, eastM, northM);
      const offline = site.code === 'PORT' && index === 1;
      const abnormal = site.code === 'GR' && index === 0;
      const onlineAlarm = site.code === 'DY' && index === 0;
      seeds.push({
        deviceId: `sim-5ga-${site.code.toLowerCase()}-${index + 1}`, id: `SIM-5GA-${site.code}-${index + 1}`,
        name: `${site.label}5G-A通感站${index + 1}`, typeCode: 'FIVE_G_A', ...point,
        status: offline ? '离线' : abnormal ? '异常' : '在线', channel: '5G-A通感', alarm: offline || abnormal || onlineAlarm,
        coverage: { kind: 'circle', radiusM: 1000 },
        relatedAlerts: offline ? [{ id: 'SIM-DEV-ALM-5GA-01', level: '中', title: '回传链路中断', state: '风险持续' }]
          : abnormal ? [{ id: 'SIM-DEV-ALM-5GA-03', level: '中', title: '通感时钟偏差超阈', state: '风险持续' }]
            : onlineAlarm ? [{ id: 'SIM-DEV-ALM-5GA-02', level: '低', title: '上行信号质量下降', state: '风险持续' }] : []
      });
    });

    [[-1800, -1400], [1800, -1300], [0, 1800]].forEach(([eastM, northM], index) => {
      const point = offsetPoint(site, eastM, northM);
      const offline = site.code === 'HK' && index === 2;
      seeds.push({
        deviceId: `sim-tdoa-${site.code.toLowerCase()}-${index + 1}`, id: `SIM-TDOA-${site.code}-${index + 1}`,
        name: `${site.label}TDOA站${index + 1}`, typeCode: 'TDOA', ...point,
        status: offline ? '离线' : '在线', channel: '三站时差定位', alarm: offline,
        coverage: { kind: 'circle', radiusM: 1000 },
        relatedAlerts: offline ? [{ id: 'SIM-DEV-ALM-TDOA-01', level: '中', title: '心跳中断', state: '风险持续' }] : []
      });
    });
  });
  return seeds;
}

const DEVICE_SEEDS = createDeviceSeeds();

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const y = (b.lat - a.lat) * rad;
  const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) * .5 * rad);
  return Math.hypot(x, y) * 6371000;
}

function loopPoints(site, radiusM, squash, phase) {
  return Array.from({ length: 8 }, (_, index) => {
    const angle = phase + index / 8 * Math.PI * 2;
    const point = offsetPoint(site, Math.cos(angle) * radiusM, Math.sin(angle) * radiusM * squash);
    return [point.lon, point.lat];
  });
}

function routeLength(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + distanceMeters({ lon: point[0], lat: point[1] }, { lon: next[0], lat: next[1] });
  }, 0);
}

const ROUTE_VARIANTS = [
  { typeLabel: '多旋翼无人机', speed: 8.5, alt: 118, radiusM: 420, squash: .72, legal: '合法' },
  { typeLabel: '行业多旋翼无人机', speed: 11.5, alt: 186, radiusM: 650, squash: .58, legal: '合法' },
  { typeLabel: '垂直起降固定翼', speed: 22, alt: 318, radiusM: 980, squash: .48, legal: '待确认' }
];

export const MOCK_ROUTES = DEPLOYMENTS.flatMap((site, siteIndex) => ROUTE_VARIANTS.map((variant, variantIndex) => {
  const index = siteIndex * ROUTE_VARIANTS.length + variantIndex;
  const number = String(index + 1).padStart(3, '0');
  /* 三类无人机分别落在光电视场、5G-A 站和 TDOA 节点附近，
     不用“设备类型可探测”代替真实几何覆盖关系。 */
  const center = variantIndex === 1 ? offsetPoint(site, -1500, 200)
    : variantIndex === 2 ? offsetPoint(site, 0, 1800) : site;
  const points = loopPoints(center, variant.radiusM, variant.squash, siteIndex * .41 + variantIndex * .72);
  return {
    id: `SIM-UAV-${number}`, targetId: `sim-target-${number}`, type: '无人机', district: site.district,
    ...variant, legal: index === 0 ? '非法' : index === 1 ? '待确认' : variant.legal,
    durationMs: Math.round(routeLength(points) / variant.speed * 1000),
    fusedConf: 86 + index % 10, points
  };
}));

const FOREIGN_VARIANTS = [
  { id: 'SIM-OBJ-001', site: DEPLOYMENTS[0], center: offsetPoint(DEPLOYMENTS[0], 0, 0), objectTypeCode: 'BIRD', subtypeCode: 'BIRD_FLOCK', type: '鸟类', typeLabel: '鸟群', speed: 10.5, alt: 72, radiusM: 360, squash: .46 },
  { id: 'SIM-OBJ-002', site: DEPLOYMENTS[5], center: offsetPoint(DEPLOYMENTS[5], -1500, 200), objectTypeCode: 'UNKNOWN', subtypeCode: 'BALLOON', type: '未分类', typeLabel: '气球', speed: 2.2, alt: 165, radiusM: 120, squash: .72 },
  { id: 'SIM-OBJ-003', site: DEPLOYMENTS[3], center: offsetPoint(DEPLOYMENTS[3], -1800, -1400), objectTypeCode: 'UNKNOWN', subtypeCode: 'KITE', type: '未分类', typeLabel: '风筝', speed: .6, alt: 48, radiusM: 36, squash: .55 },
  { id: 'SIM-OBJ-004', site: DEPLOYMENTS[4], center: offsetPoint(DEPLOYMENTS[4], 0, 0), objectTypeCode: 'UNKNOWN', subtypeCode: 'SKY_LANTERN', type: '未分类', typeLabel: '孔明灯', speed: 1.5, alt: 96, radiusM: 82, squash: .8 },
  { id: 'SIM-OBJ-005', site: DEPLOYMENTS[2], center: offsetPoint(DEPLOYMENTS[2], -1500, 200), objectTypeCode: 'UNKNOWN', subtypeCode: 'OTHER_OBJECT', type: '未分类', typeLabel: '其他异物', speed: 3.2, alt: 138, radiusM: 170, squash: .62 },
  { id: 'SIM-OBJ-006', site: DEPLOYMENTS[1], center: offsetPoint(DEPLOYMENTS[1], 0, 1800), objectTypeCode: 'BIRD', subtypeCode: 'MIGRATORY_BIRD', type: '鸟类', typeLabel: '候鸟', speed: 8.2, alt: 110, radiusM: 250, squash: .5 }
];

export const MOCK_FOREIGN_ROUTES = FOREIGN_VARIANTS.map((variant, index) => {
  const points = loopPoints(variant.center, variant.radiusM, variant.squash, .34 + index * .61);
  return {
    ...variant,
    targetId: `sim-object-${String(index + 1).padStart(3, '0')}`,
    district: variant.site.district,
    iconKind: targetIconKind(variant.objectTypeCode, variant.subtypeCode),
    legal: '不适用',
    fusedConf: 78 + index * 3,
    durationMs: Math.round(routeLength(points) / variant.speed * 1000),
    points
  };
});

export const MOCK_TARGET_ROUTES = [...MOCK_ROUTES.map(route => ({
  ...route, objectTypeCode: 'UAV', subtypeCode: route.typeLabel === '垂直起降固定翼' ? 'VTOL' : 'QUADCOPTER', iconKind: 'uav'
})), ...MOCK_FOREIGN_ROUTES];

function planCoordinates(site, offsets) {
  return offsets.map(([eastM, northM]) => {
    const point = offsetPoint(site, eastM, northM);
    return [point.lon, point.lat];
  });
}

const PLAN_SEEDS = [
  { id: 'SIM-PLAN-001', routeVersionId: 'SIM-RV-001', planNo: 'SIM-FP-20260914-001', statusCode: 'EXECUTING', site: DEPLOYMENTS[0], offsets: [[-1250, -420], [0, 0], [1380, 520]], startMin: -30, endMin: 30, uavId: 'SIM-UAV-001' },
  { id: 'SIM-PLAN-002', routeVersionId: 'SIM-RV-002', planNo: 'SIM-FP-20260914-002', statusCode: 'EXECUTING', site: DEPLOYMENTS[1], offsets: [[-1000, -520], [120, 60], [1180, 630]], startMin: -10, endMin: 50, uavId: 'SIM-UAV-004' },
  { id: 'SIM-PLAN-003', routeVersionId: 'SIM-RV-003', planNo: 'SIM-FP-20260914-003', statusCode: 'PENDING', site: DEPLOYMENTS[5], offsets: [[-2300, -80], [-1500, 200], [-320, 620]], startMin: 40, endMin: 100, uavId: 'SIM-UAV-016' },
  { id: 'SIM-PLAN-004', routeVersionId: 'SIM-RV-004', planNo: 'SIM-FP-20260914-004', statusCode: 'PENDING', site: DEPLOYMENTS[4], offsets: [[-1100, -620], [0, 0], [1260, 470]], startMin: 80, endMin: 140, uavId: 'SIM-UAV-013' },
  { id: 'SIM-PLAN-005', routeVersionId: 'SIM-RV-005', planNo: 'SIM-FP-20260914-005', statusCode: 'COMPLETED', site: DEPLOYMENTS[3], offsets: [[-2300, -1620], [-1800, -1400], [-620, -760]], startMin: -180, endMin: -120, uavId: 'SIM-UAV-010' },
  { id: 'SIM-PLAN-006', routeVersionId: 'SIM-RV-006', planNo: 'SIM-FP-20260914-006', statusCode: 'COMPLETED', site: DEPLOYMENTS[2], offsets: [[-1100, -520], [0, 0], [930, 680]], startMin: -90, endMin: -30, uavId: 'SIM-UAV-007' }
];

export function createMockFlightPlans(startedAt = Date.now()) {
  return PLAN_SEEDS.map(seed => ({
    id: seed.id,
    planId: seed.id,
    routeVersionId: seed.routeVersionId,
    planNo: seed.planNo,
    statusCode: seed.statusCode,
    startAt: startedAt + seed.startMin * 60000,
    endAt: startedAt + seed.endMin * 60000,
    uavId: seed.uavId,
    coordinates: planCoordinates(seed.site, seed.offsets),
    sourceMode: 'mock'
  }));
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function routePosition(route, elapsedMs) {
  const points = route.points;
  const cycle = ((elapsedMs % route.durationMs) + route.durationMs) % route.durationMs;
  const scaled = cycle / route.durationMs * points.length;
  const index = Math.floor(scaled) % points.length;
  const next = (index + 1) % points.length;
  const t = scaled - Math.floor(scaled);
  return {
    lon: points[index][0] + (points[next][0] - points[index][0]) * t,
    lat: points[index][1] + (points[next][1] - points[index][1]) * t
  };
}

export function createMockDevices(now = Date.now(), scenarioStartedAt = now) {
  return DEVICE_SEEDS.map((seed, index) => {
    const meta = SENSOR_META[seed.typeCode];
    const online = seed.status === '在线';
    const availabilityReason = seed.status === '异常' ? '设备异常，覆盖能力不可用'
      : seed.status === '离线' ? '设备离线，覆盖能力不可用' : '';
    const coverage = normalizeCoverage({
      ...seed.coverage,
      availabilityReason,
      sourceLabel: '公开指标参考 · 前端演示配置',
      updatedAt: scenarioStartedAt - (online ? 4000 + index * 900 : 78000)
    }, online);
    return {
      ...clone(seed),
      relatedAlerts: (seed.relatedAlerts || []).map(alert => ({ ...alert, ts: scenarioStartedAt - 1000 })),
      statusCode: STATUS_CODE[seed.status] || 'UNKNOWN',
      hasAlarm: !!seed.alarm,
      color: meta.color,
      type: meta.label,
      icon: meta.icon,
      lastReportAt: online ? now - 1800 : seed.status === '异常' ? now - 9800 : scenarioStartedAt - 78000,
      coverage,
      coverageText: coverageSummary(coverage)
    };
  });
}

export function routeIsCovered(route, devices) {
  const points = route?.points || [];
  if (points.length < 2) return false;
  return points.every((from, index) => {
    const to = points[(index + 1) % points.length];
    /* 不能只验折点：相邻折点可能分别落在两个覆盖区，连线中段却从空白处穿过。 */
    for (let step = 0; step <= 24; step++) {
      const ratio = step / 24;
      const point = { lon: from[0] + (to[0] - from[0]) * ratio, lat: from[1] + (to[1] - from[1]) * ratio };
      if (!devices.some(device => coverageContainsPoint(device, point))) return false;
    }
    return true;
  });
}

function airspaces() {
  /* 与后台空域种类保持一致。边界仅用于展示多类型图层，不代表真实管制边界。 */
  const seeds = [
    {
      id: 'SIM-AS-PRO-01', name: '东营城区演示禁飞空域', kindCode: 'PROHIBITED', limitTx: '禁止飞行',
      rings: [[[118.535, 37.423], [118.625, 37.426], [118.635, 37.485], [118.553, 37.493], [118.535, 37.423]]],
      center: { lon: 118.585, lat: 37.458 }
    },
    {
      id: 'SIM-AS-TMP-01', name: '东营港演示临时管制区', kindCode: 'TEMPORARY_CONTROL', limitTx: '120 m',
      rings: [[[118.900, 38.035], [119.030, 38.037], [119.052, 38.102], [118.932, 38.126], [118.900, 38.035]]],
      center: { lon: 118.976, lat: 38.080 }
    },
    {
      id: 'SIM-AS-ALT-01', name: '利津演示限高区域', kindCode: 'ALTITUDE_LIMIT', limitTx: '150 m',
      rings: [[[118.188, 37.454], [118.301, 37.444], [118.326, 37.510], [118.214, 37.538], [118.188, 37.454]]],
      center: { lon: 118.257, lat: 37.491 }
    },
    {
      id: 'SIM-AS-RES-01', name: '垦利演示重点防控区域', kindCode: 'RESTRICTED', limitTx: '180 m',
      rings: [[[118.505, 37.555], [118.607, 37.548], [118.626, 37.623], [118.532, 37.646], [118.505, 37.555]]],
      center: { lon: 118.566, lat: 37.597 }
    },
    {
      id: 'SIM-AS-PER-01', name: '广饶演示适飞空域', kindCode: 'PERMITTED', limitTx: '300 m',
      rings: [[[118.338, 37.010], [118.477, 37.014], [118.496, 37.088], [118.360, 37.105], [118.338, 37.010]]],
      center: { lon: 118.417, lat: 37.059 }
    }
  ];
  return seeds.map(seed => {
    const meta = airspaceKindMeta(seed.kindCode);
    return {
      ...seed,
      type: meta.type,
      color: meta.color,
      layer: meta.layer,
      limit: true,
      unit: '前端演示配置'
    };
  });
}

function createMockRisks(startedAt, elapsed) {
  const risks = [
    {
      id: 'SIM-RISK-001', riskId: 'SIM-RISK-001', riskType: 'SPACE_OBJECT', severity: 'HIGH', level: '高',
      state: 'PENDING_VERIFICATION', planId: 'SIM-PLAN-001', routeVersionId: 'SIM-RV-001', targetId: 'SIM-OBJ-001',
      occurredAt: startedAt - 8000, ts: startedAt - 8000, reasonText: '鸟群进入执行中航线走廊',
      spaceFact: { subtypeCode: 'BIRD_FLOCK', subtypeName: '鸟群', distanceToRouteM: 42, corridorRelation: 'INSIDE' }
    },
    {
      id: 'SIM-RISK-003', riskId: 'SIM-RISK-003', riskType: 'SPACE_OBJECT', severity: 'LOW', level: '低',
      state: 'NOTIFIED', planId: 'SIM-PLAN-005', routeVersionId: 'SIM-RV-005', targetId: 'SIM-OBJ-003',
      occurredAt: startedAt - 132 * 60000, ts: startedAt - 132 * 60000, reasonText: '历史风筝邻近已完成航线，风险已通知',
      spaceFact: { subtypeCode: 'KITE', subtypeName: '风筝', distanceToRouteM: 180, corridorRelation: 'NEAR' }
    }
  ];
  if (elapsed >= 18000) risks.push({
    id: 'SIM-RISK-002', riskId: 'SIM-RISK-002', riskType: 'SPACE_OBJECT', severity: 'MEDIUM', level: '中',
    state: 'PENDING_NOTIFICATION', planId: 'SIM-PLAN-003', routeVersionId: 'SIM-RV-003', targetId: 'SIM-OBJ-002',
    occurredAt: startedAt + 18000, ts: startedAt + 18000, reasonText: '气球邻近待执行航线',
    spaceFact: { subtypeCode: 'BALLOON', subtypeName: '气球', distanceToRouteM: 236, corridorRelation: 'NEAR' }
  });
  return risks.sort((left, right) => right.occurredAt - left.occurredAt);
}

export function createSituationMockSource(options = {}) {
  const tickMs = options.tickMs || MOCK_TICK_MS;
  const startedAt = options.startedAt ?? Date.now();
  const tracks = new Map(MOCK_TARGET_ROUTES.map(route => [route.id, []]));
  let timer = null;
  let listener = null;
  let pausedAt = null;
  let pausedTotal = 0;

  const scenarioElapsed = now => Math.max(0, (pausedAt || now) - startedAt - pausedTotal);

  function snapshot(at = Date.now()) {
    const elapsed = scenarioElapsed(at);
    const devices = createMockDevices(at, startedAt);
    const targets = MOCK_TARGET_ROUTES.map((route, index) => {
      const from = routePosition(route, elapsed);
      const to = routePosition(route, elapsed + tickMs);
      const history = tracks.get(route.id);
      const last = history[history.length - 1];
      if (!last || last.observedAt !== at) {
        history.push({ ...from, kind: 'meas', observedAt: at });
        if (history.length > MOCK_TRACK_LIMIT) history.splice(0, history.length - MOCK_TRACK_LIMIT);
      }
      const secondActive = route.objectTypeCode === 'UAV' && index === 1 && elapsed >= 12000;
      const sourceDeviceIds = devices
        .filter(device => coverageContainsPoint(device, from))
        .map(device => device.id);
      return {
        ...route,
        legal: route.objectTypeCode === 'UAV' ? (secondActive ? '异常' : route.legal) : '不适用',
        sourceDeviceIds,
        lon: to.lon,
        lat: to.lat,
        posValid: true,
        heading: (Math.atan2(to.lon - from.lon, to.lat - from.lat) * 180 / Math.PI + 360) % 360,
        track: clone(history),
        trackLoaded: true,
        status: '跟踪中',
        movement: { fromLon: from.lon, fromLat: from.lat, toLon: to.lon, toLat: to.lat, startedAt: at, endsAt: at + tickMs }
      };
    });
    const alarms = [{
      id: 'SIM-ALM-001', alarmId: 'SIM-ALM-001', targetId: 'SIM-UAV-001', level: '高',
      type: '禁飞区入侵', state: 'ACTIVE', ts: startedAt - 5000, district: MOCK_ROUTES[0].district, riskText: '风险持续'
    }];
    if (elapsed >= 12000) alarms.push({
      id: 'SIM-ALM-002', alarmId: 'SIM-ALM-002', targetId: 'SIM-UAV-002', level: '中',
      type: '高度异常', state: 'ACTIVE', ts: startedAt + 12000, district: MOCK_ROUTES[1].district, riskText: '风险持续'
    });
    return {
      generatedAt: at,
      startedAt,
      simulated: true,
      devices,
      targets,
      alarms,
      flightPlans: createMockFlightPlans(startedAt),
      risks: createMockRisks(startedAt, elapsed),
      airspaces: airspaces()
    };
  }

  function emit() {
    if (listener && pausedAt === null) listener(snapshot());
  }

  return {
    startedAt,
    snapshot,
    start(next) {
      listener = next;
      emit();
      if (!timer) timer = setInterval(emit, tickMs);
      return () => this.stop();
    },
    pause() {
      if (pausedAt !== null) return;
      pausedAt = Date.now();
      if (timer) clearInterval(timer);
      timer = null;
    },
    resume() {
      if (pausedAt === null) return;
      pausedTotal += Date.now() - pausedAt;
      pausedAt = null;
      emit();
      if (!timer && listener) timer = setInterval(emit, tickMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      listener = null;
      pausedAt = null;
    }
  };
}
