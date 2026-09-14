/* 融合感知页私有的确定性演示源。所有编号都带 SIM，页面同时显示“模拟数据”，
   不会在真实数据请求失败时暗中回退到这里。 */
import { coverageContainsPoint, coverageSummary, normalizeCoverage } from '../../services/situationData.js';

export const MOCK_TICK_MS = 1000;
export const MOCK_TRACK_LIMIT = 48;

const SENSOR_META = {
  RADAR: { label: '雷达', color: '#2dcfd0', icon: 'radar' },
  EO: { label: '光电', color: '#8e7dff', icon: 'camera' },
  FIVE_G_A: { label: '5G-A', color: '#4b9cff', icon: 'bolt' },
  TDOA: { label: 'TDOA', color: '#f1a43a', icon: 'api' }
};

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
      alarm: false, coverage: { kind: 'circle', radiusM: 5000 }
    });

    const eo = offsetPoint(site, -900, -1200);
    seeds.push({
      deviceId: `sim-eo-${site.code.toLowerCase()}`, id: `SIM-EO-${site.code}`,
      name: `${site.label}光电转台`, typeCode: 'EO', ...eo, status: '在线', channel: '光电确认与跟踪',
      alarm: false, coverage: { kind: 'sector', rangeM: 2000, azimuthDeg: bearingDegrees(eo, site), fovDeg: 45 }
    });

    [[-1500, 200], [1500, -300]].forEach(([eastM, northM], index) => {
      const point = offsetPoint(site, eastM, northM);
      const offline = site.code === 'PORT' && index === 1;
      seeds.push({
        deviceId: `sim-5ga-${site.code.toLowerCase()}-${index + 1}`, id: `SIM-5GA-${site.code}-${index + 1}`,
        name: `${site.label}5G-A通感站${index + 1}`, typeCode: 'FIVE_G_A', ...point,
        status: offline ? '离线' : '在线', channel: '5G-A通感', alarm: offline,
        coverage: { kind: 'circle', radiusM: 1000 },
        relatedAlerts: offline ? [{ id: 'SIM-DEV-ALM-5GA-01', level: '中', title: '回传链路中断', state: '风险持续' }] : []
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
  const points = loopPoints(site, variant.radiusM, variant.squash, siteIndex * .41 + variantIndex * .72);
  return {
    id: `SIM-UAV-${number}`, targetId: `sim-target-${number}`, type: '无人机', district: site.district,
    ...variant, legal: index === 0 ? '非法' : index === 1 ? '待确认' : variant.legal,
    durationMs: Math.round(routeLength(points) / variant.speed * 1000),
    fusedConf: 86 + index % 10, points
  };
}));

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
    const coverage = normalizeCoverage({
      ...seed.coverage,
      sourceLabel: '公开指标参考 · 前端演示配置',
      updatedAt: scenarioStartedAt - (online ? 4000 + index * 900 : 78000)
    }, online);
    return {
      ...clone(seed),
      relatedAlerts: (seed.relatedAlerts || []).map(alert => ({ ...alert, ts: scenarioStartedAt - 1000 })),
      color: meta.color,
      type: meta.label,
      icon: meta.icon,
      lastReportAt: online ? now - 1800 : scenarioStartedAt - 78000,
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
  const rings = [[
    [118.49, 37.40], [118.65, 37.42], [118.68, 37.56], [118.52, 37.59], [118.49, 37.40]
  ]];
  return [{
    id: 'SIM-NFZ-01', name: '演示重点防控区', type: '重点防控区', color: '#ff5b61', layer: 'nofly',
    rings, center: { lon: 118.585, lat: 37.495 }, limit: true, limitTx: '120 m', unit: '前端演示配置'
  }];
}

export function createSituationMockSource(options = {}) {
  const tickMs = options.tickMs || MOCK_TICK_MS;
  const startedAt = options.startedAt ?? Date.now();
  const tracks = new Map(MOCK_ROUTES.map(route => [route.id, []]));
  let timer = null;
  let listener = null;
  let pausedAt = null;
  let pausedTotal = 0;

  const scenarioElapsed = now => Math.max(0, (pausedAt || now) - startedAt - pausedTotal);

  function snapshot(at = Date.now()) {
    const elapsed = scenarioElapsed(at);
    const devices = createMockDevices(at, startedAt);
    const targets = MOCK_ROUTES.map((route, index) => {
      const from = routePosition(route, elapsed);
      const to = routePosition(route, elapsed + tickMs);
      const history = tracks.get(route.id);
      const last = history[history.length - 1];
      if (!last || Math.hypot(last.lon - from.lon, last.lat - from.lat) > 0.00001) {
        history.push({ ...from, kind: 'meas' });
        if (history.length > MOCK_TRACK_LIMIT) history.splice(0, history.length - MOCK_TRACK_LIMIT);
      }
      const secondActive = index === 1 && elapsed >= 12000;
      const sourceDeviceIds = devices
        .filter(device => coverageContainsPoint(device, from))
        .map(device => device.id);
      return {
        ...route,
        legal: secondActive ? '异常' : route.legal,
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
    return { generatedAt: at, startedAt, simulated: true, devices, targets, alarms, airspaces: airspaces() };
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
