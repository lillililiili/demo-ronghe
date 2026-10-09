<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { NButton, NConfigProvider, NDataTable, NIcon } from 'naive-ui';
import {
  BriefcaseOutline,
  DocumentAttachOutline,
  ExitOutline,
  NotificationsOutline,
  RadioOutline,
  ScanOutline
} from '@vicons/ionicons5';
import { createThemeOverrides, dateZhCN, theme, zhCN } from '@/ui/theme.js';
import { getDashboardSnapshot } from '@/services/dashboardApi.js';
import { apiRequest } from '@/services/apiClient.js';
import { attachTracks } from '@/services/mapTracks.js';
import { airspaceKindMeta, targetIsCurrent } from '@/services/situationData.js';
import { ALARM_TYPE_LABEL, LEGALITY_LABEL, OBJECT_TYPE_LABEL, SEVERITY_LABEL, labelOf, targetTypeLabel } from '@/ui/labels.js';
import BigScreenBottomStats from './BigScreenBottomStats.vue';

const themeOverrides = createThemeOverrides();
const clock = ref('');
const viewportHeight = ref(window.innerHeight);
const trendEl = ref(null);
const targetChartEl = ref(null);
const mapEl = ref(null);
const loading = ref(true);
const error = ref('');
const snapshot = ref(null);
// 航迹 30 秒内复用（与改造前大屏 30 秒轮询的航迹新鲜度一致）；目标当前位置仍随每次快照实时更新。
const TRACK_MAX_AGE_MS = 30_000;
const trackCache = new Map();
const SIDE_MIN_INTERVAL_MS = 30_000;
let sideLoadedAt = 0;
const operationsStats = ref({ state: 'LOADING', data: null });
const targetTypes = computed(() => {
  const detail = operationsStats.value;
  if (detail.state !== 'AVAILABLE') return detail;
  const status = detail.data?.availability?.by_type?.status;
  if (status !== 'AVAILABLE') return { state: status === 'FORBIDDEN' ? status : 'UNAVAILABLE', data: null };
  return Array.isArray(detail.data.by_type) && detail.data.by_type.every(row => countValid(row.value))
    ? detail : { state: 'UNAVAILABLE', data: null };
});
const deviceTypes = ref({ state: 'LOADING', data: null });

let clockTimer = null;
let resizeTimer = null;
let map = null;
let refreshTimer = null;
let disposed = false;
let version = 0;
let detailController = null;

/* 告警等级和告警页同一套写法：紧急就写“紧急”，颜色和“高”一样是红色（2026-10-08 新-2 第 4 点）。 */
const alarmColor = { 紧急: 'var(--red)', 高: 'var(--red)', 中: 'var(--amber)', 低: 'var(--cyan)' };
const SEVERITY_ZH = SEVERITY_LABEL;
const STATE_ZH = {
  PENDING_VERIFICATION: '待核实', CONFIRMED: '告警已确认',
  FALSE_POSITIVE: '误报'
};
const AIRSPACE_KIND = {
  PROHIBITED: { type: '禁飞空域', color: '#ff4d5e' },
  RESTRICTED: { type: '限制空域', color: '#a97bff' },
  HEIGHT_LIMIT: { type: '限高空域', color: '#ffb020' },
  ALTITUDE_LIMIT: { type: '限高空域', color: '#ffb020' },
  SUITABLE: { type: '适飞空域', color: '#2fd06e' }
};
const GRADE_ZH = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' };

function formatClock(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
function formatTime(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dash(value) { return value == null ? '—' : value; }
function avail(key) { return snapshot.value?.availability?.[key] === 'AVAILABLE'; }
function dataState(key) {
  if (loading.value) return '正在加载';
  if (error.value) return '数据暂不可用';
  const state = snapshot.value?.availability?.[key];
  if (state === 'FORBIDDEN') return '无读取权限';
  if (state && state !== 'AVAILABLE') return '数据暂不可用';
  return '暂无数据';
}

const rowLimit = computed(() => viewportHeight.value < 760 ? 4 : viewportHeight.value < 900 ? 5 : viewportHeight.value < 1000 ? 6 : 8);

const detailMessage = detail => ({ LOADING: '正在加载', FORBIDDEN: '无读取权限', UNAVAILABLE: '数据暂不可用' }[detail.state] || '暂无数据');
const countValid = value => Number.isSafeInteger(value) && value >= 0;
// 汇总来自完整聚合接口，超过四类时合并尾部，不能用地图样本冒充全量分布。
function compactGroups(items, fields, sortField) {
  if (!Array.isArray(items) || items.some(item => fields.some(field => !countValid(item[field])))) return [];
  const sorted = [...items].sort((a, b) => b[sortField] - a[sortField]);
  if (sorted.length <= 4) return sorted;
  return [...sorted.slice(0, 3), sorted.slice(3).reduce((other, item) => {
    fields.forEach(field => { other[field] += item[field]; });
    return other;
  }, { name: '其余类型', ...Object.fromEntries(fields.map(field => [field, 0])) })];
}
const targetTypeRows = computed(() => compactGroups(targetTypes.value.data?.by_type, ['value'], 'value'));
const deviceTypeRows = computed(() => compactGroups(deviceTypes.value.data?.by_type, ['total', 'online'], 'total'));
const typeMaximum = computed(() => Math.max(1, ...targetTypeRows.value.map(item => item.value)));
const percent = (part, total) => total > 0 ? Math.min(100, part * 100 / total) : 0;
const hologram = name => `/assets/img/bigscreen/holograms/${name}.png`;
// 配图仅表达已知分类；未知或合并分类使用通用图，不推断设备属性。
function typeArtwork(name, kind) {
  const key = String(name || '').trim().toUpperCase();
  const artwork = kind === 'target'
    ? ({ '鸟': 'bird', '鸟类': 'bird', BIRD: 'bird', '无人机': 'uav', UAV: 'uav' })[key]
    : ({ '雷达': 'radar', RADAR: 'radar', '光电': 'optical', EO: 'optical', TDOA: 'antenna', AOA: 'antenna' })[key];
  return artwork ? hologram(artwork) : `/assets/img/business/${kind === 'target' ? 'unknown' : 'unknown-device'}.svg`;
}

function loadSideDetails(data) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  const read = async (destination, key, path, validate) => {
    const available = data.availability?.[key];
    if (available !== 'AVAILABLE' || !path) {
      destination.value = { state: available === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAVAILABLE', data: null };
      return;
    }
    // 重读时保留已有数据，避免每次推送触发的刷新都闪一下“加载中”。
    if (destination.value.state !== 'AVAILABLE') destination.value = { state: 'LOADING', data: null };
    try {
      const result = await apiRequest(path, { signal: controller.signal, dedupe: false });
      if (disposed || controller !== detailController) return;
      const state = validate(result);
      destination.value = { state, data: state === 'AVAILABLE' ? result : null };
    } catch (e) {
      if (!disposed && controller === detailController) destination.value = { state: e.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE', data: null };
    }
  };
  const { from, to } = data.trend || {};
  // 大屏不显示有效监测时长和已观测里程，不让后台为它逐点计算（同一份 7 天报表里最慢的一块），与运行统计页同一做法。
  const query = from && to ? new URLSearchParams({ from, to, include_observations: 'false' }).toString() : null;
  // 设备类型与快照的设备数同一统计口径（statistics_scope）；今日已完成计划随快照一起给出（flights.completed）。
  void Promise.all([
    read(operationsStats, 'stats', query ? `/stats/operations?${query}` : null, result =>
      result?.availability ? 'AVAILABLE' : 'UNAVAILABLE'),
    read(deviceTypes, 'devices', '/device-monitor/overview?statistics_scope=true', result =>
      Array.isArray(result?.by_type) && result.by_type.every(row => countValid(row.total) && countValid(row.online) && row.online <= row.total) ? 'AVAILABLE' : 'UNAVAILABLE')
  ]).finally(() => {
    clearTimeout(timeout);
    if (detailController === controller) detailController = null;
  });
}

/* 统计口径（ZT-17；2026-10-07 起设备模拟器的数据也算）：大屏上的计数与"运行统计"同一口径，
   由后台决定计入哪些来源（statistics_source_modes）：允许模拟的环境算真实设备和设备模拟器，
   正式环境只算真实设备；系统自带的演示样例都不算。其中来自设备模拟器的条数要写出来，免得被当成现场真实数据。 */
const simulatorCounted = computed(() => (snapshot.value?.statistics_source_modes || []).includes('replay'));
const SIMULATOR_FIELDS = [['感知', 'sensed_today'], ['告警', 'alarms_today'], ['任务', 'flights_today'], ['设备', 'devices']];
const kpiScope = computed(() => {
  if (!snapshot.value?.statistics_source_modes) return '';
  if (!simulatorCounted.value) return '统计口径与运行统计一致：只算真实设备的数据';
  const included = snapshot.value?.simulated_included || {};
  const parts = SIMULATOR_FIELDS
    .filter(([, field]) => Number.isFinite(included[field]) && included[field] > 0)
    .map(([label, field]) => `${label} ${included[field]}`);
  const text = '统计口径与运行统计一致：真实设备和设备模拟器的数据都算，系统自带的演示样例不算';
  return parts.length ? `${text}；其中来自设备模拟器：${parts.join(' · ')}` : text;
});
const SOURCE_SCOPE_LABEL = { live: '真实设备', mixed: '真实设备 + 设备模拟器', replay: '设备模拟器' };
const scopeLabel = row => SOURCE_SCOPE_LABEL[row?.source_mode] || '';
const SIMULATED_TREND_NOTE = ' · 含设备模拟器的数据';

const kpis = computed(() => {
  const k = snapshot.value?.kpis || {};
  const d = snapshot.value?.devices;
  return [
    { label: '今日感知目标', value: dash(k.sensed_today), color: 'var(--blue)', image: hologram('uav') },
    { label: '今日告警', value: dash(k.alarms_today), color: 'var(--cyan)', icon: NotificationsOutline },
    { label: '待研判目标', value: dash(k.pending_assessment), color: 'var(--amber)', icon: ScanOutline },
    { label: '设备总数', value: dash(d?.total), color: 'var(--blue)', image: hologram('radar') },
    { label: '在线设备', value: dash(d?.online), color: 'var(--cyan)', image: hologram('antenna') }
  ];
});

const flightMetrics = computed(() => [
  { label: '今日任务', value: snapshot.value?.flights?.today, image: hologram('flight-plan') },
  { label: '执行中', value: snapshot.value?.flights?.executing, image: hologram('uav') },
  { label: '已完成', value: snapshot.value?.flights?.completed, image: hologram('flight-complete') }
]);

// 每日统计可能包含同一目标跨日出现，累计值不宣称跨日去重。
function sevenDayTotal(field) {
  const days = snapshot.value?.trend?.days;
  if (!Array.isArray(days) || days.length !== 7 ||
      !days.every(day => Number.isSafeInteger(day?.[field]) && day[field] >= 0)) return null;
  return days.reduce((sum, day) => sum + day[field], 0);
}
const trendTotals = computed(() => [
  { label: '近7日感知累计', value: sevenDayTotal('total'), tone: 'cyan' },
  { label: '近7日非法累计', value: sevenDayTotal('illegal'), tone: 'red' }
]);

const closureItems = computed(() => {
  const c = snapshot.value?.closure || {};
  return [
    { label: '待核实告警', value: dash(c.pending_verification), tone: 'warn', icon: NotificationsOutline },
    { label: '告警已确认', value: dash(c.confirmed_blocked), tone: 'bad', icon: RadioOutline },
    { label: '交接待办', value: dash(c.pending_handoffs), tone: 'warn', icon: BriefcaseOutline },
    { label: '证据台账', value: dash(c.evidence_files ?? c.evidence_total), tone: 'good', icon: DocumentAttachOutline }
  ];
});

// 风险分档是今日感知目标的分档：要能读目标，还要能读风险（ZT-17 复测 2）。
const targetSummary = computed(() => {
  if (!snapshot.value?.target_risk) return dataState(avail('targets') ? 'risks' : 'targets');
  const simulated = snapshot.value?.simulated_included?.sensed_today;
  return `今日${Number.isFinite(simulated) && simulated > 0 ? SIMULATED_TREND_NOTE : ''}`;
});
const deviceSummary = computed(() => (snapshot.value?.devices ? scopeLabel(snapshot.value.devices) : dataState('devices')));
const flightSummary = computed(() => {
  if (!snapshot.value?.flights) return dataState('flights');
  const simulated = snapshot.value?.simulated_included?.flights_today;
  return Number.isFinite(simulated) && simulated > 0 ? `其中设备模拟器 ${simulated} 个` : '';
});
const alarmSummary = computed(() => {
  if (!avail('alarms')) return dataState('alarms');
  return alarmRows.value.length ? `最新 ${alarmRows.value.length} 条` : '';
});
const deviceLegend = computed(() => snapshot.value?.devices || { offline: '—', abnormal: '—', alarm: '—' });

const alarmRows = computed(() => (snapshot.value?.alarms?.items || []).slice(0, rowLimit.value).map(row => ({
  id: row.alarm_id,
  time: formatTime(row.received_at),
  type: labelOf(ALARM_TYPE_LABEL, row.alarm_type, row.alarm_type),
  level: SEVERITY_ZH[row.severity] || row.severity || '—',
  status: STATE_ZH[row.state] || row.state || '—'
})));

const mono = text => h('span', { class: 'mono' }, text);
const colored = (text, color) => h('span', { style: { color } }, text);

const alarmColumns = [
  { title: '时间', key: 'time', width: 86, render: row => mono(row.time) },
  { title: '告警类型', key: 'type', render: row => h('span', { class: 'table-text', tabindex: 0 }, row.type) },
  { title: '等级', key: 'level', width: 100, render: row => colored(`● ${row.level}`, alarmColor[row.level] || 'var(--txt-2)') },
  /* 这一列是核实结论（待核实、告警已确认、误报），处置进度在告警页看；叫“核实状态”免得看成处置进度（新-2 第 5 点）。 */
  { title: '核实状态', key: 'status', width: 112 }
];

/* 重点目标异物风险态势（ZT-17 复测 2）：今日感知目标按各自最新的风险等级分档，与运行统计选今天时的"各异物风险等级分布"
   同一份取数、同一套分档，五档相加就是今日感知目标；超高风险与高风险同为红色，与运行统计一致。
   原先按研判等级抽样 100 条，与运行统计对不上。这里的风险是目标附近空中异物这类风险的等级，不是告警等级，
   标题写明“异物风险”，免得和告警的紧急、高、中、低混在一起（2026-10-08 新-2 第 4 点）。 */
const riskItems = computed(() => {
  const r = snapshot.value?.target_risk || {};
  return [
    { name: '超高风险', value: r.critical, tone: 'red' },
    { name: '高风险', value: r.high, tone: 'red' },
    { name: '中风险', value: r.medium, tone: 'amber' },
    { name: '低风险', value: r.low, tone: 'blue' },
    { name: '未识别', value: r.ungraded, tone: 'gray' }
  ];
});
const riskTotal = computed(() => snapshot.value?.target_risk ? riskItems.value.reduce((sum, r) => sum + (r.value || 0), 0) : null);

function renderCharts() {
  if (!window.CH) return;
  const days = snapshot.value?.trend?.days || [];
  const trend = window.CH.line(trendEl.value, {
    x: days.map(x => x.md),
    series: [
      { name: '发现目标', data: days.map(x => x.total), color: window.CH.C.cyan, area: true, smooth: false },
      { name: '非法目标', data: days.map(x => x.illegal), color: window.CH.C.red, smooth: false }
    ]
  });
  trend?.setOption({ tooltip: { show: false }, legend: { selectedMode: false }, grid: { left: 32, right: 20, top: 30, bottom: 30 }, series: [{ silent: true, symbol: 'none', lineStyle: { width: 1.5 } }, { silent: true, symbol: 'none', lineStyle: { width: 1.5 } }] });
  window.CH.make(targetChartEl.value, {
    animation: false, tooltip: { show: false },
    series: [{ type: 'pie', silent: true, selectedMode: false,
      radius: ['64%', '87%'], center: ['50%', '50%'], startAngle: 90,
      padAngle: 3, itemStyle: { borderRadius: 5 },
      emptyCircleStyle: { color: getComputedStyle(document.documentElement).getPropertyValue('--bs-risk-ring').trim() },
      label: { show: false }, labelLine: { show: false },
      data: riskItems.value.filter(r => r.value > 0).map(r => ({ name: r.name, value: r.value, itemStyle: { color: window.CH.C[r.tone] } }))
    }]
  });
}

function ringCentroid(ring) {
  let x = 0, y = 0;
  ring.forEach(p => { x += Number(p[0]); y += Number(p[1]); });
  return { lon: x / ring.length, lat: y / ring.length };
}

/* 一片空域可能由多个多边形组成、每个多边形可能带孔洞（决策 16-3）：
   逐个多边形出一条，rings 含全部环交给 map.js 按 even-odd 填充。
   layer 取共享的种类映射：map.js 只认数据层给的 layer，缺了整片不画——
   种类认不出时宁可不画，也不猜它属于禁飞还是限高。 */
function mapAirspaces(items) {
  const out = [];
  (items || []).forEach(a => {
    const polygons = a.boundary?.coordinates;
    if (!Array.isArray(polygons)) return;
    const kind = AIRSPACE_KIND[a.kind_code] || { type: a.kind_code || '空域', color: '#8ca0be' };
    const layer = airspaceKindMeta(a.kind_code)?.layer || null;
    const limit = [a.min_altitude_m, a.max_altitude_m].filter(v => v != null).join('–');
    const no = a.airspace_no || a.airspace_id;
    polygons.forEach((polygon, index) => {
      if (!Array.isArray(polygon)) return;
      const rings = polygon.filter(ring => Array.isArray(ring) && ring.length)
        .map(ring => ring.map(p => [Number(p[0]), Number(p[1])]));
      if (!rings.length) return;
      out.push({
        id: polygons.length > 1 ? `${no}#${index + 1}` : no, name: a.name, type: kind.type, color: kind.color, layer,
        rings, center: ringCentroid(rings[0]),
        limitTx: limit ? `${limit} m AMSL` : '—', unit: '—'
      });
    });
  });
  return out;
}

function mapDevices(items) {
  return (items || []).map(d => ({
    id: d.device_id, name: d.name, type: d.device_type_name, channel: d.channel,
    typeCode: d.device_type_code || '',
    connectivity: d.connectivity, statusCode: d.connectivity,
    health_code: d.health_code || 'UNKNOWN',
    activeRisk: d.active_risk === true || d.activeRisk === true,
    abnormal: d.abnormal === true || d.has_alarm === true,
    status: ({ ONLINE: '在线', OFFLINE: '离线', ABNORMAL: '异常', UNKNOWN: '未知' })[d.connectivity] || d.connectivity || '未知',
    alarm: !!d.has_alarm, lon: Number(d.longitude), lat: Number(d.latitude)
  })).filter(d => Number.isFinite(d.lon) && Number.isFinite(d.lat));
}

function mapTargets(items, alarmItems = []) {
  return (items || []).map(t => {
    const lon = Number(t.longitude), lat = Number(t.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return {
      id: t.target_no || t.target_id,
      targetId: t.target_id,
      // 当前同一目标告警决定提示；历史最高风险/旧研判不等于活动告警。
      activeRisk: (alarmItems || []).some(alarm => alarm.target_id === t.target_id && window.UI.abnormalActive(alarm)),
      statusCode: t.status_code || t.track_status?.status || '',
      freshness: t.freshness || '', stale: t.stale === true, historical: t.historical === true,
      observedAt: t.observed_at, mapExpiresAt: t.map_expires_at,
      type: t.object_type_code === 'UAV' ? '无人机' : labelOf(OBJECT_TYPE_LABEL, t.object_type_code, t.object_type_code || '目标'),
      subtype: targetTypeLabel(t.subtype, t.object_type_code),
      subtypeCode: t.subtype, objectTypeCode: t.object_type_code,
      lon, lat, posValid: true, track: [],
      alt: t.altitude_amsl_m, speed: t.speed_mps, heading: t.heading_deg,
      legal: labelOf(LEGALITY_LABEL, t.legal_status, t.legal_status),
      risk: GRADE_ZH[t.grade] || t.grade,
      fusedConf: t.fusion_confidence == null ? null : Math.round(Number(t.fusion_confidence) * 100)
    };
  }).filter(target => target && targetIsCurrent(target));
}

function mapAlarms(items) {
  return (items || []).map(a => ({
    id: a.alarm_id, targetId: a.target_id, state: a.state, eventState: a.state,
    type: labelOf(ALARM_TYPE_LABEL, a.alarm_type, a.alarm_type),
    level: SEVERITY_ZH[a.severity] || a.severity,
    time: formatTime(a.received_at),
    status: STATE_ZH[a.state] || a.state,
    district: ''
  }));
}

function renderMap() {
  if (!mapEl.value || disposed) return;
  if (!map) map = new window.MapView(mapEl.value, { zoom: 1.06, maxDev: 46, maxAlarm: 8, legend: false });
  const layer = snapshot.value?.map || {};
  const airspaces = mapAirspaces(layer.airspaces);
  const devices = mapDevices(layer.devices);
  const targets = mapTargets(layer.targets, layer.alarms);
  const targetIds = new Set(targets.map(target => target.targetId));
  const alarms = mapAlarms((layer.alarms || []).filter(alarm => targetIds.has(alarm.target_id)));
  map.setData({ airspaces, devices, targets, alarms });
  const currentMap = map, currentVersion = version;
  attachTracks(targets, { cache: trackCache, maxAgeMs: TRACK_MAX_AGE_MS }).then(() => {
    if (!disposed && map === currentMap && currentVersion === version) {
      const current = targets.filter(target => targetIsCurrent(target));
      const ids = new Set(current.map(target => target.targetId));
      map.setData({ airspaces, devices, targets: current, alarms: alarms.filter(alarm => ids.has(alarm.targetId)) });
    }
  });
}

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { viewportHeight.value = window.innerHeight; }, 120);
}

/* rethrow：实时刷新触发的重读失败时抛出，由实时刷新按 2、4、8 秒……退避重试，不必等 30 秒兜底。 */
async function load({ rethrow = false } = {}) {
  clearTimeout(refreshTimer);
  const currentVersion = ++version;
  loading.value = !snapshot.value;
  error.value = '';
  try {
    const data = await getDashboardSnapshot();
    if (disposed || currentVersion !== version) return;
    snapshot.value = data;
    await nextTick();
    if (disposed || currentVersion !== version) return;
    renderCharts();
    renderMap();
    // 侧栏统计不必跟着每次推送重读：至少间隔 30 秒，与改造前的轮询节奏一致。
    if (Date.now() - sideLoadedAt >= SIDE_MIN_INTERVAL_MS) { sideLoadedAt = Date.now(); loadSideDetails(data); }
  } catch (e) {
    if (disposed || currentVersion !== version) return;
    snapshot.value = null;
    detailController?.abort();
    sideLoadedAt = 0;
    operationsStats.value = deviceTypes.value = { state: 'UNAVAILABLE', data: null };
    error.value = e.message || '大屏数据加载失败';
    await nextTick();
    if (!disposed) { renderCharts(); renderMap(); }
    if (rethrow) throw e;
  } finally {
    if (!disposed) { loading.value = false; refreshTimer = window.setTimeout(load, 30000); }
  }
}

// 业务数据变化后最多每 5 秒重读一次快照；30 秒定时器保留为推送不可用时的兜底。
useRealtimeRefresh(['alarm', 'target', 'device', 'risk', 'plan', 'airspace', 'punishment', 'disposal'], () => load({ rethrow: true }), { minIntervalMs: 5_000 });

onMounted(() => {
  clock.value = formatClock(new Date());
  clockTimer = window.setInterval(() => {
    clock.value = formatClock(new Date());
    if (!map) return;
    const targets = (map.data.targets || []).filter(target => targetIsCurrent(target));
    if (targets.length === map.data.targets.length) return;
    const ids = new Set(targets.map(target => target.targetId));
    map.setData({ targets, alarms: (map.data.alarms || []).filter(alarm => ids.has(alarm.targetId)) });
  }, 1000);
  window.addEventListener('resize', handleResize);
  load();
});

onBeforeUnmount(() => {
  disposed = true;
  version++;
  detailController?.abort();
  clearTimeout(refreshTimer);
  clearInterval(clockTimer);
  clearTimeout(resizeTimer);
  window.removeEventListener('resize', handleResize);
  if (map) map.destroy();
  map = null;
  window.CH?.disposeAll?.();
});
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN" style="display: contents">
    <div class="bs-root bs-display-only">
      <header class="bs-hdr">
        <div class="bs-hdr-l"><img src="/assets/img/brand/logo-mark.png" alt="" width="30" height="30">无人机融合感知与低空安全管理平台</div>
        <div class="bs-hdr-t"><i class="bs-wing" aria-hidden="true"></i><span>低空安全数据大屏</span><i class="bs-wing r" aria-hidden="true"></i></div>
        <div class="bs-hdr-r"><span class="bs-clock">{{ clock }}</span><n-button class="bs-exit" tag="a" href="#/situation" size="small" ghost aria-label="返回系统" title="退出大屏，返回业务系统"><n-icon :component="ExitOutline" aria-hidden="true"/></n-button></div>
      </header>
      <div v-if="error" class="bs-banner" role="alert">{{ error }} · 将自动重新读取</div>
      <div v-else-if="loading" class="bs-banner">正在加载大屏数据</div>
      <div class="bs-grid">
        <aside class="bs-col bs-col-left">
          <section class="panel">
            <div class="ph"><h3>感知与违法趋势</h3><span class="sub">近 7 日{{ snapshot?.trend?.simulated ? SIMULATED_TREND_NOTE : '' }}</span></div>
            <div class="pb bs-trend-body">
              <div class="bs-trend-totals"><div v-for="item in trendTotals" :key="item.label"><span>{{ item.label }}</span><b :style="{ color: 'var(--' + item.tone + ')' }">{{ dash(item.value) }}</b><small>按日汇总</small></div></div>
              <div class="bs-trend-plot"><div ref="trendEl" class="bs-chart" role="img" aria-label="近七日感知目标与非法目标趋势"></div><span v-if="!snapshot?.trend?.days?.length" class="bs-chart-empty">{{ dataState('stats') }}</span></div>
            </div>
          </section>
          <section class="panel" data-module="target-dynamics">
            <div class="ph"><h3>重点目标异物风险态势</h3><span v-if="targetSummary" class="sub">{{ targetSummary }}</span></div>
            <div class="pb bs-risk-body">
              <div class="bs-risk-pie"><div ref="targetChartEl" class="bs-panel-chart" role="img" aria-label="重点目标风险圆环分布"></div><div class="bs-risk-center"><b>{{ dash(riskTotal) }}</b><span>{{ riskTotal === 0 ? '今日暂无目标' : '今日目标' }}</span></div></div>
              <div class="bs-risk-values"><div v-for="item in riskItems" :key="item.name"><i :style="{ background: 'var(--' + item.tone + ')' }"></i><span>{{ item.name }}</span><b>{{ dash(item.value) }}</b><small>个</small></div></div>
            </div>
          </section>
          <section class="panel bs-types-panel">
            <div class="ph"><h3>目标类型分布</h3><span class="sub">近7日{{ targetTypes.data?.simulated ? SIMULATED_TREND_NOTE : '' }}</span></div>
            <div class="pb bs-type-body">
              <div class="bs-section-note">按首次发现时间统计新增目标</div>
              <div v-if="targetTypeRows.length" class="bs-type-list">
                <div v-for="(item, index) in targetTypeRows" :key="item.name" class="bs-type-row">
                  <div class="bs-type-art"><img :src="typeArtwork(item.name, 'target')" alt="" aria-hidden="true"><span class="bs-rank">{{ String(index + 1).padStart(2, '0') }}</span></div><span class="bs-type-name">{{ item.name }}</span><b>{{ item.value }}<small> 个</small></b>
                  <div class="bs-type-track"><i :style="{ width: percent(item.value, typeMaximum) + '%' }"></i></div>
                </div>
              </div>
              <div v-else class="bs-detail-empty">{{ detailMessage(targetTypes) }}</div>
            </div>
          </section>
          <section class="panel bs-closure-panel">
            <div class="ph"><h3>待处理事项</h3></div>
            <div class="pb bs-action-grid">
              <div v-for="item in closureItems" :key="item.label" class="bs-action-card" :class="'is-' + item.tone">
                <div class="bs-icon-orbit"><n-icon class="bs-action-icon" :component="item.icon" aria-hidden="true"/></div>
                <b>{{ item.value }}</b><span>{{ item.label }}</span>
              </div>
            </div>
          </section>
        </aside>
        <main class="bs-mid">
          <div class="bs-kpis"><div v-for="item in kpis" :key="item.label" class="kpi" :style="{ '--kpi-tone': item.color }"><div class="bs-kpi-art" aria-hidden="true"><img v-if="item.image" :src="item.image" alt=""><div v-else class="bs-kpi-symbol"><n-icon :component="item.icon"/></div></div><div class="lb">{{ item.label }}</div><div class="v">{{ item.value }}</div></div></div>
          <p v-if="kpiScope" class="bs-kpi-scope">{{ kpiScope }}</p>
          <div class="bs-map-shell" role="region" aria-label="东营全域融合态势地图，可拖动和缩放，展示目标、设备、空域与航迹"><div id="bsMap" ref="mapEl" class="bs-map"></div></div>
          <BigScreenBottomStats :detail="operationsStats"/>
        </main>
        <aside class="bs-col bs-col-right">
          <section class="panel">
            <div class="ph bs-device-heading"><h3>设备健康与异常</h3><span class="sub">{{ deviceSummary }}</span></div>
            <div class="pb bs-health-body">
              <div class="bs-health-metrics">
                <div class="bs-health-metric"><b>{{ dash(snapshot?.devices?.online_rate) }}<small>%</small></b><div class="bs-stat-base" aria-hidden="true"></div><span>设备在线率</span></div>
                <div class="bs-health-metric"><b>{{ dash(deviceLegend.offline) }}</b><div class="bs-stat-base" aria-hidden="true"></div><span><i class="is-offline"></i>离线</span></div>
                <div class="bs-health-metric"><b>{{ dash(deviceLegend.abnormal) }}</b><div class="bs-stat-base" aria-hidden="true"></div><span><i class="is-abnormal"></i>异常</span></div>
                <div class="bs-health-metric"><b>{{ dash(deviceLegend.alarm) }}</b><div class="bs-stat-base" aria-hidden="true"></div><span><i class="is-alarm"></i>告警</span></div>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="ph"><h3>飞行监管态势</h3><span v-if="flightSummary" class="sub">{{ flightSummary }}</span></div>
            <div class="pb bs-flight-body">
              <div class="bs-flight-metrics">
                <div v-for="item in flightMetrics" :key="item.label" class="bs-flight-metric">
                  <img :src="item.image" alt="" aria-hidden="true">
                  <span>{{ item.label }}</span>
                  <b>{{ dash(item.value) }}</b>
                  <small v-if="item.note">{{ item.note }}</small>
                </div>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="ph bs-device-heading"><h3>设备类型与在线情况</h3><span v-if="deviceTypes.data && scopeLabel(deviceTypes.data)" class="sub">{{ scopeLabel(deviceTypes.data) }}</span></div>
            <div class="pb bs-device-types-body">
              <div class="bs-device-type-head"><span>设备类型</span><span>在线设备 / 总数</span></div>
              <div v-if="deviceTypeRows.length" class="bs-device-type-list">
                <div v-for="item in deviceTypeRows" :key="item.name" class="bs-device-type-row">
                  <img class="bs-device-art" :src="typeArtwork(item.name, 'device')" alt="" aria-hidden="true"><span>{{ item.name }}</span><b>{{ item.online }}<small> / {{ item.total }}</small></b>
                </div>
              </div>
              <div v-else class="bs-detail-empty">{{ detailMessage(deviceTypes) }}</div>
            </div>
          </section>
          <section class="panel bs-alarms-panel">
            <div class="ph"><h3>实时告警</h3><span v-if="alarmSummary" class="sub">{{ alarmSummary }}</span></div>
            <div class="pb bs-table-body"><n-data-table class="bs-naive-table" :columns="alarmColumns" :data="alarmRows" :pagination="false" :bordered="false" :single-line="true" table-layout="fixed" size="small"/></div>
          </section>
        </aside>
      </div>
    </div>
  </n-config-provider>
</template>
