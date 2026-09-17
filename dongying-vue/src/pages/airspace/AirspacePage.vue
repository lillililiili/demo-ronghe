<script setup>
/* 空域管理：选区查看近期监测目标、历史风险与上级空域规则。
   目标位置和风险发现快照分图层展示，不由前端推导入侵、现场解除或整片空域安全。
   空域及临时管制区由上级下发，本页只读展示；既有数据包导入用于对接前的数据加载。
   接口模式读不到就显示原因；模拟演示使用独立样例，不生成服务端业务记录。 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { airspaceApi } from '@/services/airspaceApi.js';
import { flightApi } from '@/services/flightApi.js';
import { strokePlannedRoute } from '@/services/positionMap.js';
import { airspaceKindMeta, polygonRings, toAirspaces } from '@/services/situationData.js';
import { openFormModal } from '@/ui/formModal.js';
import { closeModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { hasPermission } from '@/services/accessControl.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPanel from '@/components/UPanel.vue';
import UControl from '@/components/form/UControl.vue';
import AirspaceRiskList from './AirspaceRiskList.vue';
import AirspaceRiskDrawer from './AirspaceRiskDrawer.vue';
import { useAirspaceRiskList } from './useAirspaceRiskList.js';
import { useAirspaceRisks } from './useAirspaceRisks.js';
import { useAirspaceMonitor } from './useAirspaceMonitor.js';
import AirspaceObjectMarkers from './AirspaceObjectMarkers.vue';
import { DEMO_DISTRICT } from './airspaceMonitorDemo.js';
import { hitMapReference, REFERENCE_NOTES } from './airspaceReferenceHover.js';
import { drawObjectRisk } from '@/pages/flights/objectRiskMap.js';
import {
  AIRSPACE_KIND_LABEL, AIRSPACE_KIND_TAG, ALTITUDE_DATUM_LABEL,
  IMPORT_ISSUE_LABEL, IMPORT_STATUS_LABEL, labelOf
} from '@/ui/labels.js';

usePageChrome('airspace');

/* ---------- 常量 ---------- */
const KIND_CODES = ['PROHIBITED', 'RESTRICTED', 'ALTITUDE_LIMIT', 'PERMITTED', 'TEMPORARY_CONTROL'];
const KIND_OPTIONS = [{ label: '全部种类', value: '' }].concat(KIND_CODES.map(value => ({ label: AIRSPACE_KIND_LABEL[value], value })));
const VALIDITY_OPTIONS = [{ label: '全部', value: '' }, { label: '当前生效', value: 'now' }, { label: '当前未生效', value: 'off' }];
const ROUTE_COLOR = '#22d3ee'; // 监测位置与模拟参考颜色
const PLAN_COLOR = '#8ca0a8'; // 计划几何统一灰色
const PAGE_MAX = 100;
// 用户确认仅从本页日常列表移除的测试空域；服务端版本和历史研判引用继续保留。
const OMITTED_TEST_AIRSPACE_IDS = new Set([
  'e404332c-9d6f-4f03-8def-8c0e3720db31', // 重启自检临时管制区 · 自检-临管-24153
  '1fc27dfe-bb41-4051-bc8c-602157c2c95f', // 测试临时管制区 · 临管-2026-001
  'seed-stage3-airspace-prohibited' // 禁止演示空域 · 空域-001
]);

/* ---------- 状态 ---------- */
const all = ref([]);                // 空域详情（含 current_version），一次读全
const routeLines = ref([]);         // 合法航线中心线 [{ id, name, points }]
const routesAvailable = ref(true);  // 无 route:read 时整层不画、图例不列
const loading = ref(false), error = ref('');
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
const busy = ref(false);
const importPreview = ref(null);
const mapHost = ref(null);
const objectMarkers = ref([]);
const referenceTip = ref(null);
let referenceShapes = [];
let referenceCamera = '';
let map = null;
let fittedOnce = false;
const riskSection = ref(null);

const canManage = computed(() => hasPermission('airspace:manage'));
const manageBlockedNote = '需要「维护空域」权限，请联系管理员开通';

/* ---------- 文案 ---------- */
function time(value) { return value == null ? '' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function day(value) { return value == null ? '' : new Date(value).toLocaleDateString('zh-CN'); }
function kindLabel(code) { return labelOf(AIRSPACE_KIND_LABEL, code, '未知种类'); }
function kindTag(code) { return AIRSPACE_KIND_TAG[code] || 't-gray'; }
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
async function loadAll() {
  loading.value = true; error.value = '';
  try {
    const first = await airspaceApi.list({ page: 1, size: PAGE_MAX });
    let items = first.items || [];
    const pages = Math.ceil((first.total || 0) / PAGE_MAX);
    for (let p = 2; p <= pages; p++) items = items.concat((await airspaceApi.list({ page: p, size: PAGE_MAX })).items || []);
    items = items.filter(item => !OMITTED_TEST_AIRSPACE_IDS.has(item.airspace_id));
    // 单片详情读不到（例如服务端判版本重叠）不能让它从台账上消失：保留清单行，标出原因。
    const details = await Promise.all(items.map(item => airspaceApi.detail(item.airspace_id)
      .catch(reason => ({ ...item, current_version: null, load_error: reason?.code === 'VERSION_AMBIGUOUS' ? '版本区间重叠，服务端拒绝读取' : messageOf(reason) }))));
    all.value = details;
    if (selected.value) {
      const refreshed = all.value.find(row => row.airspace_id === selected.value.airspace_id);
      if (refreshed) selected.value = refreshed; else clearDetail();
    }
  } catch (reason) {
    all.value = []; clearDetail();
    error.value = messageOf(reason);
  } finally { loading.value = false; }
  await nextTick();
  paintMap(!fittedOnce);
}

/** 合法航线：只画启用的航线当前版本的中心线；没权限就整层不列。 */
async function loadRoutes() {
  try {
    const data = await flightApi.routes({ page: 1, size: 50 });
    const enabled = (data.items || []).filter(route => route.enabled !== false);
    const now = Date.now();
    const lines = await Promise.all(enabled.map(async route => {
      try {
        const versionPage = await flightApi.routeVersions(route.route_id, { page: 1, size: 20 });
        const current = (versionPage.items || []).find(v => v.valid_from <= now && (!v.valid_to || v.valid_to > now));
        const coords = current?.centerline?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return null;
        const points = coords.map(point => [Number(point?.[0]), Number(point?.[1])]).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
        return points.length >= 2 ? { id: route.route_id, name: route.name || route.route_no, points } : null;
      } catch { return null; }
    }));
    routeLines.value = lines.filter(Boolean);
    routesAvailable.value = true;
  } catch (reason) {
    routeLines.value = [];
    routesAvailable.value = reason?.status !== 403;
  }
  paintMap(false);
}

/* ---------- 筛选与派生 ---------- */
const districtOptions = computed(() => {
  const seen = new Map();
  all.value.forEach(row => { if (row.district_id && !seen.has(row.district_id)) seen.set(row.district_id, row.district_name || row.district_id); });
  // 有风险但尚未划空域的区县也能切换，不用空域台账限制独立风险的可见范围。
  risks.districts.forEach(row => { if (row.district_id) seen.set(row.district_id, row.name || row.district_id); });
  risks.rows.forEach(row => { if (row.district_id && !seen.has(row.district_id)) seen.set(row.district_id, row.district_name || row.district_id); });
  monitor.rows.forEach(row => { if (row.district_id && !seen.has(row.district_id)) seen.set(row.district_id, row.district_name || row.district_id); });
  if (monitor.isDemo) seen.set(DEMO_DISTRICT, '模拟场景区域');
  return [{ label: '全市', value: '' }].concat([...seen].map(([value, label]) => ({ label, value })));
});
const orgOptions = computed(() => {
  const seen = new Map();
  all.value.forEach(row => { if (row.owner_org_id && !seen.has(row.owner_org_id)) seen.set(row.owner_org_id, row.owner_org_name || row.owner_org_id); });
  return [...seen].map(([value, label]) => ({ label, value }));
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
  () => riskList.targetMapRows, () => monitor.activeId, () => monitor.showHeat, bottomTab], () => paintMap(false));
watch([() => riskList.active, bottomTab], ([active, tab]) => {
  if (!active || tab !== 'monitor') riskDetailOpen.value = false;
});
watch([() => monitor.scene, () => monitor.mode], () => {
  if (!monitor.isDemo && filters.district === DEMO_DISTRICT) filters.district = '';
  nextTick(() => paintMap(true));
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
  map?.fitTo(target.demo ? [...target.demo.scene.geometry, ...target.demo.trail.map(p => [p.lon, p.lat])]
    : [[lon - 0.005, lat - 0.005], [lon + 0.005, lat + 0.005]], 0.3);
  map?.draw();
}
function selectObjectMarker(marker) {
  if (marker.kind === 'target') { const row = riskList.rows.find(item => item.target?.target_id === marker.id); if (row) inspectRiskRow(row); }
  else { const row = riskList.riskMapRows.find(item => item.risk_id === marker.id); if (row) viewRisk(row); }
}
function refreshPage() { return Promise.all([loadAll(), loadRoutes(), risks.reload(), monitor.reload()]); }
watch(() => filters.district, district => {
  if (selected.value && district && selected.value.district_id !== district) clearDetail();
});

/* ---------- 地图 ---------- */
function paintMap(fit) {
  if (!map) return;
  clearReferenceTip();
  map.setData({ airspaces: mapAirspaces.value, devices: [], targets: [], alarms: [] });
  if (fit) {
    const points = bottomTab.value === 'monitor' && monitor.isDemo && riskList.targetMapRows.length
      ? riskList.targetMapRows.flatMap(row => [row.point, ...row.demo.scene.geometry]) : allPoints();
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
    if (bottomTab.value === 'monitor' && monitor.isDemo && monitor.showLayer) drawDemoOverlay(c, this);
    const markerRows = bottomTab.value === 'monitor' ? [...riskList.targetMapRows.filter(row => row.demo),
      ...riskList.riskMapRows.filter(row => ['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(row.risk_type))] : [];
    objectMarkers.value = markerRows.map(row => {
      const [x, y] = this.px(...row.point), demo = row.demo;
      return { id: demo ? row.target_id : row.risk_id, kind: demo ? 'target' : 'risk', x, y, leftward: x > this.w - 200,
        active: demo ? monitor.activeId === row.target_id : risks.activeId === row.risk_id,
        subtype: demo ? row.subtype : row.space_fact?.subtype_code,
        color: demo ? RISK_COLORS[demo.severity] : riskColor(row), title: demo ? row.target_no : row.space_fact?.subtype_name || row.risk_no,
        note: demo ? `${Math.round(demo.distance)} 米 · ${demo.count}${demo.unit} · 模拟` : `事件位置${row.source_mode === 'mock' ? ' · 模拟' : ''}` };
    }).filter(marker => marker.x >= 0 && marker.y >= 0 && marker.x <= this.w && marker.y <= this.h);
    // 独立风险只用发生时的可信位置快照；圆点颜色沿用服务端等级，排除项灰显。
    if (bottomTab.value === 'monitor') riskList.riskMapRows.forEach(risk => {
      if (['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.risk_type)) return;
      const [x, y] = this.px(...risk.point);
      const active = risks.activeId === risk.risk_id;
      c.beginPath(); c.arc(x, y, active ? 9 : 6, 0, Math.PI * 2);
      c.fillStyle = riskColor(risk); c.fill();
      c.lineWidth = active ? 3 : 2; c.strokeStyle = '#fff'; c.stroke();
      if (active) { c.beginPath(); c.arc(x, y, 14, 0, Math.PI * 2); c.lineWidth = 2; c.strokeStyle = riskColor(risk); c.stroke(); }
    });
    // 蓝色方点表示近期监测位置，不借风险颜色暗示目标危险或安全。
    if (bottomTab.value === 'monitor') riskList.targetMapRows.forEach(target => {
      if (target.demo) return;
      const [x, y] = this.px(...target.point);
      const radius = monitor.activeId === target.target_id ? 8 : 5;
      c.fillStyle = ROUTE_COLOR; c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      c.strokeStyle = '#fff'; c.lineWidth = 2; c.strokeRect(x - radius, y - radius, radius * 2, radius * 2);
    });
    c.restore();
  };
}

function drawDemoOverlay(ctx, view) {
  const rows = riskList.targetMapRows;
  const scenes = [...new Map(rows.map(row => [row.demo.scene.id, row.demo.scene])).values()];
  scenes.forEach(scene => {
    const points = scene.geometry.map(p => view.px(...p));
    ctx.strokeStyle = ROUTE_COLOR; ctx.fillStyle = '#0d2635'; ctx.lineWidth = 2;
    ctx.beginPath();
    if (scene.id === 'route') {
      strokePlannedRoute(ctx, view, scene.geometry, { color: PLAN_COLOR, terminals: false });
    } else if (points.length > 1) points.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p));
    else if (scene.id === 'dock') { window.UI.drawBusinessIcon(ctx, 'nest', ...points[0], 36); }
    else { ctx.arc(...points[0], 7, 0, Math.PI * 2); ctx.fill(); }
    if (scene.kind === 'polygon') { ctx.closePath(); ctx.fillStyle = 'rgba(34,211,238,.10)'; ctx.fill(); ctx.setLineDash([6, 4]); }
    if (scene.id !== 'route') ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const labelX = points[0][0] + 12, labelY = points[0][1] - 10;
    ctx.fillStyle = '#143648'; ctx.fillText(scene.name, labelX, labelY);
    referenceShapes.push({ id: scene.id, name: scene.name, type: `${scene.label} · 模拟参考`,
      note: REFERENCE_NOTES[scene.id], points, polygon: scene.kind === 'polygon',
      labelBox: [labelX - 3, labelY - 14, labelX + ctx.measureText(scene.name).width + 3, labelY + 4] });
  });
  const active = monitor.active?.demo;
  const geometry = active?.scene.geometry;
  drawObjectRisk(ctx, view, { snapshot: monitor.active ? { lon: monitor.active.point[0], lat: monitor.active.point[1] } : null,
    trail: active?.trail || [], trailIndex: (active?.trail.length || 1) - 1, showTrail: !!active,
    heatPoints: rows.map(row => ({ lon: row.point[0], lat: row.point[1] })), showHeat: monitor.showHeat,
    route: geometry?.length === 1 ? [geometry[0], geometry[0]] : geometry, corridorWidth: null,
    color: RISK_COLORS[active?.severity] || ROUTE_COLOR });
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
  } catch (reason) {
    if (selected.value?.airspace_id === row.airspace_id) detailError.value = messageOf(reason);
  } finally {
    if (selected.value?.airspace_id === row.airspace_id) detailLoading.value = false;
  }
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

function newKey() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function orgField(key, label) {
  return orgOptions.value.length
    ? { key, label, type: 'select', required: true, options: orgOptions.value }
    : { key, label, required: true, placeholder: '机构标识' };
}
function districtField(key, label) {
  const options = districtOptions.value.slice(1);
  return options.length
    ? { key, label, type: 'select', required: true, options }
    : { key, label, required: true, placeholder: '区域标识' };
}

/* ---------- 加载数据包（沿用导入批次：解析 → 预览 → 确认/放弃） ---------- */
function pickFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.geojson,application/geo+json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => fillTextarea(String(reader.result || ''));
    reader.onerror = () => toast('文件读取失败，请改用粘贴。', 'err');
    reader.readAsText(file);
  });
  input.click();
}
function fillTextarea(text) {
  const area = document.querySelector('.nv-modal textarea, .n-modal textarea, .modal textarea');
  if (!area) { toast('没有找到文件内容输入框，请改用粘贴。', 'err'); return; }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(area, text); else area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.dispatchEvent(new Event('change', { bubbles: true }));
  toast('文件内容已填入。', 'ok');
}
function onDocumentClick(event) {
  if (event.target?.closest?.('[data-airspace-pick]')) { event.preventDefault(); pickFile(); }
}

function openImport() {
  if (!canManage.value) return;
  const key = newKey();
  openFormModal({
    title: '加载空域数据包',
    notice: '先解析文件里的每一片空域并列出问题，确认后才写入；已有的规则不会被覆盖。',
    fields: [
      { key: 'picker', label: '数据包文件', type: 'html', html: '<button type="button" class="btn" data-airspace-pick>选择文件</button>' },
      { key: 'geojson', label: '文件内容', type: 'textarea', required: true, placeholder: '选择文件后自动填入，也可以直接粘贴' },
      orgField('owner_org_id', '默认管理单位'),
      districtField('district_id', '默认所属区县'),
      { key: 'kind_code', label: '默认种类', type: 'select', options: [{ label: '按文件内容', value: '' }].concat(KIND_OPTIONS.slice(1)) },
      { key: 'valid_from', label: '默认生效时间', type: 'datetime' }
    ],
    initial: { kind_code: '', owner_org_id: orgOptions.value[0]?.value || '', district_id: districtOptions.value[1]?.value || '' },
    confirmText: '解析并预览',
    validate: values => { try { JSON.parse(values.geojson); } catch { return '内容不是合法的 JSON'; } return ''; },
    onSubmit: async values => {
      if (busy.value) return;
      busy.value = true;
      try {
        const body = { geojson: values.geojson, owner_org_id: String(values.owner_org_id).trim(), district_id: String(values.district_id).trim() };
        const defaults = {};
        if (values.kind_code) defaults.kind_code = values.kind_code;
        if (values.valid_from) defaults.valid_from = new Date(values.valid_from).getTime();
        if (Object.keys(defaults).length) body.defaults = defaults;
        const batch = await airspaceApi.stageImport(body, key);
        closeModal();
        importPreview.value = batch;
        toast(`已解析 ${batch.feature_count} 片，其中 ${batch.accepted_count} 片可加载。`, 'ok');
      } catch (reason) {
        toast(writeMessage(reason), 'err');
      } finally { busy.value = false; }
    }
  });
}

async function decideImport(action) {
  const batch = importPreview.value;
  if (!batch || busy.value) return;
  busy.value = true;
  const key = newKey();
  try {
    const body = { expected_version: batch.version };
    const result = action === 'confirm'
      ? await airspaceApi.confirmImport(batch.batch_id, body, key)
      : await airspaceApi.discardImport(batch.batch_id, body, key);
    importPreview.value = null;
    toast(action === 'confirm' ? `已加载 ${result.created_airspaces} 片空域。` : '已放弃这个数据包。', 'ok');
    if (action === 'confirm') { fittedOnce = false; await loadAll(); }
  } catch (reason) {
    toast(writeMessage(reason), 'err');
    try { importPreview.value = await airspaceApi.importBatch(batch.batch_id); } catch { importPreview.value = null; }
  } finally { busy.value = false; }
}

function writeMessage(reason) {
  const code = reason?.code;
  if (code === 'VERSION_OVERLAP') return '生效时间必须晚于当前版本，请调整后重试。';
  if (code === 'INVALID_VALIDITY') return '结束时间必须晚于开始时间。';
  if (code === 'INVALID_GEOJSON') return '无法识别文件中的空域边界，请检查文件格式。';
  if (code === 'IMPORT_TOO_LARGE') return '数据包过大，请拆分后再加载。';
  if (code === 'IMPORT_ALREADY_DECIDED') return '这个数据包已经处理过了。';
  if (code === 'VERSION_CONFLICT') return '这片空域刚被其他人修改，已为你刷新。';
  if (code === 'IDEMPOTENCY_REPLAY') return '该操作已提交过，请查看最新结果。';
  if (code === 'DUPLICATE_AIRSPACE_NO' || reason?.status === 409) return reason?.message || '编号已存在，请换一个。';
  if (reason?.status === 403) return manageBlockedNote;
  return reason?.message || '操作失败，请稍后重试。';
}

function issueLabel(code) { return labelOf(IMPORT_ISSUE_LABEL, code, code || ''); }

/* ---------- 生命周期 ---------- */
onMounted(async () => {
  document.addEventListener('click', onDocumentClick);
  createMap();
  await Promise.all([loadAll(), loadRoutes()]);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
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
          <span class="toolbar-note">临时管制区由上级下发</span>
          <button v-if="canManage" class="btn" type="button" :disabled="busy || loading" @click="openImport">加载数据包</button>
          <button class="btn ghost" type="button" :disabled="loading || risks.loading || monitor.loading" @click="refreshPage">刷新</button>
        </div>
      </div>
    </div>

    <!-- 中部：地图 + 抽屉 -->
    <div class="airspace-stage"><h3 class="map-heading">空域位置与监测</h3>
      <div class="airspace-map-area" @mousemove="onReferenceMove" @mouseleave="clearReferenceTip" @pointerdown.capture="clearReferenceTip" @wheel.capture="clearReferenceTip">
      <div ref="mapHost" class="airspace-map"></div>
      <AirspaceObjectMarkers :markers="objectMarkers" @select="selectObjectMarker" />
      <div v-if="referenceTip" class="airspace-reference-tip" role="tooltip"
        :style="{ left: `${referenceTip.x}px`, top: `${referenceTip.y}px`, width: `${referenceTip.width}px` }">
        <b>{{ referenceTip.name }}</b><span>{{ referenceTip.type }}</span><p>{{ referenceTip.note }}</p>
      </div>

      <details class="airspace-legend">
        <summary class="legend-title">图例{{ bottomTab === 'monitor' && monitor.isDemo ? ' · 模拟场景' : '' }}</summary>
        <button v-for="item in legendKinds" :key="item.code" type="button" class="legend-item" :class="{ off: item.hidden }" :title="item.hidden ? '点击显示' : '点击隐藏'" @click="toggleKind(item.code)">
          <span class="sw" :style="{ borderColor: item.color, background: item.color + '33' }"></span>{{ item.label }}
        </button>
        <button v-if="routesAvailable && routeLines.length" type="button" class="legend-item" :class="{ off: !showRoutes }" @click="showRoutes = !showRoutes">
          <span class="sw ln" :style="{ borderColor: PLAN_COLOR }"></span>计划航线
        </button>
        <div v-if="!legendKinds.length && !loading" class="legend-empty">图上暂无空域</div>
        <button v-if="bottomTab === 'monitor' && monitor.canRead" type="button" class="legend-item risk-layer-toggle" :class="{ off: !monitor.showLayer }" :aria-pressed="monitor.showLayer" @click="monitor.showLayer = !monitor.showLayer"><span class="target-dot"></span>近期目标位置</button>
        <template v-if="bottomTab === 'monitor' && monitor.isDemo && monitor.canRead">
          <button type="button" class="legend-item" :aria-pressed="monitor.showHeat" @click="monitor.showHeat = !monitor.showHeat">{{ monitor.showHeat ? '隐藏目标热区' : '显示目标热区' }}</button>
          <span class="legend-empty">模拟等级：红色高、黄色中<br>紫色：所选目标轨迹<br>热区表示目标组位置，不代表数量</span>
        </template>
        <button v-if="bottomTab === 'monitor' && risks.canRead" type="button" class="legend-item risk-layer-toggle" :class="{ off: !risks.showLayer }" :aria-pressed="risks.showLayer" title="红：高/紧急；黄：中；蓝：低；灰：已排除或等级未知" @click="risks.showLayer = !risks.showLayer">
          <span class="risk-dot"></span>风险位置（发生时）
        </button>
        <span v-if="risks.canRead && risks.loading" class="legend-empty">风险读取中…</span>
        <button v-else-if="risks.error" class="linkbtn" type="button" @click="showRiskRecords">风险读取失败，查看原因</button>
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
            <span class="mono">{{ selected.airspace_no }}</span>
          </div>
          <button type="button" class="drawer-close" aria-label="关闭" @click="clearDetail">×</button>
        </div>
        <div class="drawer-body scroll">
          <dl class="kv">
            <dt>种类</dt><dd><span class="tag" :class="kindTag(selected.current_version?.kind_code)">{{ selected.current_version ? kindLabel(selected.current_version.kind_code) : '当前没有生效版本' }}</span></dd>
            <dt>高度</dt><dd>{{ altitudeText(selected.current_version) }}</dd>
            <dt>生效期</dt><dd>{{ validityText(selected.current_version) }}</dd>
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

          <section class="drawer-response-plan" aria-label="本空域处置预案">
            <div><b>处置预案</b><span class="tag t-amber">关联信息待接入</span></div>
            <p>暂时无法查看本空域采用的预案，也无法确认预案是否生效。</p>
            <details :key="selected.airspace_id">
              <summary>预案在哪里配置</summary>
              <p>预案由后台管理端统一配置、发布并关联空域；配置与关联查询能力尚待接入。</p>
              <p>本页查看适用预案；合法性研判查看触发依据；告警事件查看飞手短信、电话录音通知、现场情况和反制授权。</p>
            </details>
          </section>

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

          <div v-if="selected.current_version && !selectedPolygons().length" class="warnbox">边界数据有问题，图上未绘制。</div>
        </div>
        <div class="drawer-actions">
          <button class="btn" type="button" :disabled="!selectedPolygons().length" @click="locate">定位</button>
          <span class="toolbar-note">规则变更由上级下发</span>
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
    <UPanel title="空域列表" :sub="`共 ${counts.total} 条 · 生效中 ${counts.active} · 临时管制 ${counts.temporary}`" panel-style="flex:1;min-height:0" nopad class-name="airspace-list-panel">
      <div v-if="error" class="empty">{{ error }}</div>
      <div v-else-if="loading && !all.length" class="empty">正在读取空域…</div>
      <div v-else-if="!filtered.length" class="empty">没有符合条件的空域。</div>
      <div v-else class="scroll airspace-list" aria-label="空域记录列表">
        <button v-for="row in pageRows" :key="row.airspace_id" type="button" class="airspace-rule-card" :class="{ on: selected?.airspace_id === row.airspace_id }" :aria-pressed="selected?.airspace_id === row.airspace_id" @click="select(row)">
          <span class="rule-card-head"><b>{{ row.name }}</b><span class="tag" :class="rowStatus(row).cls">{{ rowStatus(row).text }}</span></span>
          <span>{{ row.airspace_no }} · {{ row.current_version ? kindLabel(row.current_version.kind_code) : '当前没有生效版本' }}</span>
          <span>{{ altitudeText(row.current_version) }}</span>
          <span>{{ validityShort(row.current_version) }}</span>
          <span class="rule-card-open">{{ selected?.airspace_id === row.airspace_id ? '正在查看' : '查看详情' }}</span>
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

    <div v-if="importPreview" class="panel airspace-import">
      <div class="ph">
        <h3>数据包预览 · {{ labelOf(IMPORT_STATUS_LABEL, importPreview.status) }}</h3>
        <p>共 {{ importPreview.feature_count }} 片，其中 {{ importPreview.accepted_count }} 片可加载；确认后才会写入。</p>
      </div>
      <div class="scroll airspace-import-list">
        <table class="tb">
          <thead><tr><th>序号</th><th>名称</th><th>编号</th><th>种类</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="item in importPreview.items" :key="item.item_id">
              <td>{{ item.seq }}</td>
              <td>{{ item.name || '—' }}</td>
              <td class="mono">{{ item.airspace_no || '—' }}</td>
              <td>{{ item.kind_code ? kindLabel(item.kind_code) : '—' }}</td>
              <td>
                <span v-if="item.accepted" class="tag t-green">可加载</span>
                <template v-else>
                  <span class="tag t-red">不可加载</span>
                  <span v-for="issue in item.issues" :key="issue.reason_code" class="airspace-import-issue">{{ issueLabel(issue.reason_code) }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="detail-actions">
        <button class="btn pri" type="button" :disabled="busy || !importPreview.accepted_count" @click="decideImport('confirm')">确认加载</button>
        <button class="btn" type="button" :disabled="busy" @click="decideImport('discard')">放弃</button>
      </div>
    </div>
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
.airspace-stage { grid-area: map; position: relative; isolation: isolate; display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: var(--r, 8px); overflow: hidden; background: var(--panel); }
.map-heading { flex: none; margin: 0; padding: 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
.airspace-detail-slot { grid-area: detail; display: flex; min-height: 0; min-width: 0; }
.airspace-page:not(.has-detail) .airspace-stage { grid-column: 2 / -1; }
.airspace-map-area { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.airspace-reference-tip { position: absolute; z-index: 9; box-sizing: border-box; pointer-events: none; padding: 10px 12px; display: grid; gap: 4px; background: rgba(7,18,45,.96); border: 1px solid var(--cyan); border-radius: 6px; color: var(--txt); font-size: 12px; box-shadow: 0 5px 18px #0003; overflow-wrap: anywhere; }
.airspace-reference-tip > span { color: var(--cyan); font-size: 11px; }
.airspace-reference-tip p { margin: 0; line-height: 1.5; }
.airspace-map { position: absolute; inset: 0; }

.airspace-legend { position: absolute; right: 12px; bottom: 12px; z-index: 6; max-height: calc(100% - 66px); max-width: 220px; overflow: auto; padding: 8px 10px; background: rgba(7,18,45,.92); border: 1px solid var(--line); border-radius: 6px; backdrop-filter: blur(3px); }
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
.airspace-risk-tip { position: absolute; z-index: 6; left: 12px; bottom: 12px; max-width: min(420px, 48%); padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; background: rgba(7,18,45,.96); border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.airspace-risk-tip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-risk-summary { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; margin-top: 10px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13px; }
.drawer-risk-summary small { color: var(--txt-3); line-height: 1.5; }
.drawer-risk-summary .linkbtn { text-align: left; }
.drawer-response-plan { margin-top: 14px; padding: 14px 0; border-top: 1px solid var(--line); font-size: 13px; overflow-wrap: anywhere; }
.drawer-response-plan > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.drawer-response-plan p { margin: 8px 0; line-height: 1.65; color: var(--txt-2); }
.drawer-response-plan summary { cursor: pointer; color: var(--cyan); }
.drawer-response-plan summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
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

.airspace-map-empty { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 6; padding: 6px 14px; border-radius: 20px; font-size: 12.5px; background: rgba(7,18,45,.92); border: 1px solid var(--line); color: var(--txt-2); white-space: nowrap; }
.airspace-map-empty { top: 50%; transform: translate(-50%, -50%); }

.airspace-drawer { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.drawer-head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 12px 8px; border-bottom: 1px solid var(--line-2); }
.drawer-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.drawer-title b { font-size: 14.5px; color: var(--txt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-title .mono { font-size: 12px; color: var(--txt-3); }
.drawer-close { background: none; border: 0; color: var(--txt-3); font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
.drawer-close:hover { color: var(--txt); }
.drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; }
.drawer-body .kv { gap: 7px 12px; font-size: 13px; }
.drawer-body .pending { color: #ffd07a; }
.drawer-actions { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line-2); }
.sect-title { margin: 12px 0 6px; font-size: 12px; color: var(--txt-3); letter-spacing: .5px; }
.linkbtn { background: none; border: 0; color: var(--blue); cursor: pointer; padding: 0; font-size: 12.5px; }
.linkbtn:hover { text-decoration: underline; }

.airspace-list { overflow: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.airspace-rule-card { display: grid; gap: 7px; flex: none; width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-1); color: var(--txt-2); font: inherit; font-size: 12px; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.airspace-rule-card.on { border-color: var(--page-accent); box-shadow: inset 3px 0 var(--page-accent); background: color-mix(in srgb, var(--page-accent) 9%, var(--surface-1)); }
.airspace-rule-card:focus-visible { outline: 2px solid var(--cyan); outline-offset: -2px; }
.rule-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; color: var(--txt); }.rule-card-head b { min-width: 0; }.rule-card-head .tag { flex: none; }
.rule-card-open { color: var(--page-accent); font-size: 11px; }
.airspace-import { grid-area: import; flex: none; max-height: 40%; display: flex; flex-direction: column; }
.airspace-import-list { overflow: auto; }
.airspace-import-issue { margin-left: 6px; color: var(--txt-2); font-size: 12.5px; }

</style>
