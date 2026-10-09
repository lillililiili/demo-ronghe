<script setup>
/* 运行统计 —— 第一个转换为真 Vue 组件的页面（源：legacy pages/stats.js）。
   转换约定：
   · 结构进 template，图表初始化进数据到达后的 drawCharts（等价 legacy mount 时机）
   · 数值/标签等叶子仍用 window.UI 的字符串生成器（U.num/U.table）
   · 时间范围由服务端按北京时间统计，列表与导出使用同一范围
   · 外壳职责（面包屑/导航组/卸载清理）统一走 usePageChrome
   · 图表与 KPI 读取 GET /api/v1/stats/operations，失败不回退 mock.js */
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { refreshFailureText, useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import UField from '@/components/form/UField.vue';
import UFilterBar from '@/components/form/UFilterBar.vue';
import { statsApi } from '@/services/statsApi.js';
import { toast } from '@/ui/nv.js';

const U = window.UI;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
usePageChrome('stats');

const initialReport = statsApi.cachedOperations();
let pageAccessVersion = statsApi.accessVersion();
const S = shallowRef(initialReport);
// 统计口径（2026-10-07 起）：真实设备和设备模拟器的数据都算，系统自带的演示样例不算；正式环境只有真实设备。
const sourceLabel = computed(() => ({ live: '数据来源：真实设备', replay: '数据来源：设备模拟器', mixed: '数据来源：真实设备和设备模拟器', mock: '数据来源：系统自带的演示样例', unknown: '所选时间内暂无数据' }[S.value?.sourceMode] || '数据来源未明确'));
const generatedLabel = computed(() => S.value?.generatedAt ? new Date(S.value.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '未知');
function metricNumber(value) { return value == null ? '暂不可统计' : U.num(value); }
function metricReason(key) { return S.value?.availability?.[key]?.reason || '暂无可靠统计说明'; }
function metricVisible(key) { return S.value?.availability?.[key]?.status !== 'UNAVAILABLE'; }
const loading = ref(true);
const exporting = ref(false);
const reportRange = data => data ? [Date.parse(`${data.from}T00:00:00`), Date.parse(`${data.to}T00:00:00`)] : null;
const dateRange = ref(reportRange(initialReport));
const error = ref('');
let cancelled = false;
const isCount = value => Number.isInteger(value) && value >= 0;
const metricAvailable = key => ['AVAILABLE', 'PARTIAL'].includes(S.value?.availability?.[key]?.status);
const illegalShareAvailable = computed(() => metricAvailable('total') && metricAvailable('illegal')
  && isCount(S.value?.total) && isCount(S.value?.illegal) && S.value.illegal <= S.value.total
  && S.value.days.length > 0
  && S.value.days.every(day => isCount(day.total) && isCount(day.illegal) && day.illegal <= day.total)
  && S.value.days.reduce((total, day) => total + day.total, 0) === S.value.total
  && S.value.days.reduce((total, day) => total + day.illegal, 0) === S.value.illegal);
const illegalShareReason = computed(() => !metricAvailable('total') ? metricReason('total')
  : !metricAvailable('illegal') ? metricReason('illegal') : '每日目标统计不完整，暂无法计算占比');
const unknownLegalityCount = computed(() => S.value?.availability?.illegal?.missing_count);
const highRiskTrendAvailable = computed(() => metricAvailable('high_risk') && isCount(S.value?.highRisk)
  && S.value.days.length > 0 && S.value.days.every(day => isCount(day.highRisk))
  && S.value.days.reduce((total, day) => total + day.highRisk, 0) === S.value.highRisk);
const highRiskTrendReason = computed(() => metricAvailable('high_risk')
  ? '每日风险统计不完整，暂无法展示趋势' : metricReason('high_risk'));
const unknownRiskCount = computed(() => S.value?.availability?.high_risk?.missing_count);
const deviceStates = computed(() => {
  const devices = S.value?.devices;
  if (!metricAvailable('devices') || !devices || !isCount(devices.total) || !isCount(devices.online)
    || devices.online > devices.total) return null;
  return [{ name: '在线', value: devices.online }, { name: '非在线', value: devices.total - devices.online }];
});
const deviceStateReason = computed(() => metricAvailable('devices')
  ? '设备状态统计不完整，暂无法展示分布' : metricReason('devices'));

const kpiList = computed(() => {
  if (!S.value) return [];
  const stats = S.value;
  const devices = stats.devices;
  return [
    { label: '新增目标数', value: metricNumber(stats.total), color: 'blue', icon: 'radar' },
    { label: '非法目标数', value: metricNumber(stats.illegal), color: 'red', icon: 'alert' },
    { label: '处罚案件数', value: metricNumber(stats.punish), color: 'orange', icon: 'gavel' },
    { label: '接入设备总数', value: metricNumber(devices ? devices.total : null), color: 'cyan', icon: 'device' },
    { label: '异物高风险目标数', value: metricNumber(stats.highRisk), color: 'red', icon: 'zone' }
  ];
});

function regionTable() {
  const stats = S.value;
  if (!stats) return '';
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-amber', 't-gray', 't-orange'][i]}">${i + 1}</span>` : i + 1 },
    { t: '区域', w: '74px', render: r => escapeHtml(r.name) },
    { t: '目标', align: 'center', cls: 'num', render: r => metricNumber(r.total) },
    { t: '非法', align: 'center', cls: 'num', render: r => `<span style="color:#ff8b95">${metricNumber(r.illegal)}</span>` },
    { t: '案件', align: 'center', cls: 'num', render: r => metricNumber(r.punish) },
    { t: '异物高危', align: 'center', cls: 'num', render: r => `<span style="color:#ffb083">${metricNumber(r.highRisk)}</span>` }
  ], stats.regions).replace('</table>', `<tfoot><tr>
    <td colspan="2">合计</td>
    <td class="num"><div class="table-text" tabindex="0">${metricNumber(stats.total)}</div></td>
    <td class="num"><div class="table-text" tabindex="0">${metricNumber(stats.illegal)}</div></td>
    <td class="num"><div class="table-text" tabindex="0">${metricNumber(stats.punish)}</div></td>
    <td class="num"><div class="table-text" tabindex="0">${metricNumber(stats.highRisk)}</div></td>
  </tr></tfoot></table>`);
}

function pctOf(value, total) {
  if (!total) return '0.0';
  return (value / total * 100).toFixed(1);
}

let renderedDataKey = '';
let regionView = 'list';
function renderCharts() {
  if (!S.value) return;
  const key = JSON.stringify({ ...S.value, generatedAt: null });
  if (key === renderedDataKey) return;
  window.CH.disposeAll?.();
  drawCharts(window.CH);
  renderedDataKey = key;
}

function drawCharts(CH) {
  const stats = S.value;
  if (!stats) return;
  CH.line(document.getElementById('sTrend'), {
    x: stats.days.map(d => d.md), yName: '目标数',
    series: [
      { name: '新增目标数', data: stats.days.map(d => d.total), color: CH.C.blue, area: true },
      { name: '非法目标数', data: stats.days.map(d => d.illegal), color: CH.C.red }
    ]
  });
  const rc = { '超高风险': CH.C.red, '高风险': CH.C.red, '中风险': CH.C.amber, '低风险': CH.C.blue, '未识别': CH.C.gray };
  if (metricVisible('by_risk')) CH.bar(document.getElementById('sRisk'), {
    x: stats.byRisk.map(r => r.name === '未识别' ? '风险等级\n未知' : r.name), legend: false, yName: '数量',
    grid: { top: 36, bottom: 40 },
    series: [{ name: '数量', data: stats.byRisk.map(r => r.value), colorBy: p => rc[stats.byRisk[p.dataIndex].name] }]
  })?.setOption({ xAxis: { axisLabel: { interval: 0, fontSize: 10 } }, yAxis: { minInterval: 1 } });
  if (metricVisible('by_type')) {
    const total = stats.byType.reduce((sum, item) => sum + item.value, 0);
    CH.donut(document.getElementById('sType'), { data: stats.byType, center: ['30%', '50%'] })?.setOption({
      series: [{ stillShowZeroSum: false }],
      legend: {
        textStyle: { overflow: 'breakAll', lineHeight: 16 },
        formatter: name => {
          const item = stats.byType.find(row => row.name === name);
          return item ? `${name}  ${item.value.toLocaleString()} (${pctOf(item.value, total)}%)` : name;
        }
      }
    });
  }
  drawRegion(CH);
  if (illegalShareAvailable.value && stats.total > 0) CH.line(document.getElementById('sIllegalShare'), {
    x: stats.days.map(day => day.md), legend: false, yName: '占比',
    grid: { left: 48, top: 28, bottom: 28 },
    series: [{ name: '非法目标占比', data: stats.days.map(day => day.total ? day.illegal * 100 / day.total : null),
      color: CH.C.red, smooth: false }]
  })?.setOption({
    yAxis: { min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
    xAxis: { axisLabel: { hideOverlap: true } },
    tooltip: { renderMode: 'richText', formatter: points => {
      const day = stats.days[points[0]?.dataIndex];
      if (!day) return '';
      return day.total
        ? `${day.date}\n非法目标占比：${pctOf(day.illegal, day.total)}%\n已判非法：${day.illegal} 个 / 新增目标：${day.total} 个`
        : `${day.date}\n无新增目标，未计算占比`;
    } }
  });
  if (highRiskTrendAvailable.value) CH.bar(document.getElementById('sHighRiskTrend'), {
    x: stats.days.map(day => day.md), legend: false, yName: '目标数',
    grid: { top: 28, bottom: 28 },
    series: [{ name: '异物高风险目标', data: stats.days.map(day => day.highRisk), color: CH.C.red, label: false }]
  })?.setOption({ yAxis: { minInterval: 1 }, xAxis: { axisLabel: { hideOverlap: true } } });
  if (deviceStates.value && stats.devices.total > 0) CH.donut(document.getElementById('sDeviceStates'), {
    data: deviceStates.value, colors: [CH.C.cyan, CH.C.gray],
    center: ['32%', '50%'], centerLabel: '在线率',
    centerValue: `${(stats.devices.online * 100 / stats.devices.total).toFixed(1)}%`
  })?.setOption({
    series: [{ stillShowZeroSum: false }],
    legend: { textStyle: { overflow: 'breakAll', lineHeight: 18 } }
  });
}

let loadSequence = 0;
/* quiet：实时刷新重算；失败时保留上次的统计并说明，错误抛给实时刷新按退避重试。 */
async function load({ quiet = false } = {}) {
  const sequence = ++loadSequence;
  loading.value = true;
  error.value = '';
  try {
    const range = dateRange.value;
    /* 日期框选的是"哪一天"，不是某个时刻。naive 的 daterange 按浏览器本地时区渲染时间戳，
       所以初值和回读都按本地自然日来：以前初值写死 +08:00、回读又按 Asia/Shanghai 格式化，
       浏览器不在 +8 时框里显示的日期会比实际统计的差一天（TC-RPT-001 现场记录）。
       这几天按北京自然日统计——标签已写明，后端也这样解释，所以选中的那一天原样送过去。 */
    const date = value => new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
    const query = range?.length === 2 ? { from: date(range[0]), to: date(range[1]) } : {};
    // 切换统计区间时不能把上一日期的数字放在新筛选下；同区间刷新保留内容。
    if (S.value && (S.value.from !== query.from || S.value.to !== query.to)) {
      S.value = statsApi.cachedOperations(query);
      renderedDataKey = '';
      window.CH.disposeAll?.();
    }
    const data = await statsApi.operations(query);
    if (cancelled || sequence !== loadSequence) return;
    S.value = data;
    if (!dateRange.value) dateRange.value = reportRange(data);
    await nextTick();
    if (cancelled || sequence !== loadSequence) return;
    renderCharts();
  } catch (e) {
    if (cancelled || sequence !== loadSequence) return;
    if (S.value && ![401, 403].includes(e?.status) && e?.code !== 'SESSION_CHANGED') {
      error.value = `统计更新失败（${refreshFailureText(e, '运行统计加载失败')}）；下面是上次读到的统计。`;
      if (quiet) throw e;
      return;
    }
    S.value = null;
    renderedDataKey = '';
    error.value = e.message || '运行统计加载失败。';
    if (quiet) throw e;
  } finally {
    if (!cancelled && sequence === loadSequence) loading.value = false;
  }
}

function onAccessChanged() {
  if (pageAccessVersion === statsApi.accessVersion()) return;
  pageAccessVersion = statsApi.accessVersion();
  S.value = null;
  renderedDataKey = '';
  window.CH?.disposeAll?.();
  load();
}
onMounted(() => {
  renderCharts();
  window.addEventListener('auth-access-change', onAccessChanged);
  load();
});
// 统计为按日聚合，业务数据变化后最多每 10 秒重算一次，避免图表频繁重绘。
useRealtimeRefresh(['alarm', 'target', 'punishment', 'device', 'plan', 'risk'], () => (loading.value ? undefined : load({ quiet: true })), { minIntervalMs: 10_000 });
onUnmounted(() => {
  cancelled = true;
  window.removeEventListener('auth-access-change', onAccessChanged);
  window.CH?.disposeAll?.();
});

async function exportCsv() {
  if (!S.value || exporting.value) return;
  exporting.value = true;
  try {
    const report = S.value;
    const blob = await statsApi.exportCsv({ from: report.from, to: report.to });
    if (!blob) throw new Error('导出失败');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `运行统计-${report.from}-${report.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('运行统计已导出', 'ok');
  } catch (e) {
    toast(e.message || '导出失败', 'err');
  } finally {
    exporting.value = false;
  }
}

function onRegionTab(e) {
  const el = e.target.closest('[data-rt]');
  if (!el || !S.value) return;
  regionView = el.dataset.rt;
  drawRegion(window.CH);
}

function drawRegion(CH) {
  const box = document.getElementById('sRegion');
  if (!box) return;
  document.getElementById('view')?.querySelectorAll('[data-rt]').forEach(el => el.classList.toggle('on', el.dataset.rt === regionView));
  if (CH.disposeEl) CH.disposeEl(box);
  if (regionView === 'list') { box.style.minHeight = ''; box.innerHTML = regionTable(); }
  else {
    box.innerHTML = '';
    box.style.minHeight = `${Math.max(240, S.value.regions.length * 44)}px`;
    const chart = CH.hbar(box, {
      y: S.value.regions.map(r => r.name), data: S.value.regions.map(r => r.total),
      grid: { left: 150 },
      colors: S.value.regions.map(r => r.total && r.illegal / r.total > .05 ? '#ff4d5e' : '#3d8bff')
    });
    chart?.setOption({ yAxis: { axisLabel: { width: 140, overflow: 'breakAll', interval: 0 } } });
  }
}
</script>

<template>
  <div class="view stats-page" id="view">
    <div v-if="error" class="warnbox" role="alert" style="margin-bottom:12px;display:flex;align-items:center;gap:12px">
      <span>{{ error }}</span>
      <button class="btn" type="button" @click="load">重试</button>
    </div>
    <div class="panel mb12" style="flex:none"><UFilterBar class="stats-filters">
        <UField id="stats-range" v-model="dateRange" class="stats-date-filter" type="daterange" label="统计日期（北京时间）" variant="filter" @update:model-value="load" />
      <template #actions><button class="btn pri" id="stExp" :disabled="loading || !S || exporting" @click="exportCsv">{{ exporting ? '正在导出' : '导出数据' }}</button></template>
    </UFilterBar></div>

    <div v-if="loading && !S" class="panel stats-loading" role="status" aria-live="polite">正在加载运行统计，请稍候</div>
    <div v-if="S" class="stats-basis">{{ sourceLabel }} · 生成于 {{ generatedLabel }}；目标按首次发现时间归属，合法性与风险为生成时状态。<span v-if="loading" role="status">正在更新，当前显示上次统计。</span></div>
    <UKpis v-if="S" :list="kpiList" class-name="stats-primary-kpis" />

    <div v-if="S" class="stats-chart-grid stats-overview-grid">
      <UPanel title="目标趋势" panel-style="flex:1.5">
        <div id="sTrend" style="height:100%"></div>
      </UPanel>
      <UPanel title="各异物风险等级分布" sub="目标数" panel-style="flex:.75"><div v-if="!metricVisible('by_risk')" class="stats-unavailable">暂不可统计<br>{{ metricReason('by_risk') }}</div><div v-else id="sRisk" style="height:100%"></div></UPanel>
      <UPanel title="各类型目标占比" panel-style="flex:1.25"><div v-if="!metricVisible('by_type')" class="stats-unavailable">暂不可统计<br>{{ metricReason('by_type') }}</div><div v-else id="sType" style="height:100%"></div></UPanel>
    </div>

    <div v-if="S" class="stats-chart-grid stats-details-grid">
      <UPanel title="每日非法目标占比" sub="已判非法 / 当日新增目标">
        <div v-if="!illegalShareAvailable" class="stats-unavailable">暂不可统计<br>{{ illegalShareReason }}</div>
        <div v-else-if="S.total === 0" class="stats-unavailable">统计区间内无新增目标，未计算占比</div>
        <template v-else>
          <div class="stats-note">所选区间占比 {{ pctOf(S.illegal, S.total) }}%；无新增目标的日期留空<span v-if="isCount(unknownLegalityCount) && unknownLegalityCount > 0">；含 {{ unknownLegalityCount }} 个合法性未知目标</span>。</div>
          <div id="sIllegalShare" class="stats-detail-chart" role="img" :aria-label="`每日非法目标占比，所选区间已判非法 ${S.illegal} 个，新增目标 ${S.total} 个，占比 ${pctOf(S.illegal, S.total)}%`"></div>
        </template>
      </UPanel>
      <UPanel title="每日异物高风险目标趋势" sub="高风险及超高风险">
        <div v-if="!highRiskTrendAvailable" class="stats-unavailable">暂不可统计<br>{{ highRiskTrendReason }}</div>
        <template v-else>
          <div class="stats-note">按首次发现日期归属，风险等级取生成时最新结果<span v-if="isCount(unknownRiskCount) && unknownRiskCount > 0">；{{ unknownRiskCount }} 个目标风险等级未知</span>。</div>
          <div id="sHighRiskTrend" class="stats-detail-chart" role="img" :aria-label="`每日异物高风险目标趋势，统计区间合计 ${S.highRisk} 个目标`"></div>
        </template>
      </UPanel>
      <UPanel title="设备在线状态分布" sub="当前设备快照">
        <div v-if="!deviceStates" class="stats-unavailable">暂不可统计<br>{{ deviceStateReason }}</div>
        <div v-else-if="S.devices.total === 0" class="stats-unavailable">当前无台账设备</div>
        <template v-else>
          <div class="stats-note">当前状态，不按所选日期累计。</div>
          <div id="sDeviceStates" class="stats-detail-chart" role="img" :aria-label="`设备在线状态分布：在线 ${deviceStates[0].value} 台，非在线 ${deviceStates[1].value} 台`"></div>
        </template>
      </UPanel>
    </div>

    <div v-if="S" class="stats-summary-grid">
      <UPanel title="区域分布" sub="业务归属区域" class="stats-region" nopad @click="onRegionTab"
        :extra="`<div class=&quot;tabs&quot; style=&quot;border:0&quot;><button type=&quot;button&quot; class=&quot;tab&quot; data-rt=&quot;chart&quot;>区域数量对比</button><button type=&quot;button&quot; class=&quot;tab on&quot; data-rt=&quot;list&quot;>排行表</button></div>`">
        <div id="sRegion" class="stats-region-content"></div>
      </UPanel>
    </div>
  </div>
</template>

<style scoped>
.stats-filters { border: 0; }
.stats-loading { min-height:116px;display:flex;align-items:center;justify-content:center;color:var(--txt-2); }
.stats-date-filter { --filter-field-width: 340px; }
.stats-page { container-type:inline-size; }
.stats-page :deep(.stats-primary-kpis) { grid-template-columns:repeat(5, minmax(0, 1fr)); }
.stats-page :deep(.stats-primary-kpis .kpi) { min-height:116px;padding:18px;gap:16px; }
.stats-page :deep(.stats-primary-kpis .ic) { width:56px;height:56px; }
.stats-page :deep(.stats-primary-kpis .ic svg) { width:30px;height:30px;stroke-width:1.8; }
.stats-page :deep(.stats-primary-kpis .lb) { color:var(--txt);font-size:18px;font-weight:600;line-height:1.4; }
.stats-page :deep(.stats-primary-kpis .vl) { margin-top:5px;font-size:42px;font-weight:700;line-height:1.15; }
@container (max-width:1180px) {
  .stats-page :deep(.stats-primary-kpis) { grid-template-columns:repeat(3, minmax(0, 1fr)); }
}
@container (max-width:760px) {
  .stats-page :deep(.stats-primary-kpis) { grid-template-columns:repeat(2, minmax(0, 1fr)); }
}
@container (max-width:480px) {
  .stats-page :deep(.stats-primary-kpis) { grid-template-columns:minmax(0, 1fr); }
}
.stats-summary-grid { display:grid;grid-template-columns:minmax(0, 1fr);gap:14px;margin-top:12px;padding-bottom:12px; }
.stats-summary-grid > .panel { height:320px; }
.stats-summary-grid :deep(.ph) { min-height:52px;flex-wrap:wrap; }
.stats-summary-grid :deep(.ph h3) { white-space:normal; }
.stats-region-content { display:flex;flex-direction:column;flex:1;min-height:0; }
/* 此处按指标分配列宽，覆盖 table-fluid 的全局自动列宽；长文字仍完整换行。 */
.stats-summary-grid :deep(table.tb) { width:100%;table-layout:fixed !important; }
.stats-summary-grid :deep(table.tb th), .stats-summary-grid :deep(table.tb td) { white-space:normal;overflow-wrap:anywhere; }
.stats-summary-grid :deep(table.tb th:first-child) { width:46px !important; }
.stats-region :deep(table.tb th:nth-child(n+3)) { width:14% !important; }
.stats-region :deep(table.tb tfoot td) { position:sticky;bottom:0;z-index:2;background:var(--surface-1);border-top:1px solid var(--line);font-weight:600; }
.stats-region :deep(table.tb tfoot td.num) { text-align:center; }
.stats-chart-grid { display:grid;gap:14px;margin-top:12px; }
.stats-overview-grid { grid-template-columns:minmax(0, 1.5fr) minmax(0, .85fr) minmax(0, 1.25fr); }
.stats-details-grid { grid-template-columns:minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr); }
.stats-chart-grid > .panel { height:310px; }
.stats-chart-grid :deep(.ph) { flex-wrap:wrap; }
.stats-chart-grid :deep(.ph h3) { white-space:normal; }
.stats-details-grid :deep(.pb) { display:flex;flex-direction:column; }
.stats-detail-chart { flex:1;min-height:170px; }
@container (max-width:1200px) {
  .stats-overview-grid,.stats-details-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .stats-overview-grid > :first-child,.stats-details-grid > :last-child { grid-column:1 / -1; }
}
@container (max-width:680px) {
  .stats-summary-grid,.stats-overview-grid,.stats-details-grid { grid-template-columns:minmax(0, 1fr); }
}
.stats-basis,.stats-note { color:var(--txt-3);font-size:12px;line-height:1.5;overflow-wrap:anywhere;margin-bottom:8px; }
:deep(.kpi .dt), :deep(.kpi .vl) { white-space:normal;overflow-wrap:anywhere; }
.stats-unavailable { height:100%;display:flex;flex-direction:column;justify-content:center;text-align:center;padding:16px;box-sizing:border-box;color:var(--txt-3);line-height:1.8;overflow-wrap:anywhere; }
</style>
