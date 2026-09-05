<script>
/* 跨导航只保留筛选、分页与选中 ID；业务事实仍每次从只读 API 重取，不能缓存成 Mock 副本。 */
const S = { filters: { status_code: '', keyword: '', owner_org_id: '', district_id: '' }, page: 1, size: 20, selectedPlanId: null, tab: 'route', tabHash: '' };
export default {};
</script>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';

usePageChrome('flights');

const filters = reactive(S.filters);
const page = ref(S.page);
const size = ref(S.size);
const total = ref(0);
const plans = ref([]);
const selected = ref(null);
const routeVersion = ref(null);
const airspaceVersions = ref([]);
const conflicts = ref([]);
const loading = ref(false);
const detailLoading = ref(false);
const routeGeometryLoading = ref(false);
const airspaceLoading = ref(false);
const error = ref('');
const detailError = ref('');
const routeGeometryError = ref('');
const airspaceError = ref('');
const activeTab = ref('route');
const legacyRiskRoot = ref(null);
const mapHost = ref(null);
const routeLoaded = ref(false);
let routeMap = null;

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / size.value)));
const statusOptions = [{ label: '全部状态', value: '' }, ...['PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED', 'CANCELLED'].map(value => ({ label: value, value }))];
const kpiList = ['今日报备计划', '执行中', '待执行', '已完成', '计划未匹配到目标', '偏离报备计划'].map((label, index) => ({ label, value: '—', color: ['blue', 'cyan', 'purple', 'green', 'amber', 'red'][index], icon: ['plan', 'radar', 'check', 'check', 'alert', 'alert'][index], desc: '尚未接入后端聚合口径' }));
const trustedCenterline = computed(() => trustedCoordinates(routeVersion.value));
const trustedAirspaces = computed(() => trustedAirspaceOverlays());
const hasMapContent = computed(() => Boolean(trustedCenterline.value?.length || trustedAirspaces.value.length));

function formatTime(value) {
  if (value === null || value === undefined) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(plan) {
  if (plan.start_at == null || plan.end_at == null) return '不可判定';
  return `${Math.max(0, Math.round((plan.end_at - plan.start_at) / 60000))} 分钟`;
}

async function loadPlans(nextPage = page.value) {
  loading.value = true;
  error.value = '';
  try {
    const data = await flightApi.list({ page: nextPage, size: size.value, ...filters });
    page.value = data.page;
    total.value = data.total;
    plans.value = data.items;
    routeLoaded.value = true;
    if (!selected.value || !plans.value.some(item => item.plan_id === selected.value.plan_id)) {
      selected.value = plans.value[0] || null;
      S.selectedPlanId = selected.value?.plan_id || null;
      routeVersion.value = null;
      airspaceVersions.value = [];
      conflicts.value = [];
      routeGeometryError.value = '';
      airspaceError.value = '';
      destroyRouteMap();
      if (selected.value) await loadDetail(selected.value.plan_id);
    }
  } catch (requestError) {
    // 请求失败必须保留真实错误，绝不以演示数据伪造一个“正常”列表。
    plans.value = [];
    total.value = 0;
    selected.value = null;
    routeVersion.value = null;
    airspaceVersions.value = [];
    conflicts.value = [];
    routeGeometryError.value = '';
    airspaceError.value = '';
    destroyRouteMap();
    routeLoaded.value = false;
    error.value = requestError.message || '读取飞行计划失败';
  } finally {
    loading.value = false;
  }
}

async function loadDetail(planId) {
  detailLoading.value = true;
  detailError.value = '';
  routeVersion.value = null;
  airspaceVersions.value = [];
  conflicts.value = [];
  routeGeometryError.value = '';
  airspaceError.value = '';
  routeGeometryLoading.value = false;
  destroyRouteMap();
  let plan = null;
  try {
    plan = await flightApi.detail(planId);
    selected.value = plan;
    S.selectedPlanId = plan.plan_id;
  } catch (requestError) {
    detailError.value = requestError.message || '读取计划详情失败';
  } finally {
    detailLoading.value = false;
  }
  // 计划详情只要求 flight:read；航线几何另行读取，不能让 route:read 失败掩盖已取得的计划事实。
  if (plan && selected.value?.plan_id === plan.plan_id) {
    await Promise.all([loadRouteGeometry(plan), loadAirspaceContext(plan)]);
  }
}

async function loadRouteGeometry(plan) {
  if (!plan.route?.route_version_id) return;
  routeGeometryLoading.value = true;
  routeGeometryError.value = '';
  try {
    const version = await flightApi.routeVersion(plan.route.route_version_id);
    if (selected.value?.plan_id !== plan.plan_id) return;
    routeVersion.value = version;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    routeGeometryError.value = requestError.message || '无航线读取权限或航线几何读取失败';
    destroyRouteMap();
  } finally {
    if (selected.value?.plan_id === plan.plan_id) routeGeometryLoading.value = false;
  }
}

function trustedCoordinates(version) {
  const line = version?.centerline;
  if (line?.type !== 'LineString' || line?.coordinate_system !== 'WGS84'
    || version?.field_issues?.some(issue => issue.field === 'centerline') || !Array.isArray(line.coordinates)) return null;
  const coordinates = line.coordinates.map(point => [Number(point?.[0]), Number(point?.[1])]);
  if (coordinates.length < 2 || coordinates.some(([longitude, latitude]) => !Number.isFinite(longitude)
    || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) return null;
  return coordinates;
}

function trustedAirspaceOverlays() {
  const byVersion = new Map(airspaceVersions.value.map(version => [version.airspace_version_id, version]));
  return conflicts.value.flatMap(conflict => {
    const version = byVersion.get(conflict.airspace_version_id);
    const boundary = version?.boundary;
    if (boundary?.type !== 'MultiPolygon' || boundary.coordinate_system !== 'WGS84'
      || version.field_issues?.some(issue => issue.field === 'boundary') || !Array.isArray(boundary.coordinates)) return [];
    const polygons = boundary.coordinates.map(polygon => polygon.map(ring => ring.map(point => [Number(point?.[0]), Number(point?.[1])])))
      .filter(polygon => polygon.length && polygon.every(ring => ring.length >= 4 && ring.every(([longitude, latitude]) => Number.isFinite(longitude)
        && Number.isFinite(latitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90)));
    return polygons.length ? [{ conflict, polygons }] : [];
  });
}

function destroyRouteMap() {
  if (routeMap) routeMap.destroy();
  routeMap = null;
}

function renderRouteMap() {
  destroyRouteMap();
  const coordinates = trustedCenterline.value;
  const airspaces = trustedAirspaces.value;
  if (activeTab.value !== 'route' || !mapHost.value || (!coordinates && !airspaces.length)) return;
  routeMap = new window.MapView(mapHost.value, {
    zoom: 3.2, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false }
  });
  routeMap.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  const drawBase = routeMap.draw.bind(routeMap);
  routeMap.draw = function drawRouteCenterline() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    // API 的 WGS-84 坐标顺序固定为 [longitude, latitude]；只画可信几何，不以缺失数据推断空域或合法性。
    context.save();
    airspaces.forEach(({ polygons }) => {
      context.beginPath();
      polygons.forEach(polygon => polygon.forEach(ring => ring.forEach(([longitude, latitude], index) => {
        const point = this.px(longitude, latitude);
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
    if (coordinates) {
      // corridor_width_m 是走廊全宽；未做投影缓冲时不能把全宽误当半径，因此地图只画中心线。
      context.beginPath();
      coordinates.forEach(([longitude, latitude], index) => {
        const point = this.px(longitude, latitude);
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
  const [longitude, latitude] = coordinates?.[Math.floor(coordinates.length / 2)] || airspaces[0].polygons[0][0][0];
  routeMap.centerAt(longitude, latitude);
}

async function loadAirspaceContext(plan) {
  airspaceLoading.value = true;
  airspaceError.value = '';
  try {
    const facts = await flightApi.conflicts(plan.plan_id);
    if (selected.value?.plan_id !== plan.plan_id) return;
    const versionIds = [...new Set(facts.map(fact => fact.airspace_version_id).filter(Boolean))];
    const versions = await Promise.all(versionIds.map(id => airspaceApi.version(id)));
    if (selected.value?.plan_id !== plan.plan_id) return;
    conflicts.value = facts;
    airspaceVersions.value = versions;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    // 冲突读取需要 airspace:read；无此权限只隐藏空域事实，不能覆盖已有 flight:read 计划详情。
    airspaceError.value = requestError.message || '空域冲突事实读取失败';
    airspaceVersions.value = [];
    conflicts.value = [];
    renderRouteMap();
  } finally {
    if (selected.value?.plan_id === plan.plan_id) airspaceLoading.value = false;
  }
}

function applyFilters() {
  routeLoaded.value = false;
  loadPlans(1);
}

function chooseStatus(value) { filters.status_code = value; applyFilters(); }
function changePage(nextPage) { if (nextPage !== page.value) loadPlans(nextPage); }
function changePageSize(nextSize) { size.value = nextSize; routeLoaded.value = false; loadPlans(1); }

async function renderLegacyRisk() {
  if (activeTab.value !== 'events' || !legacyRiskRoot.value || !window.RISK_IMPL) return;
  destroyRouteMap();
  await nextTick();
  if (activeTab.value !== 'events' || !legacyRiskRoot.value) return;
  if (window.RISK_IMPL.destroy) window.RISK_IMPL.destroy();
  legacyRiskRoot.value.innerHTML = window.RISK_IMPL.render();
  window.RISK_IMPL.mount(legacyRiskRoot.value);
}

function syncTabByRoute() {
  const hash = (location.hash || '').split('?')[0];
  if (hash === S.tabHash) return;
  S.tabHash = hash;
  // risk 是唯一能预置事件页签的别名；离开它再进入 flights 必须回到航线页，不能复用旧页签状态。
  const nextTab = hash.startsWith('#/risk') ? 'events' : 'route';
  if (nextTab === 'events') {
    activeTab.value = nextTab;
    destroyRouteMap();
    renderLegacyRisk();
    return;
  }
  if (activeTab.value === 'events' && window.RISK_IMPL?.destroy) window.RISK_IMPL.destroy();
  activeTab.value = nextTab;
  if (!routeLoaded.value && !loading.value) loadPlans();
  else nextTick(renderRouteMap);
}

function activateTab(tab) {
  if (tab === 'events') {
    activeTab.value = 'events';
    destroyRouteMap();
    if (!location.hash.startsWith('#/risk')) location.hash = '#/risk';
    renderLegacyRisk();
    return;
  }
  if (window.RISK_IMPL?.destroy) window.RISK_IMPL.destroy();
  activeTab.value = 'route';
  if (location.hash.startsWith('#/risk')) location.hash = '#/flights';
  if (!routeLoaded.value && !loading.value) loadPlans();
  else nextTick(renderRouteMap);
}

onMounted(() => {
  window.addEventListener('hashchange', syncTabByRoute);
  S.tabHash = '';
  syncTabByRoute();
  if (activeTab.value === 'events') renderLegacyRisk();
  else {
    const context = window.UI?.consume?.('flights');
    loadPlans().then(() => {
      const planId = context?.plan || S.selectedPlanId;
      if (planId) loadDetail(planId);
    });
  }
});

watch(page, value => { S.page = value; });
watch(size, value => { S.size = value; });
watch(activeTab, value => { S.tab = value; });

onUnmounted(() => {
  window.removeEventListener('hashchange', syncTabByRoute);
  if (window.RISK_IMPL?.destroy) window.RISK_IMPL.destroy();
  destroyRouteMap();
});
</script>

<template>
  <section class="view flights-page">
    <div class="tabs" style="margin-bottom:10px">
      <button class="tab" :class="{ on: activeTab === 'route' }" type="button" @click="activateTab('route')">按航线看</button>
      <button class="tab" :class="{ on: activeTab === 'events' }" type="button" @click="activateTab('events')">全部风险事件</button>
    </div>

    <div v-if="activeTab === 'events'" ref="legacyRiskRoot"></div>

    <template v-else>
      <UKpis :list="kpiList" />
      <div v-if="error" class="warnbox">{{ error }}</div>
      <div class="row flight-main">
        <UPanel title="飞行计划与活动" :panel-style="'flex:1.1;min-width:0'" nopad>
          <div class="toolbar">
            <UControl v-model="filters.status_code" type="select" :options="statusOptions" :disabled="loading" />
            <UControl v-model="filters.keyword" placeholder="计划编号 / 无人机序列号" :disabled="loading" @keyup.enter="applyFilters" />
            <UControl v-model="filters.owner_org_id" placeholder="所属组织 ID" :disabled="loading" @keyup.enter="applyFilters" />
            <UControl v-model="filters.district_id" placeholder="区域 ID" :disabled="loading" @keyup.enter="applyFilters" />
            <button class="btn" type="button" :disabled="loading" @click="applyFilters">查询</button>
            <span class="spacer"></span><button class="btn" type="button" disabled title="尚未接入">导出（尚未接入）</button>
          </div>
          <div v-if="loading" class="empty">正在读取飞行计划…</div>
          <div v-else-if="!plans.length" class="empty">暂无可访问的飞行计划</div>
          <div v-else class="tb-wrap">
            <table class="tb">
              <thead><tr><th>计划编号</th><th>计划时段</th><th>状态</th><th>航线版本</th></tr></thead>
              <tbody>
                <tr v-for="plan in plans" :key="plan.plan_id" :class="{ on: selected?.plan_id === plan.plan_id }"
                  tabindex="0" @click="loadDetail(plan.plan_id)" @keydown.enter="loadDetail(plan.plan_id)">
                  <td class="mono">{{ plan.plan_no }}</td>
                  <td>{{ formatTime(plan.start_at) }}<br><small>{{ formatDuration(plan) }}</small></td>
                  <td>{{ plan.status_code }}</td>
                  <td>{{ plan.route?.route_no || '未知航线' }} / v{{ plan.route?.version_no ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pager"><UPagination :page="page" :page-size="size" :item-count="total" @update:page="changePage" @update:page-size="changePageSize" /></div>
        </UPanel>

        <div class="col flight-right">
          <UPanel title="航线周边态势" nopad body-style="padding:6px">
            <!-- UPanel 的 sub/extra 使用 v-html；API 航线编号只能经 Vue 文本插值输出。 -->
            <div class="map-summary">{{ selected?.route ? `${selected.route.route_no} / v${selected.route.version_no} · ` : '' }}{{ conflicts.length ? `服务端返回 ${conflicts.length} 条空域时空关系事实` : '未接入风险/异物推导；仅展示已取得的航线与空域版本几何。' }}</div>
            <div ref="mapHost" class="route-map" :class="{ unavailable: !hasMapContent }"></div>
            <div v-if="routeGeometryLoading || airspaceLoading" class="empty">正在读取航线或空域事实…</div>
            <div v-else-if="routeGeometryError || airspaceError" class="warnbox">{{ routeGeometryError || airspaceError }}</div>
            <div v-else-if="!hasMapContent" class="empty">不可绘制：未取得可信 WGS-84 航线或空域边界。</div>
            <div class="map-note">未知几何不绘制；走廊宽度、风险与合法性均不在前端推断。</div>
          </UPanel>
          <UPanel title="计划详情" :panel-style="'flex:3;min-height:0'" nopad>
            <div class="detail-body">
          <div v-if="detailLoading" class="empty">正在读取详情…</div>
          <div v-else-if="detailError" class="warnbox">{{ detailError }}</div>
          <div v-else-if="!selected" class="empty">请选择计划</div>
          <template v-else>
            <div class="detail-hero detail-hero-compact"><div class="detail-hero-inner"><div class="detail-hero-copy"><div class="detail-hero-eyebrow">飞行计划</div><div class="detail-hero-title">{{ selected.plan_no }}</div><div class="detail-hero-id mono">{{ selected.route?.route_no || '未关联航线' }} / v{{ selected.route?.version_no ?? '—' }}</div></div></div></div>
            <div class="metric-strip is-compact"><div v-for="metric in [['执行状态', selected.status_code], ['计划时长', formatDuration(selected)], ['航线版本', `v${selected.route?.version_no ?? '—'}`], ['目标匹配', '尚未接入']]" :key="metric[0]" class="metric-item"><div class="metric-copy"><small>{{ metric[0] }}</small><b>{{ metric[1] }}</b></div></div></div>
            <section class="sect"><h4>计划信息</h4><dl class="kv kv-surface"><dt>无人机 ID</dt><dd>{{ selected.uav_sn || '未提供' }}</dd><dt>所属范围</dt><dd>{{ selected.owner_org_id }} / {{ selected.district_id }}</dd><dt>计划时段</dt><dd>{{ formatTime(selected.start_at) }} ～ {{ formatTime(selected.end_at) }}</dd><dt>计划来源</dt><dd>{{ selected.source?.source_code || selected.source_mode || '未提供' }}</dd></dl></section>
            <section class="sect"><h4>审批信息</h4><div class="empty">尚未接入审批事实读取。</div></section>
            <section class="sect"><h4>计划与实际对照</h4><div class="empty">尚未接入感知匹配、偏航与高度对照；AGL/AMSL 不作前端换算。</div></section>
            <section class="sect"><h4>本航线风险</h4><div class="empty">尚未接入沿线风险事件；不根据地图几何自行计算风险。</div></section>
            <section class="sect"><h4>合法性</h4><div class="empty">尚未接入已保存合法性研判；冲突事实不等于合法性结论。</div></section>
            <section class="sect"><h4>空域冲突事实</h4><div v-if="!conflicts.length" class="empty">服务端未返回空域冲突事实。</div><div v-else class="conflict-list"><div v-for="fact in conflicts" :key="`${fact.airspace_version_id}-${fact.conflict_code}`" class="conflict-item">{{ fact.airspace_id }} / {{ fact.airspace_version_id }}：水平 {{ fact.horizontal_relation }}；高度 {{ fact.height_relation }}；时间 {{ fact.time_relation }}；{{ fact.conflict_code || '未提供' }}</div></div></section>
            <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
              <button class="btn" type="button" disabled title="尚未接入">导出（尚未接入）</button>
              <button class="btn" type="button" disabled title="尚未接入">风险通知（尚未接入）</button>
              <button class="btn" type="button" disabled title="尚未接入">写入操作（尚未接入）</button>
            </div>
          </template></div>
          </UPanel>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.flights-page { min-width: 0; }
.flight-main { margin-top: 12px; align-items: stretch; gap: var(--gap); height: max(812px, calc(100vh - 332px)); }
.flight-right { flex: 1; min-width: 560px; display: grid; grid-template-rows: 320px minmax(460px, 1fr); gap: var(--gap); }
.toolbar { display: flex; gap: 8px; padding: 10px; flex-wrap: wrap; align-items: center; }
.toolbar .u-control { width: 158px; }.toolbar .spacer { flex: 1; }
.tb-wrap { overflow: auto; }
.tb tr { cursor: pointer; }
.tb tr.on { background: rgba(34, 211, 238, .12); }
.route-geometry { overflow-wrap: anywhere; line-height: 1.7; }
.route-map { height: 245px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.route-map.unavailable { display: none; }
.map-summary,.map-note { padding: 3px 4px; font-size: 11px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-body { height: 100%; overflow: auto; padding: 12px; }
.pager { display:flex; justify-content:flex-end; padding:10px; }
.conflict-list { display: grid; gap: 8px; margin-top: 8px; }
.conflict-item { display: grid; gap: 3px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.muted { color: var(--txt-3); font-size: 12px; }
.sect-title { margin-top: 14px; font-weight: 600; }
@media (max-width: 1100px) { .flight-main { height:auto; flex-direction:column; }.flight-right { min-width:0; grid-template-rows:320px minmax(460px,auto); } }
</style>
