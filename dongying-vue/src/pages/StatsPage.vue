<script setup>
/* 运行统计 —— 第一个转换为真 Vue 组件的页面（源：legacy pages/stats.js）。
   转换约定：
   · 结构进 template，图表初始化进数据到达后的 drawCharts（等价 legacy mount 时机）
   · 数值/标签等叶子仍用 window.UI 的字符串生成器（U.num/U.table）
   · 工具条不再放没有切片数据的时间/类型/区域下拉，避免点了数字不变
   · 外壳职责（面包屑/导航组/卸载清理）统一走 usePageChrome
   · 图表与 KPI 读取 GET /api/v1/stats/operations，失败不回退 mock.js */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { statsApi } from '@/services/statsApi.js';
import { toast } from '@/ui/nv.js';

const U = window.UI;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
usePageChrome('stats');

const S = ref(null);
const sourceLabel = computed(() => ({ mock: '模拟记录', replay: '回放记录', live: '现场记录', mixed: '混合来源（含模拟或回放时保留标识）', unknown: '暂无来源记录' }[S.value?.sourceMode] || '来源未明确'));
const generatedLabel = computed(() => S.value?.generatedAt ? new Date(S.value.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '未知');
function metricNumber(value) { return value == null ? '暂不可统计' : U.num(value); }
function metricReason(key) { return S.value?.availability?.[key]?.reason || '暂无可靠统计说明'; }
function metricVisible(key) { return S.value?.availability?.[key]?.status !== 'UNAVAILABLE'; }
const loading = ref(true);
const exporting = ref(false);
const error = ref('');
let cancelled = false;
const isCount = value => Number.isInteger(value) && value >= 0;
const caseTrendAvailable = computed(() => metricVisible('punish') && isCount(S.value?.punish)
  && S.value?.days.length > 0 && S.value.days.every(day => isCount(day.punish)));
const penaltyResults = computed(() => {
  const stats = S.value;
  if (!stats || !metricVisible('by_penalty') || !metricVisible('punish')) return null;
  const missing = stats.availability.by_penalty?.missing_count;
  if (!isCount(stats.punish) || !isCount(missing) || !stats.byPenalty.every(item => isCount(item.value))) return null;
  const confirmed = stats.byPenalty.reduce((sum, item) => sum + item.value, 0);
  // 同一批立案案件必须被完整覆盖；字段缺失或总数不一致时不推算结果比例。
  if (confirmed + missing !== stats.punish) return null;
  return [...stats.byPenalty.map(item => ({ ...item, pending: false })),
    { name: '未形成有效处罚结果', value: missing, pending: true }];
});
const penaltyUnavailableReason = computed(() => !metricVisible('punish') ? metricReason('punish')
  : !metricVisible('by_penalty') ? metricReason('by_penalty') : '处罚结果统计不完整，暂无法展示案件构成');

const toolbarHtml = computed(() => {
  const range = S.value
    ? `${S.value.from} 至 ${S.value.to}（当前权限范围）`
    : (loading.value ? '正在加载' : '—');
  const disabled = !S.value || exporting.value ? ' disabled' : '';
  return `<div class="toolbar-fields">${U.field('统计区间', `<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px">${range}</span>`)}</div>
      <div class="toolbar-actions">
      <button class="btn pri" id="stExp"${disabled}>${U.icon('download')} 导出数据</button>
      </div>`;
});

const kpiList = computed(() => {
  if (!S.value) return [];
  const stats = S.value;
  const devices = stats.devices;
  const deviceDesc = !devices
    ? metricReason('devices')
    : devices.total
      ? `当前快照 · 在线 ${devices.online} · ${devices.onlineRate == null ? '—' : devices.onlineRate + '%'}`
      : '当前无台账设备';
  return [
    { label: '新增目标数', value: metricNumber(stats.total), color: 'blue', icon: 'radar', desc: metricReason('total') },
    { label: '非法目标数', value: metricNumber(stats.illegal), color: 'red', icon: 'alert', desc: metricReason('illegal') },
    { label: '处罚案件数', value: metricNumber(stats.punish), color: 'orange', icon: 'gavel', desc: metricReason('punish') },
    { label: '接入设备总数', value: metricNumber(devices ? devices.total : null), color: 'cyan', icon: 'device', desc: deviceDesc },
    { label: '高风险目标数', value: metricNumber(stats.highRisk), color: 'red', icon: 'zone', desc: metricReason('high_risk') }
  ].map(item => ({ ...item, caption: escapeHtml(item.desc), desc: undefined }));
});

const rankHtml = computed(() => {
  if (!S.value) return '';
  const top = S.value.partners || [];
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-red', 't-orange', 't-amber'][i]}">${i + 1}</span>` : i + 1 },
    { t: '主体', w: '118px', render: r => `<div style="white-space:normal;overflow-wrap:anywhere" title="${escapeHtml(r.name)}">${
      r.name.includes('未知') ? `<span style="color:#ff8b95">${escapeHtml(r.name)}</span>` : escapeHtml(r.name)}</div>` },
    { t: '案件', w: '64px', align: 'center', cls: 'num', render: r => metricNumber(r.n) }
  ], top);
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
    { t: '高危', align: 'center', cls: 'num', render: r => `<span style="color:#ffb083">${metricNumber(r.highRisk)}</span>` }
  ], stats.regions).replace('</table>', `<tfoot><tr>
    <td colspan="2">合计</td>
    <td class="num">${metricNumber(stats.total)}</td>
    <td class="num">${metricNumber(stats.illegal)}</td>
    <td class="num">${metricNumber(stats.punish)}</td>
    <td class="num">${metricNumber(stats.highRisk)}</td>
  </tr></tfoot></table>`);
}

function pctOf(value, total) {
  if (!total) return '0.0';
  return (value / total * 100).toFixed(1);
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
  if (metricVisible('by_type')) CH.donut(document.getElementById('sType'), { data: stats.byType, center: ['30%', '50%'] });
  const regionBox = document.getElementById('sRegion');
  if (regionBox) regionBox.innerHTML = regionTable();
  if (metricVisible('alt_bands') && stats.altTotal > 0) CH.bar(document.getElementById('sAlt'), {
    x: stats.altBands.map(d => d.name), legend: false, yName: '目标数',
    grid: { top: 44, bottom: 28 },
    series: [{ name: '目标数', data: stats.altBands.map(d => d.value), color: CH.C.blue,
      fmt: p => p.value + '\n' + pctOf(p.value, stats.altTotal) + '%' }]
  })?.setOption({ xAxis: { axisLabel: { interval: 0, fontSize: 10 } }, yAxis: { minInterval: 1 } });
  if (caseTrendAvailable.value) CH.bar(document.getElementById('sCases'), {
    x: stats.days.map(day => day.md), legend: false, yName: '案件数',
    grid: { top: 36, bottom: 28 },
    series: [{ name: '立案数量', data: stats.days.map(day => day.punish), color: CH.C.amber, label: false }]
  })?.setOption({ yAxis: { minInterval: 1 } });
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await statsApi.operations();
    if (cancelled) return;
    S.value = data;
    await nextTick();
    if (cancelled) return;
    if (window.CH.disposeAll) window.CH.disposeAll();
    drawCharts(window.CH);
  } catch (e) {
    if (cancelled) return;
    S.value = null;
    error.value = e.message || '运行统计加载失败。';
  } finally {
    if (!cancelled) loading.value = false;
  }
}

onMounted(load);
onUnmounted(() => { cancelled = true; window.CH?.disposeAll?.(); });

async function exportCsv() {
  if (!S.value || exporting.value) return;
  exporting.value = true;
  try {
    const blob = await statsApi.exportCsv({ from: S.value.from, to: S.value.to });
    if (!blob) throw new Error('导出失败');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `运行统计-${S.value.from}-${S.value.to}.csv`;
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

function onToolbarClick(e) {
  if (e.target.closest('#stExp')) exportCsv();
}
function onRegionTab(e) {
  const el = e.target.closest('[data-rt]');
  if (!el || !S.value) return;
  const view = document.getElementById('view');
  view.querySelectorAll('[data-rt]').forEach(x => x.classList.toggle('on', x === el));
  const box = document.getElementById('sRegion');
  if (!box) return;
  if (window.CH.disposeEl) window.CH.disposeEl(box);
  if (el.dataset.rt === 'list') { box.style.minHeight = ''; box.innerHTML = regionTable(); }
  else {
    box.innerHTML = '';
    box.style.minHeight = `${Math.max(240, S.value.regions.length * 44)}px`;
    const chart = window.CH.hbar(box, {
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
    <div class="panel mb12" style="flex:none" @click="onToolbarClick"><div class="toolbar" style="border:0" v-html="toolbarHtml"></div></div>

    <div v-if="S" class="stats-basis">{{ sourceLabel }} · 生成于 {{ generatedLabel }}；目标按首次发现时间归属，合法性与风险为生成时状态。</div>
    <UKpis v-if="S" :list="kpiList" />

    <div v-if="S" class="stats-chart-grid stats-overview-grid">
      <UPanel title="目标趋势" panel-style="flex:1.5">
        <div id="sTrend" style="height:100%"></div>
      </UPanel>
      <UPanel title="各风险等级分布" sub="目标数" panel-style="flex:.75"><div v-if="!metricVisible('by_risk')" class="stats-unavailable">暂不可统计<br>{{ metricReason('by_risk') }}</div><div v-else id="sRisk" style="height:100%"></div></UPanel>
      <UPanel title="各类型目标占比" panel-style="flex:1.25"><div v-if="!metricVisible('by_type')" class="stats-unavailable">暂不可统计<br>{{ metricReason('by_type') }}</div><div v-else id="sType" style="height:100%"></div></UPanel>
    </div>

    <div v-if="S" class="stats-chart-grid stats-details-grid">
      <UPanel title="目标海拔高度分布" :sub="`有效记录 ${metricNumber(S.altTotal)} 个`" panel-style="flex:1">
        <div v-if="!metricVisible('alt_bands') || !S.altTotal" class="stats-unavailable">{{ S.total === 0 ? '统计区间内无新增目标' : '暂不可统计' }}<br>{{ metricReason('alt_bands') }}</div>
        <template v-else><div class="stats-note">最新有效海拔（米） · 缺失 {{ S.availability.alt_bands?.missing_count ?? '未知' }} 个；不以离地高度替代</div><div id="sAlt" class="stats-alt-chart"></div></template>
      </UPanel>
      <UPanel title="每日立案数量" sub="按立案日期">
        <div v-if="!caseTrendAvailable" class="stats-unavailable">{{ S.punish === 0 && metricVisible('punish') ? '统计区间内无立案案件' : '暂不可统计' }}<br>{{ metricReason('punish') }}</div>
        <div v-else id="sCases" style="height:100%"></div>
      </UPanel>
      <UPanel title="处罚结果形成情况" sub="统计期内立案案件" class="stats-penalty">
        <div v-if="!penaltyResults" class="stats-unavailable">暂不可统计<br>{{ penaltyUnavailableReason }}</div>
        <div v-else-if="S.punish === 0" class="stats-unavailable">统计区间内无立案案件</div>
        <template v-else>
          <div class="stats-note">占比按全部立案案件计算；有效处罚结果不代表案件办结</div>
          <figure class="penalty-bars" aria-label="处罚结果类型及未形成有效结果的案件占比">
            <div v-for="item in penaltyResults" :key="item.name" class="penalty-row" :class="{ pending: item.pending }">
              <div class="penalty-label"><span>{{ item.name }}</span><span>{{ item.value }} 件（{{ pctOf(item.value, S.punish) }}%）</span></div>
              <div class="penalty-track"><div class="penalty-fill" :style="{ width: `${item.value / S.punish * 100}%` }"></div></div>
            </div>
          </figure>
        </template>
      </UPanel>
    </div>

    <div v-if="S" class="stats-summary-grid">
      <UPanel title="区域分布" sub="业务归属区域" class="stats-region" nopad @click="onRegionTab"
        :extra="`<div class=&quot;tabs&quot; style=&quot;border:0&quot;><button type=&quot;button&quot; class=&quot;tab&quot; data-rt=&quot;chart&quot;>区域数量对比</button><button type=&quot;button&quot; class=&quot;tab on&quot; data-rt=&quot;list&quot;>排行表</button></div>`">
        <div id="sRegion" class="stats-region-content"></div>
      </UPanel>
      <UPanel title="案件主体排行" sub="按立案数量" class="stats-rank" nopad>
        <div v-if="!metricVisible('partners')" class="stats-unavailable">暂不可统计<br>{{ metricReason('partners') }}</div>
        <div v-else-if="!S.partners.length" class="stats-unavailable">{{ S.punish === 0 ? '统计区间内无立案案件' : '暂无案件主体统计' }}</div>
        <div v-else v-html="rankHtml"></div>
      </UPanel>
    </div>
  </div>
</template>

<style scoped>
.stats-page { container-type:inline-size; }
.stats-summary-grid { display:grid;grid-template-columns:minmax(0, 1.35fr) minmax(0, 1fr);gap:14px;margin-top:12px;padding-bottom:12px; }
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
.stats-rank :deep(table.tb th:nth-child(3)) { width:28% !important; }
.stats-penalty :deep(.pb) { display:flex;flex-direction:column; }
.stats-penalty .stats-note { flex:none; }
.stats-chart-grid { display:grid;gap:14px;margin-top:12px; }
.stats-overview-grid { grid-template-columns:minmax(0, 1.5fr) minmax(0, .85fr) minmax(0, 1.25fr); }
.stats-details-grid { grid-template-columns:minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr); }
.stats-chart-grid > .panel { height:310px; }
.stats-chart-grid :deep(.ph) { flex-wrap:wrap; }
.stats-chart-grid :deep(.ph h3) { white-space:normal; }
.stats-details-grid :deep(.pb) { display:flex;flex-direction:column; }
.stats-alt-chart { flex:1;min-height:170px; }
.penalty-bars { margin:8px 0;display:flex;flex-direction:column;gap:18px; }
.penalty-label { display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 10px;font-size:13px;line-height:1.5;overflow-wrap:anywhere; }
.penalty-label span:last-child { color:var(--txt-2);font-variant-numeric:tabular-nums; }
.penalty-track { height:10px;background:var(--line-2);border-radius:4px;margin-top:6px; }
.penalty-fill { height:100%;background:var(--cyan);border-radius:4px; }
.pending .penalty-fill { background:var(--amber); }
@container (max-width:1200px) {
  .stats-summary-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
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
