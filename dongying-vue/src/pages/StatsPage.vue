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
usePageChrome('stats');

const S = ref(null);
const loading = ref(true);
const exporting = ref(false);
const error = ref('');
let cancelled = false;

const toolbarHtml = computed(() => {
  const range = S.value
    ? `${S.value.from} 至 ${S.value.to}（近30天全量）`
    : (loading.value ? '加载中…' : '—');
  const disabled = !S.value || exporting.value ? ' disabled' : '';
  return `<div class="toolbar-fields">${U.field('统计区间', `<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px">${range}</span>`)}</div>
      <div class="toolbar-actions">
      <button class="btn pri" id="stExp"${disabled}>${U.icon('download')} 导出数据</button>
      <span class="toolbar-note">当前按近 30 天全量统计，暂不支持按日、类型、区域筛选</span></div>`;
});

const kpiList = computed(() => {
  if (!S.value) return [];
  const stats = S.value;
  const devices = stats.devices;
  const deviceDesc = !devices
    ? '当前账号不返回全量台账'
    : devices.total
      ? `在线 ${devices.online} · ${devices.onlineRate == null ? '—' : devices.onlineRate + '%'}`
      : '当前无台账设备';
  return [
    { label: '飞行/目标总次数', value: U.num(stats.total), color: 'blue', icon: 'radar', desc: `${stats.from} 至 ${stats.to}` },
    { label: '非法飞行次数', value: U.num(stats.illegal), color: 'red', icon: 'alert', desc: `占比 ${U.pct(stats.illegal, stats.total)}` },
    { label: '处罚案件数', value: U.num(stats.punish), color: 'orange', icon: 'gavel', desc: `近30天立案` },
    { label: '接入设备总数', value: U.num(devices ? devices.total : null), color: 'cyan', icon: 'device', desc: deviceDesc },
    { label: '高风险目标数', value: U.num(stats.highRisk), color: 'purple', icon: 'zone', desc: `占比 ${U.pct(stats.highRisk, stats.total)}` }
  ];
});

const rankHtml = computed(() => {
  if (!S.value) return '';
  const top = S.value.partners || [];
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-red', 't-orange', 't-amber'][i]}">${i + 1}</span>` : i + 1 },
    { t: '主体', w: '118px', render: r => `<div style="width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${
      r.name.includes('未知') ? `<span style="color:#ff8b95">${r.name}</span>` : r.name}</div>` },
    { t: '案件', w: '42px', align: 'right', cls: 'num', render: r => r.n },
    { t: '罚款', w: '48px', align: 'right', cls: 'num', render: r => r.fine ? (r.fine / 1000) + 'k' : '—' }
  ], top) + `<div style="padding:7px 10px;border-top:1px solid var(--line);font-size:11.5px;color:var(--txt-3)">
      「未知(无报备)」为黑飞主体,重点溯源对象</div>`;
});

function regionTable() {
  const stats = S.value;
  if (!stats) return '';
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-amber', 't-gray', 't-orange'][i]}">${i + 1}</span>` : i + 1 },
    { t: '区域', k: 'name', w: '74px' },
    { t: '目标/非法', w: '80px', align: 'right', cls: 'num',
      render: r => `${r.total}<span style="color:var(--txt-3)">/</span><span style="color:#ff8b95">${r.illegal}</span>` },
    { t: '案件/高危', w: '80px', align: 'right', cls: 'num',
      render: r => `${r.punish}<span style="color:var(--txt-3)">/</span><span style="color:#ffb083">${r.highRisk}</span>` }
  ], stats.regions) +
    `<div style="padding:7px 10px;border-top:1px solid var(--line);display:flex;gap:0;font-size:12.5px">
      <span style="width:34px"></span><span style="flex:1;color:var(--txt-3)">合计</span>
      <b class="mono" style="width:80px;text-align:right">${U.num(stats.regions.reduce((n, r) => n + r.total, 0))}
        <span style="color:var(--txt-3)">/</span> ${U.num(stats.regions.reduce((n, r) => n + r.illegal, 0))}</b>
      <b class="mono" style="width:80px;text-align:right">${U.num(stats.regions.reduce((n, r) => n + r.punish, 0))}
        <span style="color:var(--txt-3)">/</span> ${U.num(stats.regions.reduce((n, r) => n + r.highRisk, 0))}</b></div>`;
}

function pctOf(value, total) {
  if (!total) return '0.0';
  return (value / total * 100).toFixed(1);
}

function drawCharts(CH) {
  const stats = S.value;
  if (!stats) return;
  CH.line(document.getElementById('sTrend'), {
    x: stats.days.map(d => d.md), yName: '次数',
    series: [
      { name: '目标总次数', data: stats.days.map(d => d.total), color: CH.C.blue, area: true },
      { name: '非法飞行', data: stats.days.map(d => d.illegal), color: CH.C.red },
      { name: '处罚案件', data: stats.days.map(d => d.punish), color: CH.C.amber }
    ]
  });
  const rc = { '超高风险': '#c0392b', '高风险': '#ff4d5e', '中风险': '#ffb020', '低风险': '#2fd06e', '未识别': '#8ca0be' };
  CH.bar(document.getElementById('sRisk'), {
    x: stats.byRisk.map(r => r.name), legend: false, yName: '数量',
    series: [{ name: '数量', data: stats.byRisk.map(r => r.value), colorBy: p => rc[stats.byRisk[p.dataIndex].name] }]
  });
  CH.donut(document.getElementById('sType'), { data: stats.byType, center: ['30%', '50%'] });
  const regionBox = document.getElementById('sRegion');
  if (regionBox) regionBox.innerHTML = regionTable();
  CH.bar(document.getElementById('sDur'), {
    x: stats.byDuration.map(d => d.name), legend: false, yName: '次数',
    series: [{ name: '次数', data: stats.byDuration.map(d => d.value), color: CH.C.blue, fmt: p => p.value + '\n' + pctOf(p.value, stats.total) + '%' }]
  });
  CH.bar(document.getElementById('sTrack'), {
    x: stats.byTrack.map(d => d.name), legend: false, yName: '次数',
    series: [{ name: '次数', data: stats.byTrack.map(d => d.value), color: CH.C.cyan, fmt: p => p.value + '\n' + pctOf(p.value, stats.total) + '%' }]
  });
  CH.bar(document.getElementById('sAlt'), {
    x: stats.altBands.map(d => d.name), legend: false, yName: '目标数',
    series: [{ name: '目标数', data: stats.altBands.map(d => d.value), color: CH.C.blue,
      fmt: p => p.value + '\n' + pctOf(p.value, stats.altTotal) + '%' }]
  });
  CH.donut(document.getElementById('sPen'), {
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
onUnmounted(() => { cancelled = true; });

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

    <UKpis v-if="S" :list="kpiList" />

    <div v-if="S" class="row" style="height:270px;margin-top:12px">
      <UPanel title="近30天目标趋势" panel-style="flex:1.5">
        <div id="sTrend" style="height:100%"></div>
      </UPanel>
      <UPanel title="各风险等级分布" sub="数量 | 占比" panel-style="flex:.75"><div id="sRisk" style="height:100%"></div></UPanel>
      <UPanel title="各类型目标占比" panel-style="flex:1.25"><div id="sType" style="height:100%"></div></UPanel>
    </div>

    <div v-if="S" class="row" style="height:262px;margin-top:12px">
      <UPanel title="飞行高度分布" :sub="`海拔高度 · 协议必填 · 参与统计 ${U.num(S.altTotal)} 个`" panel-style="flex:1">
        <div id="sAlt" style="height:100%"></div>
      </UPanel>
      <UPanel title="飞行时长统计" sub="分钟" panel-style="flex:1"><div id="sDur" style="height:100%"></div></UPanel>
      <UPanel title="轨迹长度统计" sub="公里" panel-style="flex:1"><div id="sTrack" style="height:100%"></div></UPanel>
    </div>

    <div v-if="S" class="row" style="height:288px;margin-top:12px;padding-bottom:12px">
      <UPanel title="区域分布" sub="东营市各区县" panel-style="flex:1.5" nopad @click="onRegionTab"
        :extra="`<div class=&quot;tabs&quot; style=&quot;border:0&quot;><span class=&quot;tab&quot; data-rt=&quot;heat&quot;>热力图</span><span class=&quot;tab on&quot; data-rt=&quot;list&quot;>排行表</span></div>`">
        <div id="sRegion" style="height:100%"></div>
      </UPanel>
      <UPanel title="处置/处罚统计" panel-style="flex:1"><div id="sPen" style="height:100%"></div></UPanel>
      <UPanel title="违规主体排行" sub="近30天" panel-style="width:288px" nopad :body-html="rankHtml" />
    </div>
  </div>
</template>
