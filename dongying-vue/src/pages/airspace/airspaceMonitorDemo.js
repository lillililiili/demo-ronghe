// 独立的模拟观测样例，不写入目标、风险或设备接口。坐标与规模均为示意值。
import { pointRelation } from './airspaceRiskModel.js';

export const DEMO_FRAMES = 7;
export const DEMO_DISTRICT = 'airspace-demo-district';
export const DEMO_SCENES = [
  { id: 'dock', label: '无人机机巢周边', name: '无人机机巢起降点（模拟）', distanceLabel: '距机巢起降点',
    geometry: [[118.78, 37.58]] },
  { id: 'facility', label: '重点设施', name: '重点设施中心（模拟）', distanceLabel: '距设施中心',
    geometry: [[118.79, 37.568]] },
  { id: 'route', label: '航线附近', name: '航线中心线（模拟）', distanceLabel: '距航线中心线',
    geometry: [[118.762, 37.554], [118.762, 37.602]] },
  { id: 'airspace', label: '空域边界', name: '监测空域边界（模拟）', distanceLabel: '距空域边界', kind: 'polygon',
    geometry: [[118.8, 37.574], [118.812, 37.574], [118.812, 37.588], [118.8, 37.588], [118.8, 37.574]] }
];
const samples = [
  { id: 'dock-birds', scene: 'dock', subtype: 'BIRD_FLOCK', name: '机巢东侧鸟群', east: 320, north: 100, dx: -30, dy: -8, height: 86, dh: 5, count: 28, dc: 2, severity: 'HIGH' },
  { id: 'dock-balloon', scene: 'dock', subtype: 'BALLOON', name: '机巢北侧气球', east: -150, north: 250, dx: -10, dy: 15, height: 160, dh: 0, count: 1, dc: 0, severity: 'MEDIUM' },
  { id: 'facility-birds', scene: 'facility', subtype: 'BIRD_FLOCK', name: '设施西侧鸟群', east: -680, north: 150, dx: 65, dy: -10, height: 74, dh: -4, count: 16, dc: -1, severity: 'HIGH' },
  { id: 'facility-balloon', scene: 'facility', subtype: 'BALLOON', name: '设施南侧气球', east: 250, north: -480, dx: 0, dy: 0, height: 110, dh: 7, count: 2, dc: 0, severity: 'MEDIUM' },
  { id: 'route-birds', scene: 'route', subtype: 'BIRD_FLOCK', name: '航线东侧鸟群', east: 720, north: 1900, dx: -85, dy: 18, height: 120, dh: 0, count: 34, dc: 1, severity: 'HIGH' },
  { id: 'route-balloon', scene: 'route', subtype: 'BALLOON', name: '航线西侧气球', east: -200, north: 3100, dx: -40, dy: -15, height: 230, dh: -6, count: 1, dc: 0, severity: 'MEDIUM' },
  { id: 'airspace-birds', scene: 'airspace', subtype: 'BIRD_FLOCK', name: '空域西侧鸟群', east: -120, north: 850, dx: 40, dy: 0, height: 95, dh: 2, count: 12, dc: 1, severity: 'HIGH' },
  { id: 'airspace-balloon', scene: 'airspace', subtype: 'BALLOON', name: '空域内气球', east: 260, north: 350, dx: 10, dy: 5, height: 180, dh: 3, count: 2, dc: 0, severity: 'MEDIUM' }
];
const rad = value => value * Math.PI / 180;
function offset([lon, lat], east, north) {
  return [lon + east / (111320 * Math.cos(rad(lat))), lat + north / 111320];
}
// 局部等距投影下点到折线的最短水平距离；演示距离不用于管制判定。
export function distanceToReference(point, geometry) {
  const origin = geometry[0];
  const xy = p => [(p[0] - origin[0]) * 111320 * Math.cos(rad(origin[1])), (p[1] - origin[1]) * 111320];
  const p = xy(point), line = geometry.map(xy);
  if (line.length === 1) return Math.hypot(...p);
  return Math.min(...line.slice(1).map((b, i) => {
    const a = line[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  }));
}
export function buildAirspaceDemo(frame, now) {
  const step = ((frame % DEMO_FRAMES) + DEMO_FRAMES) % DEMO_FRAMES;
  return samples.map(sample => {
    const scene = DEMO_SCENES.find(item => item.id === sample.scene);
    const observe = index => {
      const point = offset(scene.geometry[0], sample.east + sample.dx * index, sample.north + sample.dy * index);
      return { lon: point[0], lat: point[1], height: sample.height + sample.dh * index,
        count: sample.count + sample.dc * index, t: now - (step - index) * 10_000 };
    };
    const trail = Array.from({ length: step + 2 }, (_, i) => observe(i - 1));
    const current = trail.at(-1), previous = trail.at(-2);
    const distance = distanceToReference([current.lon, current.lat], scene.geometry);
    const before = distanceToReference([previous.lon, previous.lat], scene.geometry);
    const relation = scene.kind === 'polygon' ? pointRelation([current.lon, current.lat], [[scene.geometry]]) : null;
    const previousRelation = scene.kind === 'polygon' ? pointRelation([previous.lon, previous.lat], [[scene.geometry]]) : null;
    const crossed = previousRelation && relation !== previousRelation;
    const horizontal = crossed ? (relation === 'BOUNDARY' ? '到达空域边界' : relation === 'INSIDE' ? '进入空域平面范围' : '离开空域平面范围')
      : Math.abs(distance - before) < 5 ? '距离基本不变' : distance < before ? '正在接近' : '正在远离';
    const vertical = current.height === previous.height ? '高度平稳' : current.height > previous.height ? '正在爬升' : '正在下降';
    return { target_id: `airspace-demo-${sample.id}`, target_no: sample.name, object_type_code: sample.subtype === 'BIRD_FLOCK' ? 'BIRD' : 'UNKNOWN',
      subtype: sample.subtype, source_mode: 'mock', district_id: DEMO_DISTRICT, district_name: '模拟场景区域',
      last_seen_at: now, latest_state: { observed_at: now, location: { longitude: current.lon, latitude: current.lat }, altitude_amsl_m: current.height },
      demo: { scene, relation, severity: sample.severity, distance, previousDistance: before, altitude: current.height, datum: 'AMSL',
        count: current.count, unit: sample.subtype === 'BIRD_FLOCK' ? '只' : '个', countDelta: current.count - previous.count,
        horizontal, vertical, trail, speed: Math.hypot(sample.dx, sample.dy) / 10, verticalSpeed: sample.dh / 10 } };
  });
}
