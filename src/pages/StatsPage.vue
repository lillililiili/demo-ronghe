<script setup>
/* 运行统计 —— 第一个转换为真 Vue 组件的页面（源：legacy pages/stats.js）。
   转换约定：
   · 结构进 template，图表初始化进 useCharts（等价 legacy mount 时机）
   · 数值/标签等叶子仍用 window.UI 的字符串生成器（U.num/U.table）
   · 工具条不再放没有切片数据的时间/类型/区域下拉，避免点了数字不变
   · 外壳职责（面包屑/导航组/页脚/卸载清理）统一走 usePageChrome */
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { useCharts } from '@/hooks/useChart.js';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { toast } from '@/ui/nv.js';

const M = window.MOCK, U = window.UI, S = M.stats;
usePageChrome('stats');

/* ---- 工具条（legacy render 顶部的裸 toolbar 面板，整段同构） ---- */
const d0 = M.util.fmtD(M.util.dayAdd(M.CONF.demoTime, -29)), d1 = M.util.fmtD(M.CONF.demoTime);
const toolbarHtml =
  `${U.field('统计区间', `<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px">${d0} 至 ${d1}（近30天全量）</span>`)}
      <span style="font-size:11.5px;color:var(--txt-3)">当前页按近30天全量统计，没有按日/类型/区域切片的数据源</span>
      <span style="flex:1"></span>
      <button class="btn" id="stExp">${U.icon('download')} 导出数据</button>
      <button class="btn pri" id="stRep">${U.icon('download')} 报表下载</button>`;

/* ---- KPI ---- */
const kpiList = [
  { label: '飞行/目标总次数', value: U.num(S.total), color: 'blue', icon: 'radar', desc: `${d0} 至 ${d1}` },
  { label: '非法飞行次数', value: U.num(S.illegal), color: 'red', icon: 'alert', desc: `占比 ${U.pct(S.illegal, S.total)}` },
  { label: '处罚案件数', value: U.num(S.punish), color: 'orange', icon: 'gavel', desc: `近30天立案` },
  /* 「平均处置时长」卡已按用户裁定删除（2026-08-30）；S.avgDisposeSec 仍在数据层 */
  { label: '接入设备总数', value: U.num(M.deviceStats.total), color: 'cyan', icon: 'device', desc: `在线 ${M.deviceStats.online} · ${M.deviceStats.onlineRate}%` },
  { label: '高风险目标数', value: U.num(S.highRisk), color: 'purple', icon: 'zone', desc: `占比 ${U.pct(S.highRisk, S.total)}` }
];

/* ---- 违规主体排行（legacy 同构：由案件数据真实聚合） ---- */
const rankHtml = (function () {
  const gc = M.util.groupCount(M.cases, c => c.partner);
  const top = [...gc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, n]) => ({ name, n, fine: M.util.sum(M.cases.filter(c => c.partner === name && c.penalty === '罚款'), c => c.fine) }));
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-red', 't-orange', 't-amber'][i]}">${i + 1}</span>` : i + 1 },
    { t: '主体', w: '118px', render: r => `<div style="width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${
      r.name.includes('未知') ? `<span style="color:#ff8b95">${r.name}</span>` : r.name}</div>` },
    { t: '案件', w: '42px', align: 'right', cls: 'num', render: r => r.n },
    { t: '罚款', w: '48px', align: 'right', cls: 'num', render: r => r.fine ? (r.fine / 1000) + 'k' : '—' }
  ], top) + `<div style="padding:7px 10px;border-top:1px solid var(--line);font-size:11.5px;color:var(--txt-3)">
      「未知(无报备)」为黑飞主体,重点溯源对象</div>`;
})();

function regionTable() {
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => i < 3 ? `<span class="tag ${['t-amber', 't-gray', 't-orange'][i]}">${i + 1}</span>` : i + 1 },
    { t: '区域', k: 'name', w: '74px' },
    { t: '目标/非法', w: '80px', align: 'right', cls: 'num',
      render: r => `${r.total}<span style="color:var(--txt-3)">/</span><span style="color:#ff8b95">${r.illegal}</span>` },
    { t: '案件/高危', w: '80px', align: 'right', cls: 'num',
      render: r => `${r.punish}<span style="color:var(--txt-3)">/</span><span style="color:#ffb083">${r.highRisk}</span>` }
  ], M.stats.regions) +
    `<div style="padding:7px 10px;border-top:1px solid var(--line);display:flex;gap:0;font-size:12.5px">
      <span style="width:34px"></span><span style="flex:1;color:var(--txt-3)">合计</span>
      <b class="mono" style="width:80px;text-align:right">${U.num(M.util.sum(M.stats.regions, r => r.total))}
        <span style="color:var(--txt-3)">/</span> ${U.num(M.util.sum(M.stats.regions, r => r.illegal))}</b>
      <b class="mono" style="width:80px;text-align:right">${U.num(M.util.sum(M.stats.regions, r => r.punish))}
        <span style="color:var(--txt-3)">/</span> ${U.num(M.util.sum(M.stats.regions, r => r.highRisk))}</b></div>`;
}

/* ---- 图表（legacy mount 同构） ---- */
useCharts(CH => {
  CH.line(document.getElementById('sTrend'), {
    x: S.days.map(d => d.md), yName: '次数',
    series: [
      { name: '目标总次数', data: S.days.map(d => d.total), color: CH.C.blue, area: true },
      { name: '非法飞行', data: S.days.map(d => d.illegal), color: CH.C.red },
      { name: '处罚案件', data: S.days.map(d => d.punish), color: CH.C.amber }
    ]
  });
  const rc = { '超高风险': '#c0392b', '高风险': '#ff4d5e', '中风险': '#ffb020', '低风险': '#2fd06e', '未识别': '#8ca0be' };
  CH.bar(document.getElementById('sRisk'), {
    x: S.byRisk.map(r => r.name), legend: false, yName: '数量',
    series: [{ name: '数量', data: S.byRisk.map(r => r.value), colorBy: p => rc[S.byRisk[p.dataIndex].name] }]
  });
  CH.donut(document.getElementById('sType'), { data: S.byType, center: ['30%', '50%'] });
  document.getElementById('sRegion').innerHTML = regionTable();
  CH.bar(document.getElementById('sDur'), {
    x: S.byDuration.map(d => d.name), legend: false, yName: '次数',
    series: [{ name: '次数', data: S.byDuration.map(d => d.value), color: CH.C.blue, fmt: p => p.value + '\n' + (p.value / S.total * 100).toFixed(1) + '%' }]
  });
  CH.bar(document.getElementById('sTrack'), {
    x: S.byTrack.map(d => d.name), legend: false, yName: '次数',
    series: [{ name: '次数', data: S.byTrack.map(d => d.value), color: CH.C.cyan, fmt: p => p.value + '\n' + (p.value / S.total * 100).toFixed(1) + '%' }]
  });
  CH.bar(document.getElementById('sAlt'), {
    x: S.altBands.map(d => d.name), legend: false, yName: '目标数',
    series: [{ name: '目标数', data: S.altBands.map(d => d.value), color: CH.C.blue,
      fmt: p => p.value + '\n' + (p.value / S.altTotal * 100).toFixed(1) + '%' }]
  });
  CH.donut(document.getElementById('sPen'), {
    data: S.byPenalty.map((p, i) => ({ name: p.name, value: p.value, c: ['#2fd06e', '#ff4d5e', '#ffb020'][i] })),
    center: ['32%', '50%']
  });
});

/* ---- 交互（legacy mount 同构：事件委托改为 Vue 侧委托处理器） ---- */
function onToolbarClick(e) {
  if (e.target.closest('#stExp')) toast('已导出「近30天统计明细.xlsx」（Demo：接口 /api/v1/stats/export）', 'ok');
  else if (e.target.closest('#stRep')) toast('已生成「东营市低空运行月报」PDF（Demo）', 'ok');
}
function onRegionTab(e) {
  const el = e.target.closest('[data-rt]');
  if (!el) return;
  const view = document.getElementById('view');
  view.querySelectorAll('[data-rt]').forEach(x => x.classList.toggle('on', x === el));
  const box = document.getElementById('sRegion');
  if (!box) return;
  /* 切回排行表会 innerHTML 清掉 canvas，必须先卸实例，否则第二次热力图 init 复用死图。 */
  if (window.CH.disposeEl) window.CH.disposeEl(box);
  if (el.dataset.rt === 'list') { box.innerHTML = regionTable(); }
  else {
    box.innerHTML = '';
    window.CH.hbar(box, {
      y: S.regions.map(r => r.name), data: S.regions.map(r => r.total),
      colors: S.regions.map(r => r.illegal / r.total > .05 ? '#ff4d5e' : '#3d8bff')
    });
  }
}
</script>

<template>
  <div class="view" id="view">
    <div class="panel mb12" style="flex:none" @click="onToolbarClick"><div class="toolbar" style="border:0" v-html="toolbarHtml"></div></div>

    <UKpis :list="kpiList" />

    <div class="row" style="height:270px;margin-top:12px">
      <UPanel title="近30天目标趋势" panel-style="flex:1.5">
        <div id="sTrend" style="height:100%"></div>
      </UPanel>
      <UPanel title="各风险等级分布" sub="数量 | 占比" panel-style="flex:.75"><div id="sRisk" style="height:100%"></div></UPanel>
      <UPanel title="各类型目标占比" panel-style="flex:1.25"><div id="sType" style="height:100%"></div></UPanel>
    </div>

    <div class="row" style="height:262px;margin-top:12px">
      <UPanel title="飞行高度分布" :sub="`海拔高 altitude · 协议必填 · 参与统计 ${U.num(S.altTotal)} 个`" panel-style="flex:1">
        <div id="sAlt" style="height:100%"></div>
      </UPanel>
      <UPanel title="飞行时长统计" sub="分钟" panel-style="flex:1"><div id="sDur" style="height:100%"></div></UPanel>
      <UPanel title="轨迹长度统计" sub="公里" panel-style="flex:1"><div id="sTrack" style="height:100%"></div></UPanel>
    </div>

    <div class="row" style="height:288px;margin-top:12px;padding-bottom:12px">
      <UPanel title="区域分布" sub="东营市各区县" panel-style="flex:1.5" nopad @click="onRegionTab"
        :extra="`<div class=&quot;tabs&quot; style=&quot;border:0&quot;><span class=&quot;tab&quot; data-rt=&quot;heat&quot;>热力图</span><span class=&quot;tab on&quot; data-rt=&quot;list&quot;>排行表</span></div>`">
        <div id="sRegion" style="height:100%"></div>
      </UPanel>
      <UPanel title="处置/处罚统计" panel-style="flex:1"><div id="sPen" style="height:100%"></div></UPanel>
      <UPanel title="违规主体排行" sub="近30天" panel-style="width:288px" nopad :body-html="rankHtml" />
    </div>
  </div>
</template>
