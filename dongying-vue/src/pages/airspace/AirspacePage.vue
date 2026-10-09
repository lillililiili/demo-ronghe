<script setup>
/* 空域管理：选区查看近期监测目标、历史风险与上级空域规则。
   目标位置和风险发现快照分图层展示，不由前端推导入侵、现场解除或整片空域安全。
   新空域规则由上级下发，本页只读展示并保留旧资料。
   监测只读取接口数据；读取失败时如实显示原因。 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { refreshFailureText, useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { flightApi } from '@/services/flightApi.js';
import { strokePlannedRoute } from '@/services/positionMap.js';
import { airspaceKindMeta, polygonRings, toAirspaces } from '@/services/situationData.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPanel from '@/components/UPanel.vue';
import UControl from '@/components/form/UControl.vue';
import AirspaceRiskList from './AirspaceRiskList.vue';
import AirspaceRiskDrawer from './AirspaceRiskDrawer.vue';
import { useAirspaceRiskList } from './useAirspaceRiskList.js';
import { useAirspaceRisks } from './useAirspaceRisks.js';
import { useAirspaceMonitor } from './useAirspaceMonitor.js';
import WeatherRiskMarkers from '@/components/WeatherRiskMarkers.vue';
import AirspaceObjectMarkers from './AirspaceObjectMarkers.vue';
import { hitMapReference } from './airspaceReferenceHover.js';
import {
  AIRSPACE_KIND_LABEL, AIRSPACE_KIND_TAG, ALTITUDE_DATUM_LABEL,
  labelOf
} from '@/ui/labels.js';
import { displayAirspaceNo, displayRouteNo } from '@/ui/deviceNumber.js';

usePageChrome('airspace');

/* ---------- 常量 ---------- */
const KIND_CODES = ['PROHIBITED', 'RESTRICTED', 'ALTITUDE_LIMIT', 'PERMITTED', 'TEMPORARY_CONTROL'];
const KIND_OPTIONS = [{ label: '全部种类', value: '' }].concat(KIND_CODES.map(value => ({ label: AIRSPACE_KIND_LABEL[value], value })));
const VALIDITY_OPTIONS = [{ label: '全部', value: '' }, { label: '当前生效', value: 'now' }, { label: '当前未生效', value: 'off' }];
const ROUTE_COLOR = '#22d3ee'; // 监测位置颜色
const PLAN_COLOR = '#8ca0a8'; // 任务几何统一灰色
const PAGE_MAX = 100;
// 用户确认仅从本页日常列表移除的测试空域；服务端版本和历史研判引用继续保留。
const OMITTED_TEST_AIRSPACE_IDS = new Set([
  'e404332c-9d6f-4f03-8def-8c0e3720db31', // 重启自检临时管制区 · 自检-临管-24153
  '1fc27dfe-bb41-4051-bc8c-602157c2c95f', // 测试临时管制区 · 临管-2026-001
  'seed-stage3-airspace-prohibited', // 禁止演示空域 · 空域-001
  // 设备模拟器旧批次重复空域；保留后台历史版本，不再进入日常空域卡片列表。
  '2b805638-cbf0-4541-8a25-1cf43bbd6c46',
  '99452f43-737c-44a3-9441-5c303cd0c70c',
  '2995f0eb-d574-4ed3-abec-d57dab1d79c9'
]);

/* ---------- 状态 ---------- */
const all = ref([]);                // 空域详情（含 current_version），一次读全
const routeLines = ref([]);         // 合法航线中心线 [{ id, name, points }]
const routesAvailable = ref(true);  // 无 route:read 时整层不画、图例不列
const loading = ref(false), error = ref(''), refreshError = ref('');
const filters = reactive({ district: '', kind: '', validity: '', keyword: '' });
const hiddenKinds = ref({});        // { kindCode: true } → 图上不画
const showRoutes = ref(true);
const page = ref(1), size = ref(10);
const selected = ref(null);
const bottomTab = ref('rules');
const risks = reactive(useAirspaceRisks(computed(() => filters.district), selected));
const monitor = reactive(useAirspaceMonitor(computed(() => filters.district), selected, computed(() => risks.onlySelected)));
const riskList = reactive(useAirspaceRiskList(monitor, risks, selected));
const riskDetailOpen = ref(false);
const RISK_COLORS = { CRITICAL: '#ff4d5e', HIGH: '#ff4d5e', MEDIUM: '#ffb020', LOW: '#3d8bff' };
const riskColor = risk => risk.state === 'EXCLUDED' ? '#8ca0be' : RISK_COLORS[risk.severity] || '#8ca0be';
const versions = ref([]);
const detailLoading = ref(false), detailError = ref('');
const mapHost = ref(null);
const weatherLayer = ref(null);
const objectMarkers = ref([]);
const referenceTip = ref(null);
let referenceShapes = [];
let referenceCamera = '';
let map = null;
let fittedOnce = false;
const riskSection = ref(null);


/* ---------- 文案 ---------- */
function time(value) { return value == null ? '' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function day(value) { return value == null ? '' : new Date(value).toLocaleDateString('zh-CN'); }
function sourceLabel(row) { return ({ mock: '模拟', replay: '回放' })[row?.source_display_mode || row?.source_mode] || ''; }
function kindLabel(code) { return labelOf(AIRSPACE_KIND_LABEL, code, '未知种类'); }
function kindTag(code) {
  return ({ RESTRICTED: 't-orange', TEMPORARY_CONTROL: 't-purple', TEMPORARY: 't-purple' })[code] || AIRSPACE_KIND_TAG[code] || 't-gray';
}
function kindAccent(code) { return code ? `var(--${kindTag(code).slice(2)})` : 'var(--line)'; }
function kindColor(code) { return airspaceKindMeta(code)?.color || '#8ca0be'; }
function messageOf(reason) {
  if (!reason) return '读取失败，请稍后重试。';
  if (reason.status === 401) return '登录已失效，请重新登录。';
  if (reason.status === 403) return '当前账号没有查看空域的权限。';
  if (reason.status === 408 || reason.code === 'NETWORK_ERROR') return '服务连接超时或不可用，请稍后重试。';
  return reason.message || '读取失败，请稍后重试。';
}

/** 高度：禁飞区没有上限就说"禁止飞行"，缺基准就说"未填写"，不出现符号写法。 */
function altitudeText(version) {
  if (!version) return '未填写';
  const min = version.min_altitude_m, max = version.max_altitude_m, datum = version.altitude_datum;
  if (min == null && max == null) return version.kind_code === 'PROHIBITED' ? '禁止飞行' : '未填写';
  const datumText = datum ? `（${labelOf(ALTITUDE_DATUM_LABEL, datum, '')}）` : '';
  if (max == null) return `${min} 米以上${datumText}`;
  if (min == null) return `${max} 米以下${datumText}`;
  return `${min} ~ ${max} 米${datumText}`;
}

/** 生效期：valid_to 空 = 长期有效。 */
function validityText(version) {
  if (!version) return '当前没有生效版本';
  return `${time(version.valid_from)} 至 ${version.valid_to ? time(version.valid_to) : '长期有效'}`;
}
function validityShort(version) {
  if (!version) return '—';
  return `${day(version.valid_from)} ~ ${version.valid_to ? day(version.valid_to) : '长期'}`;
}

/** 球面多边形面积（平方公里）：外环减孔洞，多面求和；只做展示，不用于任何判定。 */
function ringAreaM2(ring) {
  const R = 6378137;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i], [lon2, lat2] = ring[(i + 1) % ring.length];
    sum += (lon2 - lon1) * Math.PI / 180 * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
  }
  return Math.abs(sum * R * R / 2);
}
function areaKm2(version) {
  const polygons = polygonRings(version?.boundary);
  if (!polygons.length) return null;
  const m2 = polygons.reduce((acc, rings) => acc + rings.reduce((a, ring, index) => a + (index ? -1 : 1) * ringAreaM2(ring), 0), 0);
  return Math.max(0, m2) / 1e6;
}
function areaText(version) {
  const km2 = areaKm2(version);
  return km2 == null ? '—' : `${km2.toFixed(2)} 平方公里`;
}

/* ---------- 读取 ---------- */
let batchAirspaces = true;
async function listAirspaces(withVersion) {
  const extra = withVersion && batchAirspaces ? { include: 'current_version' } : {};
  if (withVersion && !batchAirspaces) return null;
  const first = await airspaceApi.list({ page: 1, size: PAGE_MAX, ...extra });
  let items = first.items || [];
  const pages = Math.ceil((first.total || 0) / PAGE_MAX);
  for (let p = 2; p <= pages; p++) items = items.concat((await airspaceApi.list({ page: p, size: PAGE_MAX, ...extra })).items || []);
  return items.filter(item => !OMITTED_TEST_AIRSPACE_IDS.has(item.airspace_id));
}

/* quiet：实时刷新或到点重读。已有列表时读取失败保留原列表并注明，错误抛给实时刷新按退避重试；
   列表原本就读取失败时按正常流程重读。 */
async function loadAll({ quiet = false } = {}) {
  const keep = quiet && all.value.length > 0 && !error.value;
  let failure = null;
  loading.value = true;
  if (!keep) error.value = '';
  try {
    // 先一次取回空域连同当前版本；旧后端不认（400）或某片空域版本重叠（409）时改回逐片读取详情。
    let details = await listAirspaces(true).catch(reason => {
      if (reason?.status !== 400 && reason?.status !== 409) throw reason;
      if (reason?.status === 400) batchAirspaces = false;
      return null;
    });
    if (!details) {
      const items = await listAirspaces(false);
      // 单片详情读不到（例如服务端判版本重叠）不能让它从台账上消失：保留清单行，标出原因。
      details = await Promise.all(items.map(item => airspaceApi.detail(item.airspace_id)
        .catch(reason => ({ ...item, current_version: null, load_error: reason?.code === 'VERSION_AMBIGUOUS' ? '版本区间重叠，服务端拒绝读取' : messageOf(reason) }))));
    }
    all.value = details;
    refreshError.value = '';
    if (selected.value) {
      const refreshed = all.value.find(row => row.airspace_id === selected.value.airspace_id);
      if (refreshed) selected.value = refreshed; else clearDetail();
    }
    await loadUpcomingStarts(details);
  } catch (reason) {
    failure = reason;
    if (keep) refreshError.value = refreshFailureText(reason, '读取空域失败');
    else { all.value = []; clearDetail(); error.value = messageOf(reason); }
  } finally { loading.value = false; }
  await nextTick();
  paintMap(!fittedOnce);
  scheduleBoundaryReload();
  if (failure && quiet) throw failure;
}

/* ---------- 到点生效、到点失效（ZT-07） ----------
   空域和航线按生效时间到点生效或失效时数据库没有任何变化，不会有推送信号，页面按已知的边界时间自己重读：
   每片空域当前版本的失效时间（下发新版本时上一版会在新版本生效的时刻关闭）、暂无生效版本的空域最早的待生效时间
   （按空域版本号缓存，空域有改动才重新读取版本）、正在查看的空域的版本历史，以及航线版本的生效、失效时间。
   到点后稍等一秒再读；两边时钟略有偏差、读到的仍是旧版本时，每 3 秒再读一次，最多补读 10 次。 */
const BOUNDARY_GRACE_MS = 1_000;
const BOUNDARY_RECHECK_MS = 3_000;
const MAX_TIMER_MS = 2_000_000_000;
const upcomingStarts = new Map();   // airspace_id → { version, at }
let routeBoundaries = [];
let boundaryTimer = 0, boundaryRechecks = 0, pageAlive = true;
async function loadUpcomingStarts(rows) {
  const now = Date.now();
  const idle = rows.filter(row => !row.current_version && !row.load_error);
  const ids = new Set(idle.map(row => row.airspace_id));
  [...upcomingStarts.keys()].forEach(id => { if (!ids.has(id)) upcomingStarts.delete(id); });
  await Promise.all(idle.filter(row => upcomingStarts.get(row.airspace_id)?.version !== row.version).map(async row => {
    try {
      const versionPage = await airspaceApi.versions(row.airspace_id, { page: 1, size: 50 });
      const starts = (versionPage.items || []).map(version => Number(version.valid_from)).filter(at => at > now);
      upcomingStarts.set(row.airspace_id, { version: row.version, at: starts.length ? Math.min(...starts) : 0 });
    } catch { /* 读不到版本历史时只靠推送信号和手动刷新 */ }
  }));
}
function scheduleBoundaryReload() {
  clearTimeout(boundaryTimer);
  boundaryTimer = 0;
  if (!pageAlive) return;
  const now = Date.now();
  const times = [];
  let stale = false;
  // 已过边界却仍是旧状态：服务端时钟略慢或恰好在边界前读的，稍后再读。
  const due = at => { if (at > now) times.push(at); else if (at) stale = true; };
  all.value.forEach(row => due(Number(row.current_version?.valid_to) || 0));
  upcomingStarts.forEach(entry => due(entry.at));
  versions.value.forEach(version => [version.valid_from, version.valid_to].forEach(at => { if (Number(at) > now) times.push(Number(at)); }));
  routeBoundaries.forEach(at => { if (at > now) times.push(at); });
  if (!stale) boundaryRechecks = 0;
  else if (boundaryRechecks < 10) { boundaryRechecks += 1; times.push(now + BOUNDARY_RECHECK_MS - BOUNDARY_GRACE_MS); }
  if (!times.length) return;
  const wait = Math.min(Math.min(...times) - now + BOUNDARY_GRACE_MS, MAX_TIMER_MS);
  boundaryTimer = setTimeout(() => { boundaryTimer = 0; realtime.trigger(['airspace', 'plan']); }, wait);
}
onUnmounted(() => { pageAlive = false; clearTimeout(boundaryTimer); });

/**
 * 各航线的版本一次取回（最多 50 条航线，一次请求），不再每条航线单独请求。
 * 没有批量接口的旧后端或读取失败时返回 null，由调用方改回逐条读取。
 */
async function loadRouteVersionsOfRoutes(routeIds) {
  if (!routeIds.length) return new Map();
  try {
    const page = await flightApi.routeVersionsOfRoutes(routeIds);
    const byRoute = new Map(routeIds.map(id => [id, []]));
    (page.items || []).forEach(version => byRoute.get(version.route_id)?.push(version));
    return byRoute;
  } catch (reason) {
    if (reason?.status === 403) throw reason;
    return null;
  }
}

/** 合法航线：只画启用的航线当前版本的中心线；没权限就整层不列。 */
async function loadRoutes() {
  try {
    const data = await flightApi.routes({ page: 1, size: 50 });
    const enabled = (data.items || []).filter(route => route.enabled !== false);
    const now = Date.now();
    const boundaries = [];
    const versionsByRoute = await loadRouteVersionsOfRoutes(enabled.map(route => route.route_id));
    const lines = await Promise.all(enabled.map(async route => {
      try {
        const versionPage = versionsByRoute?.has(route.route_id)
          ? { items: versionsByRoute.get(route.route_id) }
          : await flightApi.routeVersions(route.route_id, { page: 1, size: 20 });
        (versionPage.items || []).forEach(v => [v.valid_from, v.valid_to].forEach(at => { if (Number(at) > now) boundaries.push(Number(at)); }));
        const current = (versionPage.items || []).find(v => v.valid_from <= now && (!v.valid_to || v.valid_to > now));
        const coords = current?.centerline?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return null;
        const points = coords.map(point => [Number(point?.[0]), Number(point?.[1])]).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
        return points.length >= 2 ? { id: route.route_id, name: route.name || displayRouteNo(route.route_no), points } : null;
      } catch { return null; }
    }));
    routeLines.value = lines.filter(Boolean);
    routesAvailable.value = true;
    routeBoundaries = boundaries;
  } catch (reason) {
    routeLines.value = [];
    routesAvailable.value = reason?.status !== 403;
    routeBoundaries = [];
  }
  paintMap(false);
  scheduleBoundaryReload();
}

/* ---------- 筛选与派生 ---------- */
const districtOptions = computed(() => {
  const seen = new Map();
  all.value.forEach(row => { if (row.district_id && !seen.has(row.district_id)) seen.set(row.district_id, row.district_name || row.district_id); });
  // 有风险但尚未划空域的区县也能切换，不用空域台账限制独立风险的可见范围。
  risks.districts.forEach(row => { if (row.district_id) seen.set(row.district_id, row.name || row.district_id); });
  risks.rows.forEach(row => { if (row.district_id && !seen.has(row.district_id)) seen.set(row.district_id, row.district_name || row.district_id); });
  monitor.rows.forEach(row => { if (row.district_id && !seen.has(row.district_id)) seen.set(row.district_id, row.district_name || row.district_id); });
  return [{ label: '全市', value: '' }].concat([...seen].map(([value, label]) => ({ label, value })));
});
const filtered = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase();
  return all.value.filter(row => {
    const version = row.current_version;
    if (filters.district && row.district_id !== filters.district) return false;
    if (filters.kind && version?.kind_code !== filters.kind) return false;
    if (filters.validity === 'now' && !version) return false;
    if (filters.validity === 'off' && version) return false;
    if (keyword && !`${row.name || ''} ${row.airspace_no || ''}`.toLowerCase().includes(keyword)) return false;
    return true;
  }).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
});
const total = computed(() => filtered.value.length);
const pageRows = computed(() => filtered.value.slice((page.value - 1) * size.value, page.value * size.value));
watch([filtered, size], () => { const pages = Math.max(1, Math.ceil(total.value / size.value)); if (page.value > pages) page.value = pages; });

const counts = computed(() => ({
  total: filtered.value.length,
  active: filtered.value.filter(row => row.current_version).length,
  temporary: filtered.value.filter(row => row.current_version?.kind_code === 'TEMPORARY_CONTROL').length
}));

/** 图例：只列筛选结果里出现过的种类，点击切换显隐。 */
const legendKinds = computed(() => {
  const present = new Set(filtered.value.map(row => row.current_version?.kind_code).filter(Boolean));
  return KIND_CODES.filter(code => present.has(code)).map(code => ({ code, label: kindLabel(code), color: kindColor(code), hidden: !!hiddenKinds.value[code] }));
});
function toggleKind(code) { hiddenKinds.value = { ...hiddenKinds.value, [code]: !hiddenKinds.value[code] }; }

const mapAirspaces = computed(() => toAirspaces(filtered.value.filter(row => row.current_version && !hiddenKinds.value[row.current_version.kind_code])));

watch([mapAirspaces, showRoutes, () => riskList.riskMapRows, () => risks.activeId,
  () => riskList.targetMapRows, () => monitor.activeId, bottomTab], () => paintMap(false));
watch([() => riskList.active, bottomTab], ([active, tab]) => {
  if (!active || tab !== 'monitor') riskDetailOpen.value = false;
});
function showSelectedRisks() {
  risks.onlySelected = true;
  risks.severity = ''; risks.state = ''; risks.riskType = ''; risks.occurred = null;
  showRiskRecords();
}
function showRiskRecords() {
  bottomTab.value = 'monitor';
  nextTick(() => {
    riskSection.value?.querySelector('.risk-record-scroll')?.scrollTo({ top: 0 });
  });
}
function viewRisk(risk) {
  monitor.activeId = '';
  risks.activeId = risk.risk_id;
  bottomTab.value = 'monitor';
  if (risk.point) locateRisk(risk);
  openRiskDetail();
}
function openRiskDetail() {
  riskDetailOpen.value = true;
}
function updateRiskRecord(record) {
  const index = risks.rows.findIndex(item => item.risk_id === record.risk_id);
  if (index >= 0) risks.rows[index] = { ...risks.rows[index], ...record };
}
function inspectRiskRow(row) {
  if (row.risk) { viewRisk(row.risk); return; }
  risks.activeId = '';
  monitor.activeId = row.target.target_id;
  bottomTab.value = 'monitor';
  if (row.target?.point) locateTarget(row.target);
  openRiskDetail();
}
function locateRisk(risk) {
  if (!risk.point) return;
  monitor.activeId = '';
  risks.activeId = risk.risk_id;
  risks.showLayer = true;
  bottomTab.value = 'monitor';
  // 仅扩展相机视野以显示周边环境；风险几何仍是原始位置点。
  const [lon, lat] = risk.point;
  map?.fitTo([[lon - 0.005, lat - 0.005], [lon + 0.005, lat + 0.005]], 0.2);
  map?.draw();
}
function locateTarget(target) {
  if (!target.point) return;
  risks.activeId = '';
  monitor.activeId = target.target_id; monitor.showLayer = true; bottomTab.value = 'monitor';
  const [lon, lat] = target.point;
  map?.fitTo( [[lon - 0.005, lat - 0.005], [lon + 0.005, lat + 0.005]], 0.3);
  map?.draw();
}
function selectObjectMarker(marker) {
  if (marker.kind === 'target') { const row = riskList.rows.find(item => item.target?.target_id === marker.id); if (row) inspectRiskRow(row); }
  else { const row = riskList.riskMapRows.find(item => item.risk_id === marker.id); if (row) viewRisk(row); }
}
function refreshPage() { return Promise.all([loadAll(), loadRoutes(), risks.reload(), monitor.reload()]); }
/* 实时刷新：按变化类别只重读受影响的部分；空域详情、选中项与地图视野保留，正在查看的空域的版本历史一并更新。
   到点生效、失效没有推送信号，由上面的边界计时按同样方式触发。空域列表读取失败时抛出，由实时刷新按退避重试。 */
const realtime = useRealtimeRefresh(['airspace', 'plan', 'risk', 'target'], topics => {
  const everything = topics.includes('*');
  const tasks = [];
  if ((everything || topics.includes('airspace')) && !loading.value) tasks.push(loadAll({ quiet: true }), reloadVersions());
  if (everything || topics.includes('plan')) tasks.push(loadRoutes());
  if (everything || topics.includes('risk')) tasks.push(risks.reload());
  if (everything || topics.includes('target')) tasks.push(monitor.reload());
  return Promise.all(tasks);
}, { minIntervalMs: 1_500 });
watch(() => filters.district, district => {
  if (selected.value && district && selected.value.district_id !== district) clearDetail();
});

/* ---------- 地图 ---------- */
function paintMap(fit) {
  if (!map) return;
  clearReferenceTip();
  map.setData({ airspaces: mapAirspaces.value, devices: [], targets: [], alarms: [] });
  if (fit) {
    const points = allPoints();
    if (points.length) { map.fitTo(points, 0.12); fittedOnce = true; }
  }
  map.draw();
}
function allPoints() {
  const out = [];
  mapAirspaces.value.forEach(a => a.rings.forEach(ring => out.push(...ring)));
  if (showRoutes.value) routeLines.value.forEach(line => out.push(...line.points));
  if (bottomTab.value === 'monitor') riskList.riskMapRows.forEach(risk => out.push(risk.point));
  if (bottomTab.value === 'monitor') riskList.targetMapRows.forEach(target => out.push(target.point));
  return out;
}

function selectedPolygons() {
  return polygonRings(selected.value?.current_version?.boundary);
}

function installOverlay() {
  const drawBase = map.draw.bind(map);
  map.draw = function drawWithOverlay() {
    drawBase();
    const c = this.ctx;
    if (!c || !this.w) return;
    referenceShapes = [];
    // MapView 每帧重绘；只有视角变化才清除提示，避免悬停卡片一闪即逝。
    const camera = [this.w, this.h, ...this.px(118, 37), ...this.px(119, 38)].join(',');
    if (camera !== referenceCamera) clearReferenceTip();
    referenceCamera = camera;
    c.save();
    // 计划航线：灰色虚线，不标名——十几条航线的名字叠在一起谁也看不清，名字在飞行计划页看
    if (showRoutes.value) routeLines.value.forEach(line => {
      referenceShapes.push({ id: line.id, name: line.name, type: '合法航线',
        note: '当前启用航线的中心线。', points: line.points.map(point => this.px(...point)) });
      strokePlannedRoute(c, this, line.points, { color: PLAN_COLOR, terminals: false, arrows: false });
    });
    // 选中空域：实线加粗描边
    const polygons = selectedPolygons();
    if (polygons.length) {
      const color = kindColor(selected.value.current_version.kind_code);
      c.beginPath();
      polygons.forEach(rings => rings.forEach(ring => { ring.forEach(([lon, lat], i) => { const p = this.px(lon, lat); i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); }); c.closePath(); }));
      c.lineWidth = 3; c.strokeStyle = color; c.shadowColor = color; c.shadowBlur = 10; c.stroke(); c.shadowBlur = 0;
    }
    const markerRows = bottomTab.value === 'monitor' ? [...riskList.targetMapRows.filter(row => row.demo),
      ...riskList.riskMapRows.filter(row => ['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(row.risk_type))] : [];
    objectMarkers.value = markerRows.map(row => {
      const [x, y] = this.px(...row.point), demo = row.demo;
      return { id: demo ? row.target_id : row.risk_id, kind: demo ? 'target' : 'risk', x, y, leftward: x > this.w - 200,
        active: demo ? monitor.activeId === row.target_id : risks.activeId === row.risk_id,
        activeRisk: !demo && window.UI.abnormalActive(row),
        subtype: demo ? row.subtype : row.space_fact?.subtype_code,
        color: demo ? RISK_COLORS[demo.severity] : riskColor(row), title: demo ? row.target_no : row.space_fact?.subtype_name || row.risk_no,
        note: demo ? `${Math.round(demo.distance)} 米 · ${demo.count}${demo.unit} · 模拟` : `事件位置${row.source_mode === 'mock' ? ' · 模拟' : ''}` };
    }).filter(marker => marker.x >= 0 && marker.y >= 0 && marker.x <= this.w && marker.y <= this.h);
    // 独立风险只用发生时的可信位置快照；圆点颜色沿用服务端等级，排除项灰显。
    if (bottomTab.value === 'monitor') riskList.riskMapRows.forEach(risk => {
      if (['SPACE_OBJECT', 'FOREIGN_OBJECT', 'WEATHER'].includes(risk.risk_type)) return;
      const [x, y] = this.px(...risk.point);
      const active = risks.activeId === risk.risk_id;
      c.save();
      window.UI.applyAlarmGlow(c, risk);
      c.beginPath(); c.arc(x, y, active ? 9 : 6, 0, Math.PI * 2);
      c.fillStyle = riskColor(risk); c.fill();
      c.lineWidth = active ? 3 : 2; c.strokeStyle = '#fff'; c.stroke();
      if (active) { c.beginPath(); c.arc(x, y, 14, 0, Math.PI * 2); c.lineWidth = 2; c.strokeStyle = riskColor(risk); c.stroke(); }
      c.restore();
    });
    // 蓝色方点表示近期监测位置，不借风险颜色暗示目标危险或安全。
    if (bottomTab.value === 'monitor') riskList.targetMapRows.forEach(target => {
      if (target.demo) return;
      const [x, y] = this.px(...target.point);
      const radius = monitor.activeId === target.target_id ? 8 : 5;
      c.save();
      window.UI.applyAlarmGlow(c, { activeRisk: riskList.rows.find(row => row.target?.target_id === target.target_id)?.activeRisk === true });
      c.fillStyle = ROUTE_COLOR; c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      c.strokeStyle = '#fff'; c.lineWidth = 2; c.strokeRect(x - radius, y - radius, radius * 2, radius * 2);
      c.restore();
    });
    c.restore();
  };
}

function clearReferenceTip() { referenceTip.value = null; }
function onReferenceMove(event) {
  if (!map || event.buttons || map._dragged || !mapHost.value?.contains(event.target)
    || event.target.closest?.('.mapctl,.map-refocus,.maptip,.maplibregl-control-container')) {
    clearReferenceTip(); return;
  }
  const rect = map.cv.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const hit = hitMapReference([x, y], referenceShapes);
  if (!hit) { clearReferenceTip(); return; }
  map._hideTip(true);
  const width = Math.min(280, rect.width - 16);
  referenceTip.value = { ...hit, width,
    x: Math.max(8, Math.min(x + 16 + width > rect.width - 8 ? x - width - 16 : x + 16, rect.width - width - 8)),
    y: Math.max(8, Math.min(y + 14, rect.height - 140)) };
}

function onMapClick(event) {
  if (!map || map._dragged || Date.now() < (map._suppressClickUntil || 0)) return;
  if (event.target.closest?.('.mapctl,.map-refocus,.maptip')) return;
  const rect = map.cv.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  if (bottomTab.value === 'monitor') {
    const target = riskList.targetMapRows.slice().reverse().find(row => {
      const point = map.px(...row.point);
      return Math.hypot(point[0] - x, point[1] - y) <= 11;
    });
    if (target) { event.stopPropagation(); const row = riskList.rows.find(item => item.target?.target_id === target.target_id); if (row) inspectRiskRow(row); return; }
  }
  if (bottomTab.value !== 'monitor') return;
  const hit = riskList.riskMapRows.slice().reverse().find(risk => {
    const point = map.px(...risk.point);
    return Math.hypot(point[0] - x, point[1] - y) <= 11;
  });
  if (hit) { event.stopPropagation(); viewRisk(hit); map.draw(); }
}

function createMap() {
  if (!mapHost.value || !window.MapView) return;
  map = new window.MapView(mapHost.value, {
    zoom: 1, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false },
    drawUnderMarkers: view => weatherLayer.value?.draw(view),
    onPick: pick => {
      if (pick?.kind !== 'airspace') return;
      const row = all.value.find(item => item.airspace_id === pick.data.airspaceId);
      if (row) select(row, { fit: false });
    }
  });
  installOverlay();
  mapHost.value.addEventListener('click', onMapClick, true);
  paintMap(!fittedOnce);
}
function destroyMap() {
  clearReferenceTip(); referenceShapes = [];
  if (mapHost.value) mapHost.value.removeEventListener('click', onMapClick, true);
  if (map?.destroy) map.destroy();
  map = null;
}

/* ---------- 选中与详情 ---------- */
function clearDetail() { selected.value = null; versions.value = []; detailError.value = ''; map?.draw(); }

async function select(row, { fit = true } = {}) {
  riskDetailOpen.value = false;
  selected.value = row; versions.value = []; detailError.value = '';
  detailLoading.value = true;
  if (fit) locate();
  map?.draw();
  try {
    const versionPage = await airspaceApi.versions(row.airspace_id, { page: 1, size: 50 });
    if (selected.value?.airspace_id !== row.airspace_id) return;
    versions.value = (versionPage.items || []).slice().sort((a, b) => b.version_no - a.version_no);
    scheduleBoundaryReload();
  } catch (reason) {
    if (selected.value?.airspace_id === row.airspace_id) detailError.value = messageOf(reason);
  } finally {
    if (selected.value?.airspace_id === row.airspace_id) detailLoading.value = false;
  }
}

/** 静默重读正在查看的空域的版本历史：读到新内容再替换，读取失败保留已显示的内容。 */
async function reloadVersions() {
  const row = selected.value;
  if (!row || detailLoading.value) return;
  try {
    const versionPage = await airspaceApi.versions(row.airspace_id, { page: 1, size: 50 });
    if (selected.value?.airspace_id !== row.airspace_id) return;
    versions.value = (versionPage.items || []).slice().sort((a, b) => b.version_no - a.version_no);
    detailError.value = '';
    scheduleBoundaryReload();
  } catch { /* 保留已显示的版本历史 */ }
}

function locate() {
  const points = selectedPolygons().flat().flat();
  if (map && points.length) map.fitTo(points, 0.3);
}

const latestVersion = computed(() => versions.value[0] || null);
/** 最新一版还没到生效时间：抽屉里要说出来，区分当前规则与尚未生效的规则。 */
const pendingVersion = computed(() => latestVersion.value && latestVersion.value.valid_from > Date.now() ? latestVersion.value : null);
const rowStatus = row => row.load_error ? { text: '读取失败', cls: 't-red' }
  : row.current_version ? { text: '生效中', cls: 't-green' } : { text: '当前未生效', cls: 't-gray' };

/* ---------- 生命周期 ---------- */
onMounted(async () => {
  createMap();
  await Promise.all([loadAll(), loadRoutes()]);
});
onUnmounted(() => {
  destroyMap();
});
</script>

<template>
  <section class="view airspace-page" :class="{ 'has-detail': (riskDetailOpen && riskList.active) || selected }">
    <!-- 顶部：筛选 + 图层 + 操作 -->
    <div class="panel airspace-bar">
      <div class="toolbar">
        <div class="toolbar-fields">
          <div class="field"><label>区县</label><UControl v-model="filters.district" type="select" :options="districtOptions" :disabled="loading" size="small" /></div>
          <div class="field"><label>空域种类</label><UControl v-model="filters.kind" type="select" :options="KIND_OPTIONS" :disabled="loading" size="small" /></div>
          <div class="field"><label>空域状态</label><UControl v-model="filters.validity" type="select" :options="VALIDITY_OPTIONS" :disabled="loading" size="small" /></div>
          <div class="field"><UControl v-model="filters.keyword" placeholder="搜索名称或编号" clearable :disabled="loading" size="small" /></div>
        </div>
        <div class="toolbar-actions">
          <span class="toolbar-note">空域规则由上级下发</span>
          <button class="btn ghost" type="button" :disabled="loading || risks.loading || monitor.loading" @click="refreshPage">刷新</button>
        </div>
      </div>
    </div>

    <!-- 中部：地图 + 抽屉 -->
    <div class="airspace-stage"><h3 class="map-heading">空域位置与监测</h3>
      <div class="airspace-map-area" @mousemove="onReferenceMove" @mouseleave="clearReferenceTip" @pointerdown.capture="clearReferenceTip" @wheel.capture="clearReferenceTip">
      <div ref="mapHost" class="airspace-map"></div>
      <AirspaceObjectMarkers :markers="objectMarkers" @select="selectObjectMarker" />
      <WeatherRiskMarkers ref="weatherLayer" :risks="riskList.rows.map(row => row.risk).filter(Boolean)" :visible="bottomTab === 'monitor' && risks.showLayer" :selected-id="risks.activeId" control-target="#airspace-weather-control" control-inline @select="viewRisk" />
      <div v-if="referenceTip" class="airspace-reference-tip" role="tooltip"
        :style="{ left: `${referenceTip.x}px`, top: `${referenceTip.y}px`, width: `${referenceTip.width}px` }">
        <b>{{ referenceTip.name }}</b><span>{{ referenceTip.type }}</span><p>{{ referenceTip.note }}</p>
      </div>

      <details class="airspace-legend">
        <summary class="legend-title">图例</summary>
        <button v-for="item in legendKinds" :key="item.code" type="button" class="legend-item" :class="{ off: item.hidden }" :title="item.hidden ? '点击显示' : '点击隐藏'" @click="toggleKind(item.code)">
          <span class="sw" :style="{ borderColor: item.color, background: item.color + '33' }"></span>{{ item.label }}
        </button>
        <button v-if="routesAvailable && routeLines.length" type="button" class="legend-item" :class="{ off: !showRoutes }" @click="showRoutes = !showRoutes">
          <span class="sw ln" :style="{ borderColor: PLAN_COLOR }"></span>任务航线
        </button>
        <div v-if="!legendKinds.length && !loading" class="legend-empty">图上暂无空域</div>
        <button v-if="bottomTab === 'monitor' && monitor.canRead" type="button" class="legend-item risk-layer-toggle" :class="{ off: !monitor.showLayer }" :aria-pressed="monitor.showLayer" @click="monitor.showLayer = !monitor.showLayer"><span class="target-dot"></span>近期目标位置</button>

        <button v-if="bottomTab === 'monitor' && risks.canRead" type="button" class="legend-item risk-layer-toggle" :class="{ off: !risks.showLayer }" :aria-pressed="risks.showLayer" title="红：高/紧急；黄：中；蓝：低；灰：已排除或等级未知" @click="risks.showLayer = !risks.showLayer">
          <span class="risk-dot"></span>风险位置（发生时）
        </button>
        <span v-if="risks.canRead && risks.loading" class="legend-empty">风险读取中…</span>
        <button v-else-if="risks.error" class="linkbtn" type="button" @click="showRiskRecords">风险读取失败，查看原因</button>
        <span id="airspace-weather-control"></span>
      </details>

      <div v-if="bottomTab === 'monitor' && monitor.active && !riskDetailOpen" class="airspace-risk-tip">
        <b>{{ monitor.active.target_no || '监测目标' }}</b>
        <template v-if="monitor.active.demo">
          <span>{{ monitor.active.demo.scene.distanceLabel }} {{ Math.round(monitor.active.demo.distance) }} 米 · 海拔 {{ monitor.active.demo.altitude }} 米 · {{ monitor.active.demo.count }} {{ monitor.active.demo.unit }}</span>
          <span>{{ monitor.active.demo.horizontal }} · {{ monitor.active.demo.vertical }} · 模拟观测</span>
        </template>
        <template v-else><span>最近发现 {{ time(monitor.active.last_seen_at) }}</span><span>近期位置，不代表目标仍在场；请结合风险记录核实。</span></template>
      </div>

      <div v-if="!loading && !error && !all.length" class="airspace-map-empty">暂无空域规则，请核对上级下发数据</div>
      <div v-else-if="error" class="airspace-map-empty">{{ error }}</div>


      </div>

    </div>

    <div v-show="(riskDetailOpen && riskList.active) || selected" class="airspace-detail-slot">
      <AirspaceRiskDrawer v-model:show="riskDetailOpen" :row="riskList.active" @updated="updateRiskRecord" />
      <aside v-if="selected && !riskDetailOpen" class="airspace-drawer">
        <div class="drawer-head">
          <div class="drawer-title">
            <b :title="selected.airspace_id">{{ selected.name }}</b>
            <span class="mono" :title="selected.airspace_no">{{ displayAirspaceNo(selected.airspace_no) }} <span v-if="sourceLabel(selected)" class="tag t-amber">{{ sourceLabel(selected) }}</span></span>
          </div>
          <button type="button" class="drawer-close" aria-label="关闭" @click="clearDetail">×</button>
        </div>
        <div class="drawer-body scroll">
          <dl class="kv">
            <div class="key-fact fact-kind"><dt>种类</dt><dd><span class="tag" :class="kindTag(selected.current_version?.kind_code)">{{ selected.current_version ? kindLabel(selected.current_version.kind_code) : '当前没有生效版本' }}</span></dd></div>
            <div class="key-fact fact-altitude"><dt>高度</dt><dd>{{ altitudeText(selected.current_version) }}</dd></div>
            <div class="key-fact fact-validity"><dt>生效期</dt><dd>{{ validityText(selected.current_version) }}</dd></div>
            <dt>管理单位</dt><dd>{{ selected.owner_org_name || '未记录' }}</dd>
            <dt>所属区县</dt><dd>{{ selected.district_name || '未记录' }}</dd>
            <dt>面积</dt><dd>{{ areaText(selected.current_version) }}</dd>
            <template v-if="selected.current_version?.change_reason"><dt>划设原因</dt><dd>{{ selected.current_version.change_reason }}</dd></template>
            <dt>最近更新</dt><dd>{{ time(selected.updated_at) }}</dd>
            <template v-if="versions.length"><dt>改动次数</dt><dd>{{ versions.length }} 版</dd></template>
            <template v-if="pendingVersion"><dt>待生效</dt><dd class="pending">{{ time(pendingVersion.valid_from) }} 起改为{{ kindLabel(pendingVersion.kind_code) }}<template v-if="pendingVersion.valid_to">，{{ time(pendingVersion.valid_to) }} 结束</template></dd></template>
          </dl>
          <div v-if="selected.load_error" class="warnbox">{{ selected.load_error }}</div>
          <div v-if="detailError" class="warnbox">{{ detailError }}</div>

          <section class="drawer-risk-summary">
            <b>范围内风险记录</b>
            <span v-if="!risks.canRead">无风险查看权限</span>
            <span v-else-if="risks.loading">正在读取…</span>
            <span v-else-if="risks.error">读取失败，请在下方风险记录中查看</span>
            <span v-else-if="!risks.polygons.length">当前边界不可用，无法匹配</span>
            <template v-else>
              <span>已记录 {{ risks.inSelected.length }} 起（含边界点）</span>
              <button class="linkbtn" type="button" @click="showSelectedRisks">查看范围内风险</button>
            </template>
            <small>按当前平面范围匹配发现位置，不代表已判定侵入或超高。</small>
          </section>

          <details v-if="versions.length"><summary>版本历史</summary><dl v-for="version in versions" :key="version.airspace_version_id || version.version_no" class="kv"><dt>版本</dt><dd>{{ version.version_no }}</dd><dt>种类</dt><dd>{{ kindLabel(version.kind_code) }}</dd><dt>生效期</dt><dd>{{ validityText(version) }}</dd><dt>高度</dt><dd>{{ altitudeText(version) }}</dd><dt>变更原因</dt><dd>{{ version.change_reason || '未记录' }}</dd></dl></details>
          <div v-if="selected.current_version && !selectedPolygons().length" class="warnbox">边界数据有问题，图上未绘制。</div>
        </div>
        <div class="drawer-actions">
          <button class="btn" type="button" :disabled="!selectedPolygons().length" @click="locate">定位</button>
        </div>
      </aside>
    </div>

    <!-- 监测观测与风险记录合并为一张表，共用筛选、分页、详情与地图。 -->
    <div class="airspace-bottom-tabs">
      <div class="airspace-tabs" role="tablist" aria-label="空域信息">
      <button id="airspace-rules-tab" type="button" role="tab" :aria-selected="bottomTab === 'rules'" aria-controls="airspace-rules-panel" :class="{ on: bottomTab === 'rules' }" @click="bottomTab = 'rules'">空域列表</button>
      <button id="airspace-monitor-tab" type="button" role="tab" :aria-selected="bottomTab === 'monitor'" aria-controls="airspace-monitor-panel" :class="{ on: bottomTab === 'monitor' }" @click="bottomTab = 'monitor'">空域监测</button>
      </div>

    </div>
    <section v-show="bottomTab === 'monitor'" id="airspace-monitor-panel" role="tabpanel" aria-labelledby="airspace-monitor-tab" class="panel airspace-tab-content airspace-monitor-workspace">
      <div ref="riskSection" class="unified-risk-section"><AirspaceRiskList :list="riskList" :monitor="monitor" :risks="risks" :selected="selected" @inspect="inspectRiskRow" /></div>
    </section>
    <section v-show="bottomTab === 'rules'" id="airspace-rules-panel" role="tabpanel" aria-labelledby="airspace-rules-tab" class="airspace-tab-content">
    <UPanel :title="`<span class='rule-count count-all'>全部 <b>${counts.total}</b></span><span class='rule-count count-active'>生效中 <b>${counts.active}</b></span><span class='rule-count count-temporary'>临时管制 <b>${counts.temporary}</b></span>`" panel-style="flex:1;min-height:0" nopad class-name="airspace-list-panel">
      <div v-if="refreshError && !error" class="airspace-refresh-note" role="status">自动刷新失败（{{ refreshError }}），正在重试；下面是上次读到的空域。</div>
      <div v-if="error" class="empty">空域列表暂不可用</div>
      <div v-else-if="loading && !all.length" class="empty">正在读取空域…</div>
      <div v-else-if="!filtered.length" class="empty">没有符合条件的空域。</div>
      <div v-else class="scroll airspace-list" aria-label="空域记录列表">
        <button v-for="row in pageRows" :key="row.airspace_id" type="button" class="airspace-rule-card" :class="{ on: selected?.airspace_id === row.airspace_id }" :style="{ '--rule-color': kindAccent(row.current_version?.kind_code) }" :aria-pressed="selected?.airspace_id === row.airspace_id" @click="select(row)">
          <span class="rule-card-head"><b>{{ row.name }}</b><span class="tag" :class="rowStatus(row).cls">{{ rowStatus(row).text }}</span></span>
          <span v-if="row.airspace_no" class="rule-card-code" :title="row.airspace_no">{{ displayAirspaceNo(row.airspace_no) }}</span>
          <span v-if="row.current_version && altitudeText(row.current_version) !== '未填写'">{{ altitudeText(row.current_version) }}</span>
          <span v-if="row.current_version?.valid_from" class="rule-card-validity">{{ validityShort(row.current_version) }}</span>
          <span class="rule-card-footer">
            <span v-if="row.current_version || sourceLabel(row)" class="rule-card-tags"><span v-if="row.current_version" class="tag" :class="kindTag(row.current_version.kind_code)">{{ kindLabel(row.current_version.kind_code) }}</span><span v-if="sourceLabel(row)" class="tag t-amber">{{ sourceLabel(row) }}</span></span>
            <span class="rule-card-open">{{ selected?.airspace_id === row.airspace_id ? '正在查看' : '查看详情' }}</span>
          </span>
        </button>
      </div>
      <div class="rule-pager">
        <span>第 {{ page }} / {{ Math.max(1, Math.ceil(total / size)) }} 页</span>
        <button class="btn ghost" type="button" :disabled="page <= 1" @click="page--">上一页</button>
        <button class="btn ghost" type="button" :disabled="page >= Math.ceil(total / size)" @click="page++">下一页</button>
        <UControl v-model="size" type="select" aria-label="每页条数" :options="[10, 20, 50].map(value => ({ value, label: `${value} 条/页` }))" size="small" />
      </div>
    </UPanel>
    </section>

  </section>
</template>

<style scoped>
.airspace-page { display: grid; grid-template-columns: minmax(260px, .95fr) minmax(300px, 1.35fr) minmax(280px, 1.1fr); grid-template-rows: auto auto auto minmax(280px, 1fr) auto; grid-template-areas: "bar bar bar" "tabs tabs tabs" "filters filters filters" "records map detail" "import import import"; height: 100%; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; scrollbar-width: auto; scrollbar-color: auto; gap: 10px; }
.airspace-page::-webkit-scrollbar { width: 10px; }
.airspace-page::-webkit-scrollbar-track { background: var(--panel-2); }
.airspace-page::-webkit-scrollbar-thumb { background: var(--txt-3); border: 2px solid var(--panel-2); border-radius: 6px; }
.airspace-bar { grid-area: bar; min-width: 0; }
.airspace-bar .toolbar { border-bottom: 0; }

/* 参照飞行计划：左侧记录、中间地图、右侧详情，各栏独立滚动。 */
.airspace-stage { grid-area: map; position: relative; isolation: isolate; display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: var(--r, 8px); overflow: hidden; background: var(--surface-gradient); }
.map-heading { flex: none; margin: 0; padding: 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
.airspace-detail-slot { grid-area: detail; display: flex; min-height: 0; min-width: 0; }
.airspace-page:not(.has-detail) .airspace-stage { grid-column: 2 / -1; }
.airspace-map-area { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.airspace-reference-tip { position: absolute; z-index: 9; box-sizing: border-box; pointer-events: none; padding: 10px 12px; display: grid; gap: 4px; background: var(--surface-3); border: 1px solid var(--cyan); border-radius: 6px; color: var(--txt); font-size: 12px; box-shadow: 0 5px 18px #0003; overflow-wrap: anywhere; }
.airspace-reference-tip > span { color: var(--cyan); font-size: 11px; }
.airspace-reference-tip p { margin: 0; line-height: 1.5; }
.airspace-map { position: absolute; inset: 0; }

.airspace-legend { position: absolute; right: 12px; bottom: 12px; z-index: 6; max-height: calc(100% - 66px); max-width: 220px; overflow: auto; padding: 8px 10px; background: var(--surface-3); border: 1px solid var(--line); border-radius: 6px; backdrop-filter: none; }
.airspace-legend > .legend-item { margin-top: 4px; }
.airspace-legend > .legend-empty { display: block; margin-top: 5px; }
.airspace-legend:not([open]) > :not(summary) { display: none; }
.airspace-legend summary { cursor: pointer; }
.airspace-legend summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.legend-title { font-size: 11px; color: var(--txt-3); letter-spacing: .5px; margin-bottom: 2px; }
.legend-item { display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 2px 0; color: var(--txt-2); font-size: 12.5px; cursor: pointer; text-align: left; }
.legend-item:hover { color: var(--txt); }
.legend-item.off { opacity: .4; text-decoration: line-through; }
.legend-item .sw { width: 16px; height: 10px; border: 1.5px dashed; border-radius: 2px; flex: none; }
.legend-item .sw.ln { height: 0; border-width: 2px 0 0; background: none; border-radius: 0; }
.legend-empty { font-size: 12px; color: var(--txt-3); }
.risk-layer-toggle { margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--line); }
.risk-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red, #ff4d5e); border: 2px solid #fff; margin: 0 3px; }
.target-dot { width: 10px; height: 10px; background: var(--cyan, #22d3ee); border: 2px solid #fff; margin: 0 3px; }
.airspace-risk-tip { position: absolute; z-index: 6; left: 12px; bottom: 12px; max-width: min(420px, 48%); padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; background: var(--surface-3); border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.airspace-risk-tip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-risk-summary { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; margin-top: 10px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13px; }
.drawer-risk-summary small { color: var(--txt-3); line-height: 1.5; }
.drawer-risk-summary .linkbtn { text-align: left; }
.drawer-risk-summary > b { border-left: 3px solid var(--amber); padding-left: 8px; color: var(--txt); }
.drawer-body > details { padding: 7px 0; }
.drawer-body > details > summary { color: var(--txt-2); border-left: 3px solid var(--purple); padding-left: 8px; }
.airspace-bottom-tabs { grid-area: tabs; display: flex; gap: 6px; flex: none; border-bottom: 1px solid var(--line); }
.airspace-tabs { display: flex; gap: 6px; }
.airspace-bottom-tabs button { border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 8px 16px; color: var(--txt-3); cursor: pointer; font-size: 14px; }
.airspace-bottom-tabs button.on { color: var(--page-accent); border-bottom-color: var(--page-accent); background: color-mix(in srgb, var(--page-accent) 10%, transparent); }
.airspace-bottom-tabs span { margin-left: 5px; font-size: 12px; }
.airspace-tab-content { grid-area: records; display: flex; min-height: 0; min-width: 0; flex-direction: column; overflow: hidden; }
#airspace-monitor-panel, .unified-risk-section { display: contents; }
#airspace-rules-panel :deep(.panel) { min-width: 0; }
.rule-pager { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-top: 1px solid var(--line); font-size: 11px; color: var(--txt-3); }
.rule-pager .btn { padding: 4px 7px; font-size: 11px; }
.rule-pager :deep(.n-select) { width: 95px; margin-left: auto; }

.airspace-map-empty { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 6; padding: 6px 14px; border-radius: 20px; font-size: 12.5px; background: var(--surface-3); border: 1px solid var(--line); color: var(--txt-2); white-space: nowrap; }
.airspace-map-empty { top: 50%; transform: translate(-50%, -50%); }
.airspace-refresh-note { flex: none; margin: 8px 12px 0; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; line-height: 1.6; color: var(--amber); overflow-wrap: anywhere; }

.airspace-drawer { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: var(--surface-gradient); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.drawer-head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 12px 8px; border-top: 2px solid var(--blue); border-bottom: 1px solid var(--line-2); }
.drawer-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.drawer-title b { font-size: 14.5px; color: var(--txt); white-space: normal; overflow-wrap: anywhere; }
.drawer-title .mono { font-size: 12px; color: var(--txt-3); }
.drawer-close { background: none; border: 0; color: var(--txt-3); font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
.drawer-close:hover { color: var(--txt); }
.drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; }
.drawer-body .kv { gap: 7px 12px; font-size: 13px; }
.drawer-body .key-fact { --fact-color: var(--blue); grid-column: 1 / -1; display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--fact-color) 22%, transparent); border-left: 2px solid var(--fact-color); border-radius: 6px; background: color-mix(in srgb, var(--fact-color) 5%, transparent); }
.drawer-body .fact-altitude { --fact-color: var(--purple); }
.drawer-body .fact-validity { --fact-color: var(--cyan); }
.key-fact dt { color: var(--fact-color); }
.key-fact dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.key-fact .tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.drawer-body .pending { color: #ffd07a; }
.drawer-actions { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line-2); }
.sect-title { margin: 12px 0 6px; font-size: 12px; color: var(--txt-3); letter-spacing: .5px; }
.linkbtn { background: none; border: 0; color: var(--blue); cursor: pointer; padding: 0; font-size: 12.5px; }
.linkbtn:hover { text-decoration: underline; }

.airspace-list { overflow: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.airspace-rule-card { display: grid; gap: 5px; flex: none; width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--rule-color, var(--line)); border-radius: 8px; background: var(--panel); color: var(--txt-2); font: inherit; font-size: 12px; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.airspace-rule-card.on { border-color: var(--cyan); box-shadow: inset 2px 0 var(--cyan); }
.airspace-rule-card:focus-visible { outline: 2px solid var(--cyan); outline-offset: -2px; }
.rule-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; color: var(--txt); }.rule-card-head b { min-width: 0; font-size: 14px; line-height: 1.6; }.rule-card-head .tag { flex: none; font-size: 10px; padding: 2px 7px; }
.rule-card-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.rule-card-open { margin-left: auto; color: var(--blue); font-size: 11px; }
.on .rule-card-open { color: var(--cyan); }
.rule-card-code { color: var(--txt-3); font-size: 11px; }
.rule-card-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.rule-card-tags .tag { font-size: 11px; padding: 2px 8px; }
.rule-card-validity { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.rule-card-validity::before { content: ''; width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--cyan); }
.airspace-list-panel :deep(.ph h3) { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-weight: 400; }
.airspace-list-panel :deep(.ph h3::before) { display: none; }
.airspace-list-panel :deep(.rule-count) { --count-color: var(--blue); display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border: 1px solid color-mix(in srgb, var(--count-color) 32%, transparent); border-radius: 5px; color: var(--count-color); background: color-mix(in srgb, var(--count-color) 9%, transparent); font-size: 11px; }
.airspace-list-panel :deep(.count-active) { --count-color: var(--green); }
.airspace-list-panel :deep(.count-temporary) { --count-color: var(--purple); }
.airspace-list-panel :deep(.rule-count b) { font-family: Bahnschrift, sans-serif; font-size: 15px; }
.airspace-import { grid-area: import; flex: none; max-height: 40%; display: flex; flex-direction: column; }
.airspace-import-list { overflow: auto; }
.airspace-import-issue { margin-left: 6px; color: var(--txt-2); font-size: 12.5px; }

@media (max-width: 1200px) {
  .airspace-page { grid-template-columns: minmax(220px, .9fr) minmax(0, 1.4fr); grid-template-rows: auto auto auto minmax(280px, 1fr) auto auto; grid-template-areas: "bar bar" "tabs tabs" "filters filters" "records map" "detail detail" "import import"; }
  .airspace-detail-slot:not(:empty) { min-height: 280px; max-height: 420px; }
}
@media (max-width: 720px) {
  .airspace-page { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto minmax(240px, auto) 320px auto auto; grid-template-areas: "bar" "tabs" "filters" "records" "map" "detail" "import"; }
  .airspace-page:not(.has-detail) .airspace-stage { grid-column: 1; }
  .airspace-bottom-tabs { flex-wrap: wrap; }
  .drawer-actions { flex-wrap: wrap; }
}

</style>
