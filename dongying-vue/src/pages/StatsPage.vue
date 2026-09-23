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
    { t: '案件', w: '42px', align: 'right', cls: 'num', render: r => r.n },
    { t: '罚款', w: '48px', align: 'right', cls: 'num', render: r => r.fine == null ? '暂不可统计' : r.fine.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }
  ], top);
});

function regionTable() {
  const stats = S.value;
  if (!stats) return '';
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-amber', 't-gray', 't-orange'][i]}">${i + 1}</span>` : i + 1 },
    { t: '区域', w: '74px', render: r => escapeHtml(r.name) },
    { t: '目标/非法', w: '80px', align: 'right', cls: 'num',
      render: r => `${metricNumber(r.total)}<span style="color:var(--txt-3)">/</span><span style="color:#ff8b95">${metricNumber(r.illegal)}</span>` },
    { t: '案件/高危', w: '80px', align: 'right', cls: 'num',
      render: r => `${metricNumber(r.punish)}<span style="color:var(--txt-3)">/</span><span style="color:#ffb083">${metricNumber(r.highRisk)}</span>` }
  ], stats.regions) +
    `<div style="padding:7px 10px;border-top:1px solid var(--line);display:flex;gap:0;font-size:12.5px">
      <span style="width:34px"></span><span style="flex:1;color:var(--txt-3)">合计</span>
      <b class="mono" style="width:80px;text-align:right">${metricNumber(stats.total)}
        <span style="color:var(--txt-3)">/</span> ${metricNumber(stats.illegal)}</b>
      <b class="mono" style="width:80px;text-align:right">${metricNumber(stats.punish)}
        <span style="color:var(--txt-3)">/</span> ${metricNumber(stats.highRisk)}</b></div>`;
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
      { name: '非法飞行', data: stats.days.map(d => d.illegal), color: CH.C.red },
      { name: '处罚案件', data: stats.days.map(d => d.punish), color: CH.C.amber }
    ]
  });
  const rc = { '超高风险': CH.C.red, '高风险': CH.C.red, '中风险': CH.C.amber, '低风险': CH.C.blue, '未识别': CH.C.gray };
  if (metricVisible('by_risk')) CH.bar(document.getElementById('sRisk'), {
    x: stats.byRisk.map(r => r.name), legend: false, yName: '数量',
    series: [{ name: '数量', data: stats.byRisk.map(r => r.value), colorBy: p => rc[stats.byRisk[p.dataIndex].name] }]
  });
  if (metricVisible('by_type')) CH.donut(document.getElementById('sType'), { data: stats.byType, center: ['30%', '50%'] });
  const regionBox = document.getElementById('sRegion');
  if (regionBox) regionBox.innerHTML = regionTable();
  if (metricVisible('alt_bands') && stats.altTotal > 0) CH.bar(document.getElementById('sAlt'), {
    x: stats.altBands.map(d => d.name), legend: false, yName: '目标数',
    series: [{ name: '目标数', data: stats.altBands.map(d => d.value), color: CH.C.blue,
      fmt: p => p.value + '\n' + pctOf(p.value, stats.altTotal) + '%' }]
  });
  if (metricVisible('by_penalty') && stats.byPenalty.length) CH.donut(document.getElementById('sPen'), {
    data: stats.byPenalty.map((p, i) => ({ name: p.name, value: p.value, c: ['#2fd06e', '#ff4d5e', '#ffb020'][i] })),
    center: ['32%', '50%']
  });
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
  if (el.dataset.rt === 'list') { box.innerHTML = regionTable(); }
  else {
    box.innerHTML = '';
    window.CH.hbar(box, {
      y: S.value.regions.map(r => r.name), data: S.value.regions.map(r => r.total),
      colors: S.value.regions.map(r => r.total && r.illegal / r.total > .05 ? '#ff4d5e' : '#3d8bff')
    });
  }
}
</script>

<template>
  <div class="view" id="view">
    <div v-if="error" class="warnbox" role="alert" style="margin-bottom:12px;display:flex;align-items:center;gap:12px">
      <span>{{ error }}</span>
      <button class="btn" type="button" @click="load">重试</button>
    </div>
    <div class="panel mb12" style="flex:none" @click="onToolbarClick"><div class="toolbar" style="border:0" v-html="toolbarHtml"></div></div>

    <div v-if="S" class="stats-basis">{{ sourceLabel }} · 生成于 {{ generatedLabel }}；目标按首次发现时间归属，合法性与风险为生成时状态。</div>
    <UKpis v-if="S" :list="kpiList" />

    <div v-if="S" class="row" style="height:270px;margin-top:12px">
      <UPanel title="目标趋势" panel-style="flex:1.5">
        <div id="sTrend" style="height:100%"></div>
      </UPanel>
      <UPanel title="各风险等级分布" sub="数量 | 占比" panel-style="flex:.75"><div v-if="!metricVisible('by_risk')" class="stats-unavailable">暂不可统计<br>{{ metricReason('by_risk') }}</div><div v-else id="sRisk" style="height:100%"></div></UPanel>
      <UPanel title="各类型目标占比" panel-style="flex:1.25"><div v-if="!metricVisible('by_type')" class="stats-unavailable">暂不可统计<br>{{ metricReason('by_type') }}</div><div v-else id="sType" style="height:100%"></div></UPanel>
    </div>

    <div v-if="S" class="row" style="height:262px;margin-top:12px">
      <UPanel title="飞行高度分布" :sub="`海拔高度 · 有效记录 ${metricNumber(S.altTotal)} 个`" panel-style="flex:1">
        <div v-if="!metricVisible('alt_bands') || !S.altTotal" class="stats-unavailable">{{ S.total === 0 ? '统计区间内无新增目标' : '暂不可统计' }}<br>{{ metricReason('alt_bands') }}</div>
        <template v-else><div class="stats-note">{{ metricReason('alt_bands') }}；缺失 {{ S.availability.alt_bands?.missing_count ?? '未知' }} 个</div><div id="sAlt" style="height:calc(100% - 38px)"></div></template>
      </UPanel>
      <UPanel title="飞行时长统计" sub="分钟" panel-style="flex:1"><div class="stats-unavailable">暂不可统计<br>{{ metricReason('by_duration') }}</div></UPanel>
      <UPanel title="轨迹长度统计" sub="公里" panel-style="flex:1"><div class="stats-unavailable">暂不可统计<br>{{ metricReason('by_track') }}</div></UPanel>
    </div>

    <div v-if="S" class="row" style="height:288px;margin-top:12px;padding-bottom:12px">
      <UPanel title="区域分布" sub="东营市各区县" panel-style="flex:1.5" nopad @click="onRegionTab"
        :extra="`<div class=&quot;tabs&quot; style=&quot;border:0&quot;><span class=&quot;tab&quot; data-rt=&quot;heat&quot;>热力图</span><span class=&quot;tab on&quot; data-rt=&quot;list&quot;>排行表</span></div>`">
        <div id="sRegion" style="height:100%"></div>
      </UPanel>
      <UPanel title="处罚结果统计" panel-style="flex:1"><div v-if="!metricVisible('by_penalty') || !S.byPenalty.length" class="stats-unavailable">{{ metricVisible('by_penalty') ? '暂无有效处罚结果' : '暂不可统计' }}<br>{{ metricReason('by_penalty') }}</div><template v-else><div class="stats-note">{{ metricReason('by_penalty') }}</div><div id="sPen" style="height:calc(100% - 38px)"></div></template></UPanel>
      <UPanel title="案件主体排行" panel-style="width:288px" nopad :body-html="rankHtml" />
    </div>
  </div>
</template>

<style scoped>
.stats-basis,.stats-note { color:var(--txt-3);font-size:12px;line-height:1.5;overflow-wrap:anywhere;margin-bottom:8px; }
:deep(.kpi .dt), :deep(.kpi .vl) { white-space:normal;overflow-wrap:anywhere; }
.stats-unavailable { height:100%;display:flex;flex-direction:column;justify-content:center;text-align:center;padding:16px;box-sizing:border-box;color:var(--txt-3);line-height:1.8;overflow-wrap:anywhere; }
</style>
