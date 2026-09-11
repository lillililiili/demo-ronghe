<script setup>
/* 空域与航线规则页（阶段 9 执行者 1）。
   数据全部来自服务端只读/写接口，失败按各自区块显示原因，不回退演示数据。
   空域版本是接替式的：新版本生效时会把上一版关闭到同一时刻，页面的版本时间线如实展示这一点。 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { airspaceApi } from '@/services/airspaceApi.js';
import { flightApi } from '@/services/flightApi.js';
import { openFormModal } from '@/ui/formModal.js';
import { closeModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { hasPermission } from '@/services/accessControl.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPanel from '@/components/UPanel.vue';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';
import {
  AIRSPACE_DIFF_FIELD_LABEL, AIRSPACE_KIND_COLOR, AIRSPACE_KIND_LABEL, AIRSPACE_KIND_TAG, AIRSPACE_ORIGIN_LABEL,
  ALTITUDE_DATUM_LABEL, IMPORT_ISSUE_LABEL, IMPORT_STATUS_LABEL, airspaceVersionOrdinal, labelOf
} from '@/ui/labels.js';

usePageChrome('airspace');

const KIND_OPTIONS = [{ label: '全部种类', value: '' }].concat(
  ['PROHIBITED', 'RESTRICTED', 'ALTITUDE_LIMIT', 'PERMITTED', 'TEMPORARY_CONTROL']
    .map(value => ({ label: AIRSPACE_KIND_LABEL[value], value })));
/* 只读接口用 valid_at 判断某一时刻生效的版本；"已失效"没有对应的查询条件，因此不做这个选项。 */
const VALIDITY_OPTIONS = [{ label: '全部', value: '' }, { label: '当前生效', value: 'now' }];

const filters = reactive({ kind_code: '', validity: '', owner_org_id: '', district_id: '' });
const page = ref(1), size = ref(20), total = ref(0);
const airspaces = ref([]);
const selected = ref(null);
const versions = ref([]);
const routes = ref([]);
const diff = ref(null);
const loading = ref(false), detailLoading = ref(false), diffLoading = ref(false), busy = ref(false);
const error = ref(''), detailError = ref(''), diffError = ref(''), routesError = ref('');
const mapHost = ref(null);
let airspaceMap = null;

const canManage = computed(() => hasPermission('airspace.op') || hasPermission('airspace.auth'));
const manageBlockedNote = '需要空域管理权限，请联系管理员开通';

/* 当前生效版本：已到生效时间且尚未被接替的那一版。没有就是没有——不拿最新一版冒充"当前"，
   否则一片只排了未来版本的空域会被显示成正在生效。 */
const currentVersion = computed(() => {
  const now = Date.now();
  return versions.value.find(v => v.valid_from <= now && (!v.valid_to || v.valid_to > now)) || null;
});

/** 版本号最大的一版（可能尚未生效）：差异面板比的是"最近一次改动"，与此刻是否生效无关。 */
const latestVersion = computed(() => versions.value[0] || null);

const previousVersion = computed(() => {
  const latest = latestVersion.value;
  if (!latest) return null;
  return versions.value.find(v => v.version_no === latest.version_no - 1) || null;
});

function time(value) {
  return value == null ? '' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function kindLabel(code) { return labelOf(AIRSPACE_KIND_LABEL, code); }
function kindTag(code) { return AIRSPACE_KIND_TAG[code] || 't-gray'; }
function datumLabel(code) { return labelOf(ALTITUDE_DATUM_LABEL, code, ''); }
function originLabel(code) { return labelOf(AIRSPACE_ORIGIN_LABEL, code, ''); }
function issueLabel(code) { return labelOf(IMPORT_ISSUE_LABEL, code, code || ''); }
function diffFieldLabel(field) { return labelOf(AIRSPACE_DIFF_FIELD_LABEL, field, field); }

/** 高度带：三件套齐全才有可比含义，缺基准就整条不渲染。 */
function altitudeText(version) {
  if (version?.min_altitude_m == null || version?.max_altitude_m == null || !version?.altitude_datum) return '';
  return `${version.min_altitude_m} ~ ${version.max_altitude_m} 米（${datumLabel(version.altitude_datum)}）`;
}

/** 版本在时间线上的状态：生效中 / 已被接替 / 未生效。 */
function validityText(version) {
  const now = Date.now();
  if (version.valid_from > now) return '未生效';
  if (!version.valid_to) return '生效中';
  return version.valid_to <= now ? '已被接替' : '生效中';
}

/** 差异里的时间字段是毫秒串，转成可读时间；其余字段原样显示。 */
function diffValue(field, value) {
  if (value == null || value === '') return '空';
  if (field === 'valid_from' || field === 'valid_to') return time(Number(value));
  if (field === 'kind_code') return kindLabel(value);
  if (field === 'altitude_datum') return datumLabel(value);
  return String(value);
}

function messageOf(reason) {
  if (!reason) return '读取失败，请稍后重试。';
  if (reason.status === 401) return '登录已失效，请重新登录。';
  if (reason.status === 403) return '当前账号没有查看空域的权限。';
  if (reason.status === 408 || reason.code === 'NETWORK_ERROR') return '服务连接超时或不可用，请稍后重试。';
  return reason.message || '读取失败，请稍后重试。';
}

async function load() {
  loading.value = true; error.value = '';
  try {
    const params = { page: page.value, size: size.value };
    if (filters.kind_code) params.kind_code = filters.kind_code;
    if (filters.validity === 'now') params.valid_at = Date.now();
    if (filters.owner_org_id) params.owner_org_id = filters.owner_org_id;
    if (filters.district_id) params.district_id = filters.district_id;
    const data = await airspaceApi.list(params);
    airspaces.value = data.items || [];
    total.value = data.total || 0;
    if (selected.value && !airspaces.value.some(row => row.airspace_id === selected.value.airspace_id)) clearDetail();
  } catch (reason) {
    airspaces.value = []; total.value = 0; clearDetail();
    error.value = messageOf(reason);
  } finally { loading.value = false; }
}

function clearDetail() {
  selected.value = null; versions.value = []; routes.value = []; diff.value = null;
  detailError.value = ''; diffError.value = ''; routesError.value = '';
  destroyMap();
}

async function select(row) {
  detailLoading.value = true; detailError.value = ''; diff.value = null; diffError.value = '';
  selected.value = row; versions.value = []; routes.value = [];
  try {
    const [detail, versionPage] = await Promise.all([
      airspaceApi.detail(row.airspace_id),
      airspaceApi.versions(row.airspace_id, { page: 1, size: 50 })
    ]);
    if (selected.value?.airspace_id !== row.airspace_id) return;
    selected.value = detail;
    versions.value = (versionPage.items || []).slice().sort((a, b) => b.version_no - a.version_no);
    await Promise.all([loadDiff(row.airspace_id), loadRoutes()]);
    renderMap();
  } catch (reason) {
    if (selected.value?.airspace_id !== row.airspace_id) return;
    versions.value = [];
    detailError.value = messageOf(reason);
  } finally {
    if (selected.value?.airspace_id === row.airspace_id) detailLoading.value = false;
  }
}

/** 与上一版的差异：只有存在上一版时才请求，几何差在不支持的库上会返回"暂不可用"。 */
async function loadDiff(airspaceId) {
  const latest = latestVersion.value, previous = previousVersion.value;
  if (!latest || !previous) { diff.value = null; return; }
  diffLoading.value = true; diffError.value = '';
  try {
    diff.value = await airspaceApi.diff(airspaceId, previous.airspace_version_id, latest.airspace_version_id);
  } catch (reason) {
    diff.value = null; diffError.value = messageOf(reason);
  } finally { diffLoading.value = false; }
}

/** 右侧只读航线：本期不提供航线编辑，只展示已保存的航线供对照。 */
async function loadRoutes() {
  routesError.value = '';
  try {
    const data = await flightApi.routes({ page: 1, size: 10 });
    routes.value = data.items || [];
  } catch (reason) {
    routes.value = [];
    routesError.value = reason?.status === 403 ? '当前账号没有查看航线的权限。' : messageOf(reason);
  }
}

/* ---------- 地图：复用 MapView 的 draw 覆写，画当前版本的多边形边界 ---------- */
function trustedPolygons(version) {
  const boundary = version?.boundary;
  if (boundary?.type !== 'MultiPolygon' || boundary.coordinate_system !== 'WGS84' || !Array.isArray(boundary.coordinates)) return [];
  if (version.field_issues?.some(issue => issue.field === 'boundary')) return [];
  return boundary.coordinates
    .map(polygon => polygon.map(ring => ring.map(point => [Number(point?.[0]), Number(point?.[1])])))
    .filter(polygon => polygon.length && polygon.every(ring => ring.length >= 4 && ring.every(([lon, lat]) =>
      Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)));
}

function destroyMap() {
  if (airspaceMap?.destroy) airspaceMap.destroy();
  airspaceMap = null;
}

function renderMap() {
  destroyMap();
  const version = currentVersion.value;
  const polygons = trustedPolygons(version);
  if (!mapHost.value || !polygons.length || !window.MapView) return;
  // 缩放取默认视野：一片空域通常只有一两公里见方，沿用航线页的 3.2 会把它放大到画不下。
  airspaceMap = new window.MapView(mapHost.value, {
    zoom: 1, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false }
  });
  airspaceMap.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  const drawBase = airspaceMap.draw.bind(airspaceMap);
  const color = AIRSPACE_KIND_COLOR[version.kind_code] || '#3d8bff';
  airspaceMap.draw = function drawAirspaceBoundary() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    // WGS-84 坐标顺序固定为 [经度, 纬度]；只画通过校验的几何，缺失时整块不画而不是补点。
    context.save();
    context.beginPath();
    polygons.forEach(polygon => polygon.forEach(ring => ring.forEach(([lon, lat], index) => {
      const point = this.px(lon, lat);
      if (index) context.lineTo(point[0], point[1]);
      else context.moveTo(point[0], point[1]);
    })));
    context.fillStyle = color + '28';
    context.fill('evenodd');
    context.strokeStyle = color;
    context.lineWidth = 1.6;
    context.stroke();
    context.restore();
  };
  // 把视野移到这片空域的中心，否则默认视野可能完全看不到它，用户会以为没画出来。
  const points = polygons.flat().flat();
  const lons = points.map(([lon]) => lon), lats = points.map(([, lat]) => lat);
  const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  if (typeof airspaceMap.centerAt === 'function') airspaceMap.centerAt(center[0], center[1]);
  airspaceMap.draw();
}

const mapNote = computed(() => {
  if (!selected.value) return '选择左侧空域后显示当前生效版本的范围';
  if (!versions.value.length) return '该空域暂无版本';
  if (!currentVersion.value) return '该空域当前没有生效版本';
  return trustedPolygons(currentVersion.value).length ? '' : '当前生效版本没有可绘制的范围';
});

/* ---------- 三个写操作：新建空域、追加版本、导入 GeoJSON ---------- */
function newKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const kindFieldOptions = KIND_OPTIONS.slice(1);
const datumOptions = [{ label: '不填写', value: '' }, { label: '离地高度', value: 'AGL' }, { label: '海拔高度', value: 'AMSL' }];

function boundaryFrom(text) {
  const parsed = JSON.parse(text);
  if (parsed?.type === 'Feature') return parsed.geometry;
  if (parsed?.type === 'FeatureCollection') return parsed.features?.[0]?.geometry;
  return parsed;
}

function altitudeBody(values) {
  const body = {};
  if (values.altitude_datum && values.min_altitude_m !== '' && values.max_altitude_m !== '') {
    body.min_altitude_m = Number(values.min_altitude_m);
    body.max_altitude_m = Number(values.max_altitude_m);
    body.altitude_datum = values.altitude_datum;
  }
  return body;
}

function openCreate() {
  if (!canManage.value) return;
  const key = newKey();
  openFormModal({
    title: '新建空域',
    notice: '新建后会同时生成第 1 版；此后每次调整都以新版本接替上一版，历史版本不会被改写。',
    fields: [
      { key: 'airspace_no', label: '空域编号', required: true, placeholder: '例如 KY-9-001' },
      { key: 'name', label: '空域名称', required: true },
      { key: 'kind_code', label: '空域种类', type: 'select', required: true, options: kindFieldOptions },
      { key: 'valid_from', label: '生效时间', type: 'datetime', required: true },
      { key: 'min_altitude_m', label: '高度下限（米）' },
      { key: 'max_altitude_m', label: '高度上限（米）' },
      { key: 'altitude_datum', label: '高度基准', type: 'select', options: datumOptions },
      { key: 'owner_org_id', label: '归属机构', required: true, placeholder: '机构标识' },
      { key: 'district_id', label: '归属区域', required: true, placeholder: '区域标识' },
      { key: 'change_reason', label: '划设原因' },
      { key: 'boundary', label: '边界（GeoJSON 面或多面）', type: 'textarea', required: true,
        placeholder: '粘贴 {"type":"Polygon","coordinates":[...]}' }
    ],
    initial: { kind_code: 'PROHIBITED', altitude_datum: '' },
    confirmText: '新建空域',
    validate: values => {
      if (values.altitude_datum && (values.min_altitude_m === '' || values.max_altitude_m === '')) return '填写高度基准时必须同时给出上下限';
      try { boundaryFrom(values.boundary); } catch { return '边界不是合法的 GeoJSON'; }
      return '';
    },
    onSubmit: async values => {
      if (busy.value) return;
      busy.value = true;
      try {
        const body = {
          airspace_no: values.airspace_no.trim(), name: values.name.trim(), kind_code: values.kind_code,
          boundary: boundaryFrom(values.boundary), valid_from: new Date(values.valid_from).getTime(),
          owner_org_id: values.owner_org_id.trim(), district_id: values.district_id.trim(),
          ...altitudeBody(values)
        };
        if (values.change_reason) body.change_reason = values.change_reason.trim();
        await airspaceApi.create(body, key);
        closeModal();
        toast('空域已新建。', 'ok');
        await load();
      } catch (reason) {
        toast(writeMessage(reason), 'err');
        if (isUncertainOutcome?.(reason)) await load();
      } finally { busy.value = false; }
    }
  });
}

function openAddVersion() {
  if (!canManage.value || !selected.value) return;
  const airspace = selected.value;
  const key = newKey();
  const latest = versions.value[0];
  openFormModal({
    title: `追加新版本 · ${airspace.airspace_no}`,
    notice: '新版本生效时，上一版会被关闭到同一时刻。已被研判引用的历史版本内容不会改变。',
    fields: [
      { key: 'kind_code', label: '空域种类', type: 'select', required: true, options: kindFieldOptions },
      { key: 'valid_from', label: '生效时间', type: 'datetime', required: true },
      { key: 'min_altitude_m', label: '高度下限（米）' },
      { key: 'max_altitude_m', label: '高度上限（米）' },
      { key: 'altitude_datum', label: '高度基准', type: 'select', options: datumOptions },
      { key: 'change_reason', label: '变更原因', required: true, placeholder: '写清这次为什么调整' },
      { key: 'boundary', label: '边界（GeoJSON 面或多面）', type: 'textarea', required: true }
    ],
    initial: { kind_code: latest?.kind_code || 'PROHIBITED', altitude_datum: latest?.altitude_datum || '' },
    confirmText: '追加版本',
    validate: values => {
      if (values.altitude_datum && (values.min_altitude_m === '' || values.max_altitude_m === '')) return '填写高度基准时必须同时给出上下限';
      if (latest && new Date(values.valid_from).getTime() <= latest.valid_from) return `生效时间必须晚于${airspaceVersionOrdinal(latest.version_no)}的生效时间`;
      try { boundaryFrom(values.boundary); } catch { return '边界不是合法的 GeoJSON'; }
      return '';
    },
    onSubmit: async values => {
      if (busy.value) return;
      busy.value = true;
      try {
        const body = {
          kind_code: values.kind_code, boundary: boundaryFrom(values.boundary),
          valid_from: new Date(values.valid_from).getTime(), change_reason: values.change_reason.trim(),
          expected_version: airspace.version, ...altitudeBody(values)
        };
        await airspaceApi.addVersion(airspace.airspace_id, body, key);
        closeModal();
        toast('新版本已生效，上一版已被接替。', 'ok');
        await load();
        const refreshed = airspaces.value.find(row => row.airspace_id === airspace.airspace_id);
        if (refreshed) await select(refreshed);
      } catch (reason) {
        toast(writeMessage(reason), 'err');
        // 版本冲突或结果未知：回读服务端最新状态，不用同一个键重试。
        const refreshed = airspaces.value.find(row => row.airspace_id === airspace.airspace_id);
        if (refreshed) await select(refreshed);
      } finally { busy.value = false; }
    }
  });
}

/** 选择文件：脚本里创建 input 读文本，再写回弹窗里的文本域；模板中不出现原生表单控件（决策 9-12）。 */
function pickGeoJsonFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.geojson,application/geo+json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => fillGeoJsonTextarea(String(reader.result || ''));
    reader.onerror = () => toast('文件读取失败，请改用粘贴。', 'err');
    reader.readAsText(file);
  });
  input.click();
}

/** 把读到的文本写进弹窗的文本域：派发 input 事件让表单组件的双向绑定同步，而不是绕开它直接提交。 */
function fillGeoJsonTextarea(text) {
  const area = document.querySelector('.nv-modal textarea, .n-modal textarea, .modal textarea');
  if (!area) { toast('没有找到文件内容输入框，请改用粘贴。', 'err'); return; }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(area, text); else area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  area.dispatchEvent(new Event('change', { bubbles: true }));
  toast('文件内容已填入，请确认后解析。', 'ok');
}

/** 弹窗里的"选择文件"按钮由 html 字段渲染，这里用事件委托接它的点击。 */
function onDocumentClick(event) {
  if (event.target?.closest?.('[data-airspace-pick]')) { event.preventDefault(); pickGeoJsonFile(); }
}

const importPreview = ref(null);

function openImport() {
  if (!canManage.value) return;
  const key = newKey();
  openFormModal({
    title: '导入 GeoJSON 空域',
    notice: '导入分两步：先解析出每个要素的结果与问题，确认后才真正建立空域版本。',
    fields: [
      { key: 'owner_org_id', label: '归属机构', required: true, placeholder: '机构标识' },
      { key: 'district_id', label: '归属区域', required: true, placeholder: '区域标识' },
      { key: 'kind_code', label: '默认空域种类', type: 'select', options: [{ label: '按文件内容', value: '' }].concat(kindFieldOptions) },
      { key: 'valid_from', label: '默认生效时间', type: 'datetime' },
      { key: 'geojson', label: '文件内容', type: 'textarea', required: true, placeholder: '粘贴 FeatureCollection，或用下方按钮选择文件' },
      { key: 'picker', label: ' ', type: 'html', html: '<button type="button" class="btn" data-airspace-pick>选择文件</button>' }
    ],
    initial: { kind_code: '' },
    confirmText: '解析并预览',
    validate: values => {
      try { JSON.parse(values.geojson); } catch { return '内容不是合法的 JSON'; }
      return '';
    },
    onSubmit: async values => {
      if (busy.value) return;
      busy.value = true;
      try {
        const body = { geojson: values.geojson, owner_org_id: values.owner_org_id.trim(), district_id: values.district_id.trim() };
        const defaults = {};
        if (values.kind_code) defaults.kind_code = values.kind_code;
        if (values.valid_from) defaults.valid_from = new Date(values.valid_from).getTime();
        if (Object.keys(defaults).length) body.defaults = defaults;
        const batch = await airspaceApi.stageImport(body, key);
        closeModal();
        importPreview.value = batch;
        toast(`已解析 ${batch.feature_count} 个要素，其中 ${batch.accepted_count} 个可导入。`, 'ok');
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
    toast(action === 'confirm'
      ? `已导入：新建 ${result.created_airspaces} 片空域、${result.created_versions} 个版本。`
      : '已放弃这批导入。', 'ok');
    if (action === 'confirm') await load();
  } catch (reason) {
    toast(writeMessage(reason), 'err');
    // 已被处理过或版本冲突：回读批次最新状态，让操作者看到真实结果。
    try { importPreview.value = await airspaceApi.importBatch(batch.batch_id); }
    catch { importPreview.value = null; }
  } finally { busy.value = false; }
}

function writeMessage(reason) {
  const code = reason?.code;
  if (code === 'VERSION_OVERLAP') return '生效时间必须晚于上一版本，请调整后重试。';
  if (code === 'INVALID_VALIDITY') return '失效时间必须晚于生效时间。';
  if (code === 'INVALID_GEOJSON') return '边界几何无法解析，请检查文件内容。';
  if (code === 'IMPORT_TOO_LARGE') return '文件要素过多或过大，请拆分后再导入。';
  if (code === 'IMPORT_ALREADY_DECIDED') return '这批导入已经处理过了。';
  if (code === 'VERSION_CONFLICT') return '空域已被其他人修改，已为你刷新最新状态。';
  if (code === 'IDEMPOTENCY_REPLAY') return '该操作已提交过，请查看最新结果。';
  if (reason?.status === 403) return manageBlockedNote;
  return reason?.message || '操作失败，请稍后重试。';
}

async function changePage(value) { page.value = value; await load(); }
async function changeSize(value) { size.value = value; page.value = 1; await load(); }
async function applyFilters() { page.value = 1; await load(); }

watch(() => filters.validity, () => applyFilters());
onMounted(() => { document.addEventListener('click', onDocumentClick); load(); });
onUnmounted(() => { document.removeEventListener('click', onDocumentClick); destroyMap(); });

</script>

<template>
  <section class="view airspace-page">
    <div class="row airspace-main">
      <UPanel title="空域列表" panel-style="flex:1.15" nopad>
        <div class="toolbar airspace-toolbar">
          <div class="toolbar-fields">
            <div class="field"><label>种类</label><UControl v-model="filters.kind_code" type="select" :options="KIND_OPTIONS" :disabled="loading" size="small" @update:model-value="applyFilters" /></div>
            <div class="field"><label>生效状态</label><UControl v-model="filters.validity" type="select" :options="VALIDITY_OPTIONS" :disabled="loading" size="small" /></div>
            <div class="field"><label>机构</label><UControl v-model="filters.owner_org_id" placeholder="机构标识" :disabled="loading" size="small" @keyup.enter="applyFilters" /></div>
            <div class="field"><label>区域</label><UControl v-model="filters.district_id" placeholder="区域标识" :disabled="loading" size="small" @keyup.enter="applyFilters" /></div>
          </div>
          <div class="toolbar-actions">
            <button class="btn" type="button" :disabled="loading" @click="applyFilters">查询</button>
            <button class="btn pri" type="button" :disabled="!canManage || busy" :title="canManage ? '' : manageBlockedNote" @click="openCreate">新建空域</button>
            <button class="btn" type="button" :disabled="!canManage || busy" :title="canManage ? '' : manageBlockedNote" @click="openImport">导入文件</button>
          </div>
        </div>

        <div v-if="error" class="empty">{{ error }}</div>
        <div v-else-if="loading && !airspaces.length" class="empty">正在读取空域…</div>
        <div v-else-if="!airspaces.length" class="empty">没有符合条件的空域。</div>
        <div v-else class="scroll airspace-list">
          <table class="tb">
            <thead><tr><th>空域编号</th><th>名称</th><th>归属机构</th><th>归属区域</th></tr></thead>
            <tbody>
              <tr v-for="row in airspaces" :key="row.airspace_id" :class="{ on: selected?.airspace_id === row.airspace_id }"
                  tabindex="0" :title="row.airspace_id" @click="select(row)" @keydown.enter="select(row)">
                <td class="mono" :title="row.airspace_no">{{ row.airspace_no }}</td>
                <td :title="row.name">{{ row.name }}</td>
                <td :title="row.owner_org_id">{{ row.owner_org_name || '—' }}</td>
                <td :title="row.district_id">{{ row.district_name || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <UPagination v-model:page="page" v-model:page-size="size" :item-count="total" :prefix="`共 ${total} 片空域`"
                       @update:page="changePage" @update:page-size="changeSize" />
        </div>
      </UPanel>

      <UPanel title="空域详情" panel-style="flex:1.35" nopad>
        <div v-if="!selected" class="empty">选择左侧空域查看版本与范围。</div>
        <div v-else-if="detailLoading" class="empty">正在读取详情…</div>
        <template v-else>
          <div v-if="detailError" class="empty">{{ detailError }}</div>
          <div v-else class="airspace-detail scroll">
            <div class="detail-hero">
              <span class="detail-hero-icon" :class="kindTag((currentVersion || latestVersion)?.kind_code)">{{ kindLabel((currentVersion || latestVersion)?.kind_code).slice(0, 1) }}</span>
              <div class="detail-hero-copy">
                <b :title="selected.airspace_id">{{ selected.name }}</b>
                <span class="mono">{{ selected.airspace_no }}</span>
              </div>
              <div class="detail-hero-side">
                <span class="tag" :class="kindTag((currentVersion || latestVersion)?.kind_code)">{{ kindLabel((currentVersion || latestVersion)?.kind_code) }}</span>
              </div>
            </div>

            <div class="kv">
              <span>当前生效版本</span><b>{{ airspaceVersionOrdinal(currentVersion?.version_no) || '当前没有生效版本' }}</b>
              <template v-if="currentVersion"><span>生效时间</span><b>{{ time(currentVersion.valid_from) }}</b></template>
              <span>最新版本</span><b>{{ airspaceVersionOrdinal(latestVersion?.version_no) || '暂无版本' }}</b>
              <template v-if="altitudeText(currentVersion || latestVersion)"><span>高度带</span><b>{{ altitudeText(currentVersion || latestVersion) }}</b></template>
              <template v-if="latestVersion?.change_reason"><span>最近变更原因</span><b>{{ latestVersion.change_reason }}</b></template>
            </div>

            <div class="detail-actions">
              <button class="btn pri" type="button" :disabled="!canManage || busy" :title="canManage ? '' : manageBlockedNote" @click="openAddVersion">追加新版本</button>
            </div>

            <div class="sect-title">版本时间线</div>
            <ul v-if="versions.length" class="airspace-timeline">
              <li v-for="version in versions" :key="version.airspace_version_id" :title="version.airspace_version_id">
                <b>{{ airspaceVersionOrdinal(version.version_no) }}</b>
                <span class="tag" :class="kindTag(version.kind_code)">{{ kindLabel(version.kind_code) }}</span>
                <span class="airspace-timeline-state">{{ validityText(version) }}</span>
                <span class="airspace-timeline-time">{{ time(version.valid_from) }}<template v-if="version.valid_to"> 至 {{ time(version.valid_to) }}</template></span>
                <div v-if="version.change_reason" class="airspace-timeline-reason">变更原因：{{ version.change_reason }}</div>
                <div v-if="version.origin_kind" class="airspace-timeline-reason">来源：{{ originLabel(version.origin_kind) }}</div>
              </li>
            </ul>
            <div v-else class="empty">该空域暂无版本。</div>

            <div class="sect-title">最新一版与上一版的差异</div>
            <div v-if="diffLoading" class="empty">正在比对…</div>
            <div v-else-if="diffError" class="empty">{{ diffError }}</div>
            <div v-else-if="!diff" class="empty">这是第 1 版，没有可比对的上一版。</div>
            <template v-else>
              <ul v-if="diff.fields?.length" class="airspace-diff">
                <li v-for="item in diff.fields" :key="item.field">
                  <b>{{ diffFieldLabel(item.field) }}</b>
                  <span class="airspace-diff-from">{{ diffValue(item.field, item.from) }}</span>
                  <span class="airspace-diff-arrow">→</span>
                  <span class="airspace-diff-to">{{ diffValue(item.field, item.to) }}</span>
                </li>
              </ul>
              <div v-else class="empty">两版的属性没有变化。</div>
              <div class="airspace-diff-geometry">
                范围变化：
                <template v-if="diff.geometry?.availability === 'AVAILABLE'">
                  {{ diff.geometry.changed ? '范围已调整' : '范围未变' }}
                  <template v-if="diff.geometry.area_delta_m2 != null">（面积变化 {{ Math.round(diff.geometry.area_delta_m2) }} 平方米）</template>
                </template>
                <template v-else>当前环境不支持面积比对，暂不可用</template>
              </div>
            </template>

            <div class="sect-title">相关航线（只读）</div>
            <div v-if="routesError" class="empty">{{ routesError }}</div>
            <ul v-else-if="routes.length" class="airspace-routes">
              <li v-for="route in routes" :key="route.route_id" :title="route.route_id">
                <b>{{ route.name || route.route_no }}</b>
                <span class="mono">{{ route.route_no }}</span>
              </li>
            </ul>
            <div v-else class="empty">暂无航线记录。本期不提供航线编辑。</div>
          </div>
        </template>
      </UPanel>

      <UPanel title="当前生效版本范围" panel-style="flex:1" nopad body-style="padding:6px">
        <div v-if="mapNote" class="empty airspace-map-empty">{{ mapNote }}</div>
        <div v-show="!mapNote" ref="mapHost" class="airspace-map"></div>
      </UPanel>
    </div>

    <div v-if="importPreview" class="panel airspace-import">
      <div class="ph">
        <h3>导入预览 · {{ labelOf(IMPORT_STATUS_LABEL, importPreview.status) }}</h3>
        <p>共 {{ importPreview.feature_count }} 个要素，其中 {{ importPreview.accepted_count }} 个可导入；确认后才会建立空域版本。</p>
      </div>
      <div class="scroll airspace-import-list">
        <table class="tb">
          <thead><tr><th>序号</th><th>名称</th><th>编号</th><th>种类</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="item in importPreview.items" :key="item.item_id" :title="item.item_id">
              <td>{{ item.seq }}</td>
              <td>{{ item.name || '—' }}</td>
              <td class="mono">{{ item.airspace_no || '—' }}</td>
              <td>{{ item.kind_code ? kindLabel(item.kind_code) : '—' }}</td>
              <td>
                <span v-if="item.accepted" class="tag t-green">可导入</span>
                <template v-else>
                  <span class="tag t-red">不可导入</span>
                  <span v-for="issue in item.issues" :key="issue.reason_code" class="airspace-import-issue">{{ issueLabel(issue.reason_code) }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="detail-actions">
        <button class="btn pri" type="button" :disabled="busy || !importPreview.accepted_count" @click="decideImport('confirm')">确认导入</button>
        <button class="btn" type="button" :disabled="busy" @click="decideImport('discard')">放弃这批</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 页面根是 .view（display:block），三栏要占满可视高度必须自己成为纵向 flex 容器，与告警/飞行计划页一致。 */
/* 工具栏布局与控件定宽统一到 controls.css 的 .toolbar/.toolbar-fields（决策 12-15）。 */
.airspace-page { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.airspace-main { flex: 1; min-height: 0; gap: 10px; }
.airspace-list { overflow: auto; flex: 1; }
/* 四列必须在面板内排得下：名称列吸收剩余宽度并允许折行，避免整表横向溢出把归属列挤出视野。 */
.airspace-list table { table-layout: fixed; width: 100%; }
.airspace-list th:nth-child(1), .airspace-list td:nth-child(1) { width: 92px; }
.airspace-list th:nth-child(3), .airspace-list td:nth-child(3),
.airspace-list th:nth-child(4), .airspace-list td:nth-child(4) { width: 96px; }
/* 单行显示、超长省略：编号与名称折行会让整列难读，完整值放在悬停提示里。 */
.airspace-list :deep(table.tb) { table-layout: fixed; }
.airspace-list :deep(td), .airspace-list :deep(th) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.airspace-detail { overflow: auto; flex: 1; padding: 10px 12px; }
.airspace-map { width: 100%; height: 100%; min-height: 260px; }
.airspace-map-empty { height: 100%; display: flex; align-items: center; justify-content: center; }
.airspace-timeline { list-style: none; margin: 0; padding: 0; }
.airspace-timeline li { padding: 8px 0; border-bottom: 1px solid var(--line, #1e2a3d); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.airspace-timeline-state { color: var(--txt-2, #8fa3bc); }
.airspace-timeline-time { color: var(--txt-2, #8fa3bc); margin-left: auto; }
.airspace-timeline-reason { flex-basis: 100%; color: var(--txt-2, #8fa3bc); font-size: 12.5px; }
.airspace-diff { list-style: none; margin: 0; padding: 0; }
.airspace-diff li { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.airspace-diff-from { color: var(--txt-2, #8fa3bc); }
.airspace-diff-arrow { color: var(--txt-2, #8fa3bc); }
.airspace-diff-geometry { margin-top: 6px; color: var(--txt-2, #8fa3bc); font-size: 12.5px; }
.airspace-routes { list-style: none; margin: 0; padding: 0; }
.airspace-routes li { display: flex; gap: 10px; padding: 6px 0; align-items: center; }
.airspace-import { margin-top: 10px; }
.airspace-import-list { max-height: 240px; overflow: auto; }
.airspace-import-issue { margin-left: 6px; color: var(--txt-2, #8fa3bc); font-size: 12.5px; }
</style>
