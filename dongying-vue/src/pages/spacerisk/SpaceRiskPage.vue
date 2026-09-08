<script setup>
/* 空间安全风险（#/risk）：按 legacy public/assets/js/pages/risk.js 的结构恢复——
   6 个 KPI、三栏（地图 0.82 / 列表 1.7 / 详情 30%）、事件与通报两个页签。
   数据全部来自服务端：风险列表走 /risks?risk_type=SPACE_OBJECT，计数走 /space-risks/summary，
   通报记录走交接接口。核验复用与工作台、飞行计划页同一个弹窗，本页不另造状态机。 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { UControl } from '@/components/form/index.js';
import UPagination from '@/components/UPagination.vue';
import { toast } from '@/ui/nv.js';
import { openRiskVerification } from '@/ui/riskVerificationModal.js';
import { riskApi } from '@/services/riskApi.js';
import { flightApi } from '@/services/flightApi.js';
import { handoffApi } from '@/services/handoffApi.js';
import { authUser } from '@/services/auth.js';
import {
  labelOf, SEVERITY_LABEL, SEVERITY_TAG, RISK_STATE_LABEL, SOURCE_MODE_LABEL,
  SPACE_OBJECT_SUBTYPE_LABEL, ALTITUDE_BAND_LABEL, CORRIDOR_RELATION_LABEL, OBJECT_TREND_LABEL,
  DELIVERY_STATUS_LABEL, HANDOFF_TYPE_LABEL, verificationOrdinal
} from '@/ui/labels.js';

const U = window.UI;
usePageChrome('risk');

const PAGE_SIZE = 10;
const RISK_TYPE = 'SPACE_OBJECT';

const subtypes = ref([]);
const rows = ref([]);
/* 决策 9-31：C04 生成的 source_risk_id 是技术键（规则版本:计划:目标:窗口），不能当业务编号上屏；键放进 title 供排查。 */
function riskNoText(row) {
  const no = row?.source_risk_id || '';
  if (!no) return '—';
  return no.startsWith('C04:') ? 'C04 自动评估' : no;
}
const total = ref(0);
const page = ref(1);
const listLoading = ref(false);
const listError = ref('');
const summary = ref(null);
const summaryError = ref('');
const summaryForbidden = ref(false);
const filters = ref({ subtype: '', severity: '', state: '' });
const selectedId = ref('');
const detail = ref(null);
const detailError = ref('');
const spaceFact = ref(null);
const notices = ref([]);
const noticesError = ref('');
const activeTab = ref('event');
const mapHost = ref(null);
const detailPanel = ref(null);
const deepLinkMissed = ref(false);
/** 一次性上下文的最长可接受停留时间：只在生产者写了时间戳时才起作用。 */
const STASH_MAX_AGE_MS = 60_000;
const routeGeometry = ref(null);
let map = null;
let listToken = 0, detailToken = 0, summaryToken = 0;

const canVerify = computed(() => (detail.value?.allowed_actions || []).includes('VERIFY'));
/** 地图标记颜色只表示风险等级；没有位置快照坐标时返回 null，页面不画点。 */
const SEVERITY_COLOR = { CRITICAL: '#ff4d5e', HIGH: '#ff4d5e', MEDIUM: '#ffb020', LOW: '#3d8bff' };
const riskPoint = computed(() => {
  const fact = spaceFact.value;
  if (!fact || fact.longitude == null || fact.latitude == null) return null;
  return {
    longitude: Number(fact.longitude),
    latitude: Number(fact.latitude),
    color: SEVERITY_COLOR[detail.value?.severity] || '#3d8bff'
  };
});
const severityOptions = [{ label: '全部等级', value: '' },
  ...['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(value => ({ label: labelOf(SEVERITY_LABEL, value), value }))];
const stateOptions = [{ label: '全部状态', value: '' },
  ...Object.keys(RISK_STATE_LABEL).map(value => ({ label: labelOf(RISK_STATE_LABEL, value), value }))];
const subtypeOptions = computed(() => [{ label: '全部细类', value: '' },
  ...subtypes.value.map(item => ({ label: item.display_name, value: item.subtype_code }))]);

function icon(name) { return U.icon(name); }
function severityTag(code) { return SEVERITY_TAG[code] || 't-gray'; }
function fmt(ms) {
  if (ms == null) return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function shortTime(ms) { return fmt(ms).slice(5); }
function metres(value) { return value == null ? '' : `${Math.round(Number(value))} 米`; }
function messageOf(error, fallback) {
  if (!error) return fallback;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有查看空间安全风险的权限。';
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return '服务连接超时或不可用，请稍后重试。';
  return error.message || fallback;
}
/** KPI：没有数据时服务端给 null，页面显示"暂无数据"而不是 0；无权限单独提示。 */
function kpi(metric) {
  if (summaryForbidden.value) return '无权限';
  if (!summary.value) return '—';
  const value = summary.value[metric];
  return value && value.value != null ? String(value.value) : '暂无数据';
}
/* 决策 9-18：把"这次判定缺了哪些事实"如实写出来，避免把"没上调"读成"评估过且不严重"。 */
const UNKNOWN_REASON_LABEL = { OBJECT_COUNT_UNAVAILABLE: '数量未采集', TREND_UNAVAILABLE: '数量趋势未采集' };
const unknownNotes = computed(() =>
  (spaceFact.value?.unknown_reasons || []).map(code => labelOf(UNKNOWN_REASON_LABEL, code)));

const ruleBadge = computed(() => {
  const version = summary.value?.rule_version;
  if (!version) return '';
  return `${version.rule_set_code} 第 ${version.version_no} 版${version.param_status === 'DEMO' ? ' · 演示参数' : ''}`;
});

/* ---------- 读取 ---------- */
async function loadSubtypes() {
  try { subtypes.value = (await riskApi.listSpaceObjectSubtypes()) || []; }
  catch { subtypes.value = []; }
}

async function loadSummary() {
  const token = ++summaryToken;
  try {
    const data = await riskApi.spaceRiskSummary({});
    if (token !== summaryToken) return;
    summary.value = data;
    summaryError.value = '';
    summaryForbidden.value = false;
  } catch (error) {
    if (token !== summaryToken) return;
    summary.value = null;
    summaryForbidden.value = error?.status === 403;
    summaryError.value = summaryForbidden.value ? '' : messageOf(error, '读取风险统计失败');
  }
}

/**
 * @param allowFallback 没有指定选中项时是否默认选中首行。
 *   深链场景传 false：指定的风险不在结果里就保持未选中——默认选中另一条风险会让人以为点开的就是它。
 */
async function loadList(nextPage = page.value, keepSelection = selectedId.value, allowFallback = true) {
  const token = ++listToken;
  listLoading.value = true;
  try {
    const data = await riskApi.listRisks({
      risk_type: RISK_TYPE, page: nextPage, size: PAGE_SIZE,
      object_subtype: filters.value.subtype || undefined,
      severity: filters.value.severity || undefined,
      state: filters.value.state || undefined
    });
    if (token !== listToken) return;
    rows.value = data.items || [];
    total.value = data.total || 0;
    page.value = data.page || nextPage;
    listError.value = '';
    const stillThere = rows.value.some(row => row.risk_id === keepSelection);
    if (stillThere) selectedId.value = keepSelection;
    else if (allowFallback && rows.value.length) selectedId.value = rows.value[0].risk_id;
    else { selectedId.value = ''; detail.value = null; spaceFact.value = null; }
  } catch (error) {
    if (token !== listToken) return;
    listError.value = messageOf(error, '读取风险列表失败');
    rows.value = []; total.value = 0; selectedId.value = ''; detail.value = null;
  } finally {
    if (token === listToken) listLoading.value = false;
  }
}

async function loadDetail(riskId) {
  if (!riskId) { detail.value = null; spaceFact.value = null; routeGeometry.value = null; return; }
  const token = ++detailToken;
  detailError.value = '';
  try {
    const risk = await riskApi.getRisk(riskId);
    if (token !== detailToken) return;
    detail.value = risk;
    spaceFact.value = risk.space_fact || null;
    if (!risk.space_fact) {
      // 详情接口不带事实时单独取一次：没有事实是正常情况（非 C04 产出的风险），不报错。
      try { spaceFact.value = await riskApi.getSpaceFact(riskId); }
      catch { spaceFact.value = null; }
    }
    loadNotices(riskId);
    await nextTick();
    renderMap();
    loadRouteGeometry(risk, token);
  } catch (error) {
    if (token !== detailToken) return;
    detail.value = null;
    detailError.value = messageOf(error, '读取风险详情失败');
  }
}

async function loadNotices(riskId) {
  noticesError.value = '';
  try {
    const data = await handoffApi.listHandoffs({ source_kind: 'RISK', source_id: riskId, page: 1, size: 20 });
    notices.value = data.items || [];
  } catch (error) {
    notices.value = [];
    noticesError.value = error?.status === 403 ? '当前账号没有查看通报记录的权限。' : messageOf(error, '读取通报记录失败');
  }
}

async function loadRouteGeometry(risk, token) {
  routeGeometry.value = null;
  if (!risk.route_version_id) return;
  try {
    const version = await flightApi.routeVersion(risk.route_version_id);
    if (token !== detailToken) return;
    const line = version?.centerline?.coordinates;
    routeGeometry.value = Array.isArray(line) && line.length > 1 ? line : null;
    await nextTick();
    renderMap();
  } catch {
    if (token !== detailToken) return;
    routeGeometry.value = null;
    await nextTick();
    renderMap();
  }
}

/* ---------- 地图：与飞行计划页风险页签同一做法（只画已保存的航线中心线） ---------- */
function destroyMap() {
  if (map) map.destroy();
  map = null;
  if (mapHost.value) mapHost.value.innerHTML = '';
}

function renderMap() {
  destroyMap();
  if (!mapHost.value) return;
  const line = routeGeometry.value;
  const spot = riskPoint.value;
  map = new window.MapView(mapHost.value, { zoom: 3, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false } });
  map.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  if (!line && !spot) return;
  const drawBase = map.draw.bind(map);
  map.draw = function drawRouteAndRisk() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    context.save();
    if (line) {
      context.beginPath();
      line.forEach(([longitude, latitude], index) => {
        const point = this.px(longitude, latitude);
        if (index) context.lineTo(point[0], point[1]); else context.moveTo(point[0], point[1]);
      });
      context.setLineDash([6, 4]);
      context.strokeStyle = 'rgba(61,139,255,.75)';
      context.lineWidth = 1.6;
      context.stroke();
      context.setLineDash([]);
    }
    // 异物标记：画的是评估时刻的位置快照（决策 9-19），颜色只表示风险等级，不表示合法性。
    // 没有快照坐标就不画点——地图上多一个位置错误的标记，比少一个标记危险得多。
    if (spot) {
      const [x, y] = this.px(spot.longitude, spot.latitude);
      context.beginPath();
      context.arc(x, y, 5, 0, Math.PI * 2);
      context.fillStyle = spot.color;
      context.fill();
      context.beginPath();
      context.arc(x, y, 9, 0, Math.PI * 2);
      context.strokeStyle = spot.color + 'aa';
      context.lineWidth = 1.4;
      context.stroke();
    }
    context.restore();
  };
  const centre = spot ? [spot.longitude, spot.latitude] : line[Math.floor(line.length / 2)];
  map.centerAt(centre[0], centre[1]);
}

/* ---------- 交互 ---------- */
function selectRisk(riskId) { selectedId.value = riskId; }
function applyFilters() { loadList(1, ''); }
function changePage(next) { if (next !== page.value) loadList(next); }

function openVerify() {
  const risk = detail.value;
  if (!risk || !canVerify.value) return;
  const riskId = risk.risk_id;
  openRiskVerification({
    risk,
    refresh: async result => {
      if (result) await Promise.all([loadList(page.value, riskId), loadSummary()]);
      await loadDetail(riskId);
      return detail.value?.risk_id === riskId ? detail.value : null;
    }
  });
}

function scareNotAvailable() {
  toast('驱鸟处置尚未接入：设备指令与作业参数待设备方确认。', 'err');
}

watch(selectedId, id => { loadDetail(id); });

/* ---------- 深链（决策 9-15：'risk' 这个一次性键归本页消费） ----------
   两个来源：① 工作台与处罚页的"转风险"先 UI.stash 再改 hash，值在 UI.consume('risk') 的上下文里；
   ② 直接打开 #/risk?risk=<id>。先消费上下文（它是一次性的，读完即清），再看查询参数。 */
function deepLinkRiskId() {
  const context = window.UI?.consume?.('risk');
  if (context && typeof context === 'object') {
    // 上下文若带有写入时刻（生产者未来可能补），只接受本次导航写入的值，忽略陈旧滞留值；
    // 当前生产者不写时间戳，此时按现状消费。
    const stamp = Number(context.stashedAt ?? context.at ?? NaN);
    const fresh = Number.isNaN(stamp) || Date.now() - stamp <= STASH_MAX_AGE_MS;
    const requested = context.eventId || context.riskId || context.risk_id || context.risk;
    if (fresh && typeof requested === 'string' && requested) return requested;
  }
  const hash = window.location.hash || '';
  const query = hash.indexOf('?');
  if (query < 0) return '';
  return new URLSearchParams(hash.slice(query + 1)).get('risk') || '';
}

async function enter() {
  const requested = deepLinkRiskId();
  deepLinkMissed.value = false;
  await Promise.all([loadSubtypes(), loadSummary()]);
  // 带深链时不回落到首行：指定的风险不在当前筛选结果里，也不能改选另一条。
  await loadList(1, requested, !requested);
  if (!requested) return;
  if (selectedId.value === requested) { scrollToDetail(); return; }
  // 深链指向的风险可能不在第一页：单独回读它；可见才选中，不可见就明确提示，不静默换一条。
  try {
    await riskApi.getRisk(requested);
    selectedId.value = requested;
    scrollToDetail();
  } catch {
    deepLinkMissed.value = true;
  }
}

function scrollToDetail() {
  nextTick(() => detailPanel.value?.scrollIntoView({ block: 'nearest' }));
}

const accessChanged = () => { enter(); };
onMounted(() => {
  window.addEventListener('auth-access-change', accessChanged);
  enter();
  nextTick(renderMap);
});
onUnmounted(() => {
  window.removeEventListener('auth-access-change', accessChanged);
  destroyMap();
});
</script>

<template>
  <div class="view spacerisk-page" id="view">
    <div class="kpis">
      <div class="kpi is-blue"><span v-html="icon('bird')"></span><em>近 7 天异物事件</em><b>{{ kpi('total') }}</b></div>
      <div class="kpi is-red"><span v-html="icon('alert')"></span><em>高风险事件</em><b>{{ kpi('high_severity') }}</b></div>
      <div class="kpi is-amber"><span v-html="icon('alert')"></span><em>中风险事件</em><b>{{ kpi('medium_severity') }}</b></div>
      <div class="kpi is-green"><span v-html="icon('bird')"></span><em>鸟类事件</em><b>{{ kpi('bird_events') }}</b></div>
      <div class="kpi is-orange"><span v-html="icon('check')"></span><em>待核验</em><b>{{ kpi('pending_verification') }}</b></div>
      <div class="kpi is-purple"><span v-html="icon('zone')"></span><em>涉及航线</em><b>{{ kpi('routes_involved') }}</b></div>
    </div>
    <div v-if="summaryError" class="warnbox sr-inline-error">{{ summaryError }}</div>

    <div class="row sr-main">
      <section class="panel sr-map-panel">
        <div class="ph"><h3>风险事件与航线分布</h3><span class="sub">WGS-84</span></div>
        <div ref="mapHost" class="sr-map"></div>
        <div class="sr-legend">蓝色虚线是所选事件挂靠的航线，圆点是发现异物时的位置，颜色表示风险等级；没有位置记录时不标点。</div>
      </section>

      <section class="panel sr-list-panel">
        <div class="ph"><h3>风险事件与通报</h3><span class="sub">{{ total }} 起</span></div>
        <div class="toolbar sr-toolbar">
          <div class="tabs">
            <button type="button" class="tab" :class="{ on: activeTab === 'event' }" @click="activeTab = 'event'">风险事件</button>
            <button type="button" class="tab" :class="{ on: activeTab === 'notice' }" @click="activeTab = 'notice'">通报记录</button>
          </div>
          <div class="toolbar-fields">
            <div class="field"><label>异物细类</label><UControl v-model="filters.subtype" type="select" :options="subtypeOptions" :disabled="listLoading" size="small" /></div>
            <div class="field"><label>风险等级</label><UControl v-model="filters.severity" type="select" :options="severityOptions" :disabled="listLoading" size="small" /></div>
            <div class="field"><label>处置状态</label><UControl v-model="filters.state" type="select" :options="stateOptions" :disabled="listLoading" size="small" /></div>
          </div>
          <div class="toolbar-actions">
            <button class="btn" type="button" @click="applyFilters">筛选</button>
          </div>
        </div>

        <div v-if="activeTab === 'event'" class="sr-table-wrap">
          <div v-if="listError" class="empty">{{ listError }}<br><button class="btn" type="button" @click="loadList(1)">重试</button></div>
          <div v-else-if="listLoading && !rows.length" class="empty">正在读取风险事件…</div>
          <table v-else class="tb">
            <thead><tr>
              <th>编号</th><th>目标</th><th>异物细类</th><th>来源</th><th>区域 / 高度</th><th>最近航线</th><th>等级</th><th>状态</th>
            </tr></thead>
            <tbody>
              <tr v-for="row in rows" :key="row.risk_id" :class="{ on: selectedId === row.risk_id }" @click="selectRisk(row.risk_id)">
                <td class="num"><span :title="`${row.source_risk_id || ''} / ${row.risk_id}`">{{ riskNoText(row) }}</span></td>
                <td><span v-if="row.target_no" :title="row.target_id">{{ row.target_no }}</span><span v-else>—</span></td>
                <td>{{ row.space_fact ? labelOf(SPACE_OBJECT_SUBTYPE_LABEL, row.space_fact.subtype_code) : '—' }}</td>
                <td>{{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</td>
                <td>
                  <div>{{ row.district_name || '—' }}</div>
                  <div v-if="row.space_fact" class="sr-sub">{{ labelOf(ALTITUDE_BAND_LABEL, row.space_fact.altitude_band) }}</div>
                </td>
                <td><span v-if="row.plan_no" :title="row.route_version_id">{{ row.plan_no }}</span><span v-else>—</span></td>
                <td><span class="tag" :class="severityTag(row.severity)">{{ labelOf(SEVERITY_LABEL, row.severity) }}</span></td>
                <td>{{ labelOf(RISK_STATE_LABEL, row.state) }}</td>
              </tr>
              <tr v-if="!rows.length"><td colspan="8" class="empty">当前筛选条件下没有异物风险事件</td></tr>
            </tbody>
          </table>
          <!-- UPagination 的 size 是尺寸档位（small/medium），每页条数走 page-size；item-count 才是总数（阶段 9 验收修复）。 -->
          <UPagination :item-count="total" :page="page" :page-size="PAGE_SIZE" @update:page="changePage" />
        </div>

        <div v-else class="sr-table-wrap">
          <div v-if="noticesError" class="empty">{{ noticesError }}</div>
          <table v-else class="tb">
            <thead><tr><th>接收方</th><th>通报类型</th><th>提交时间</th><th>投递状态</th></tr></thead>
            <tbody>
              <tr v-for="notice in notices" :key="notice.handoff_id">
                <td><span :title="notice.handoff_id">{{ notice.recipient_name || '—' }}</span></td>
                <td>{{ labelOf(HANDOFF_TYPE_LABEL, notice.handoff_type) }}</td>
                <td>{{ fmt(notice.created_at) }}</td>
                <td>{{ labelOf(DELIVERY_STATUS_LABEL, notice.delivery_status) }}</td>
              </tr>
              <tr v-if="!notices.length"><td colspan="4" class="empty">所选事件还没有通报记录</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel sr-detail-panel" ref="detailPanel">
        <div class="ph"><h3>风险详情</h3><span v-if="detail" class="tag" :class="severityTag(detail.severity)">{{ labelOf(SEVERITY_LABEL, detail.severity) }}</span></div>
        <div v-if="detailError" class="empty">{{ detailError }}</div>
        <div v-else-if="deepLinkMissed && !detail" class="empty">未找到指定的风险事件，或它不在您的数据范围内。请从左侧列表选择。</div>
        <div v-else-if="!detail" class="empty">请选择左侧事件查看详情</div>
        <div v-else class="sr-detail">
          <div class="detail-hero">
            <span class="detail-hero-icon" v-html="icon('bird')"></span>
            <div class="detail-hero-copy">
              <h4>{{ spaceFact ? labelOf(SPACE_OBJECT_SUBTYPE_LABEL, spaceFact.subtype_code) : '空中异物' }}</h4>
              <p :title="`${detail.source_risk_id || ''} / ${detail.risk_id}`">{{ riskNoText(detail) }}</p>
            </div>
            <div class="detail-hero-side">
              <div class="detail-hero-tags">
                <span class="tag t-cyan">{{ labelOf(RISK_STATE_LABEL, detail.state) }}</span>
                <span v-if="ruleBadge" class="tag t-gray">{{ ruleBadge }}</span>
              </div>
            </div>
          </div>

          <dl class="kv">
            <dt>发现时间</dt><dd>{{ fmt(detail.occurred_at ?? detail.received_at) }}</dd>
            <dt>所属区域</dt><dd>{{ detail.district_name || '—' }}</dd>
            <dt>关联计划</dt><dd><span v-if="detail.plan_no" :title="detail.plan_id">{{ detail.plan_no }}</span><span v-else>—</span></dd>
            <dt v-if="detail.target_no">关联目标</dt><dd v-if="detail.target_no"><span :title="detail.target_id">{{ detail.target_no }}</span></dd>
            <dt v-if="verificationOrdinal(detail.version)">核验进度</dt>
            <dd v-if="verificationOrdinal(detail.version)">{{ verificationOrdinal(detail.version) }}</dd>
          </dl>

          <div class="sect"><h5>判定依据</h5>
            <dl v-if="spaceFact" class="kv">
              <dt>与航线关系</dt><dd>{{ labelOf(CORRIDOR_RELATION_LABEL, spaceFact.corridor_relation) }}<span v-if="spaceFact.distance_to_route_m != null"> · 距中心线 {{ metres(spaceFact.distance_to_route_m) }}</span></dd>
              <dt>高度带</dt><dd>{{ labelOf(ALTITUDE_BAND_LABEL, spaceFact.altitude_band) }}<span v-if="spaceFact.altitude_datum"> · {{ spaceFact.altitude_datum }}</span></dd>
              <dt v-if="spaceFact.object_count != null">数量</dt>
              <dd v-if="spaceFact.object_count != null">约 {{ spaceFact.object_count }}</dd>
              <dt>数量趋势</dt><dd>{{ labelOf(OBJECT_TREND_LABEL, spaceFact.trend) }}</dd>
              <dt v-if="unknownNotes.length">尚缺事实</dt>
              <dd v-if="unknownNotes.length">{{ unknownNotes.join('、') }}（不参与等级上调）</dd>
              <dt>观察窗口</dt><dd>{{ shortTime(spaceFact.window_from) }} — {{ shortTime(spaceFact.window_to) }}</dd>
            </dl>
            <div v-else class="empty">该事件没有异物判定记录</div>
            <p v-if="detail.reason_text" class="sr-reason">{{ detail.reason_text }}</p>
          </div>

          <div class="sr-actions">
            <button class="btn pri" type="button" :disabled="!canVerify" @click="openVerify">人工核验</button>
            <button class="btn" type="button" disabled title="设备指令与作业参数待设备方确认" @click="scareNotAvailable">驱鸟处置（尚未接入）</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.spacerisk-page .sr-main { margin-top: 12px; height: calc(100vh - 314px); min-height: 578px; }
.spacerisk-page .sr-map-panel { flex: 0.82; display: flex; flex-direction: column; min-width: 0; }
.spacerisk-page .sr-map { flex: 1; min-height: 0; }
.spacerisk-page .sr-legend { flex: none; padding: 4px 8px; font-size: 10.5px; color: var(--txt-3); }
.spacerisk-page .sr-list-panel { flex: 1.7; display: flex; flex-direction: column; min-width: 0; }
.spacerisk-page .sr-detail-panel { width: 30%; min-width: 340px; flex: none; display: flex; flex-direction: column; }
.spacerisk-page .sr-table-wrap { flex: 1; overflow: auto; min-height: 0; }
.spacerisk-page .sr-detail { flex: 1; overflow: auto; padding: 12px; }
.spacerisk-page .sr-sub { font-size: 11px; color: var(--txt-3); }
.spacerisk-page .sr-reason { margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: var(--txt-2); }
.spacerisk-page .sr-actions { display: flex; gap: 8px; margin-top: 12px; }
.spacerisk-page .sr-inline-error { margin-top: 10px; }
</style>
