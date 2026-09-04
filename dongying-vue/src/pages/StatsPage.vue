<script setup>
/* 运行统计 —— 第一个转换为真 Vue 组件的页面（源：legacy pages/stats.js）。
   转换约定：
   · 结构进 template，图表随查询 ready 状态初始化和释放
   · 数值/标签等叶子仍用 window.UI 的字符串生成器（U.num/U.table）
   · 工具条不再放没有切片数据的时间/类型/区域下拉，避免点了数字不变
   · 外壳职责（面包屑/导航组/页脚/卸载清理）统一走 usePageChrome
   · 查询壳走 PageQueryShell：加载/空/错/就绪；本页数据仍来自 Mock，失败不得改写成成功 */
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { sliceLocal } from '@/hooks/pagedList.js';
import { usePagedList } from '@/hooks/usePagedList.js';
import PagePager from '@/components/PagePager.vue';
import PageQueryShell from '@/components/PageQueryShell.vue';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';

const M = window.MOCK, U = window.UI, S = M.stats;
usePageChrome('stats');
const query = usePagedList({ page: 1, size: 20 });
const queryStatus = computed(() => query.status.value);
const queryError = computed(() => query.errorMessage.value);

function applyRegionPage() {
  return query.applyPayload(sliceLocal(S.regions || [], query.page.value, query.size.value));
}
async function reloadStats() {
  // 先让加载态真正渲染一帧，再应用本地分页结果，保持与异步 API 相同的生命周期。
  query.setLoading();
  await nextTick();
  return applyRegionPage();
}

/* ---- 工具条：统计说明与右侧操作按钮 ---- */
const d0 = M.util.fmtD(M.util.dayAdd(M.CONF.demoTime, -29)), d1 = M.util.fmtD(M.CONF.demoTime);
const toolbarHtml =
  `${U.field('统计区间', `<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px">${d0} 至 ${d1}（近30天全量）</span>`)}
      <span style="font-size:11.5px;color:var(--txt-3)">当前页按近30天全量统计；导出与月报接口尚未接入</span>
      <div class="toolbar-actions">
      <button class="btn" id="stExp" disabled title="真实导出接口尚未接入">${U.icon('download')} 导出数据</button>
      <button class="btn pri" id="stRep" disabled title="真实月报接口尚未接入">${U.icon('download')} 报表下载</button></div>`;

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
  // 排名按全量偏移计算，但行和“本页合计”只消费当前页数据。
  const regions = query.items.value;
  const offset = (query.page.value - 1) * query.size.value;
  return U.table([
    { t: '#', w: '34px', align: 'center', render: (r, i) => {
      const rank = offset + i + 1;
      return rank <= 3 ? `<span class="tag ${['t-amber', 't-gray', 't-orange'][rank - 1]}">${rank}</span>` : rank;
    } },
    { t: '区域', k: 'name', w: '74px' },
    { t: '目标/非法', w: '80px', align: 'right', cls: 'num',
      render: r => `${r.total}<span style="color:var(--txt-3)">/</span><span style="color:#ff8b95">${r.illegal}</span>` },
    { t: '案件/高危', w: '80px', align: 'right', cls: 'num',
      render: r => `${r.punish}<span style="color:var(--txt-3)">/</span><span style="color:#ffb083">${r.highRisk}</span>` }
  ], regions) +
    `<div style="padding:7px 10px;border-top:1px solid var(--line);display:flex;gap:0;font-size:12.5px">
      <span style="width:34px"></span><span style="flex:1;color:var(--txt-3)">本页合计</span>
      <b class="mono" style="width:80px;text-align:right">${U.num(M.util.sum(regions, r => r.total))}
        <span style="color:var(--txt-3)">/</span> ${U.num(M.util.sum(regions, r => r.illegal))}</b>
      <b class="mono" style="width:80px;text-align:right">${U.num(M.util.sum(regions, r => r.punish))}
        <span style="color:var(--txt-3)">/</span> ${U.num(M.util.sum(regions, r => r.highRisk))}</b></div>`;
}

/* ---- 图表（legacy mount 同构；查询壳重建后可再次初始化） ---- */
function initStatsCharts(CH) {
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
}

const STATS_CHART_IDS = ['sTrend', 'sRisk', 'sType', 'sRegion', 'sDur', 'sTrack', 'sAlt', 'sPen'];
function disposeStatsCharts() {
  // 查询离开 ready 或页面卸载时释放实例，防止重试后叠加图表和监听器。
  if (!window.CH.disposeEl) return;
  STATS_CHART_IDS.forEach(id => window.CH.disposeEl(document.getElementById(id)));
}

let statsMounted = false;
watch(queryStatus, async (status, previous) => {
  if (!statsMounted) return;
  if (previous === 'ready' && status !== 'ready') disposeStatsCharts();
  if (status !== 'ready') return;
  await nextTick();
  if (statsMounted && query.status.value === 'ready') initStatsCharts(window.CH);
}, { flush: 'pre' });
onMounted(() => {
  statsMounted = true;
  reloadStats();
});
onBeforeUnmount(() => {
  statsMounted = false;
  disposeStatsCharts();
});

/* ---- 区域视图与本地演示分页 ---- */
function renderRegionView(view) {
  const box = document.getElementById('sRegion');
  if (!box) return;
  const activeView = view || document.querySelector('[data-rt].on')?.dataset.rt || 'list';
  if (window.CH.disposeEl) window.CH.disposeEl(box);
  if (activeView === 'list') {
    box.innerHTML = regionTable();
    return;
  }
  // 热力图与排行表读取同一页，避免切换视图后出现数据口径不一致。
  const regions = query.items.value;
  box.innerHTML = '';
  window.CH.hbar(box, {
    y: regions.map(r => r.name), data: regions.map(r => r.total),
    colors: regions.map(r => r.illegal / r.total > .05 ? '#ff4d5e' : '#3d8bff')
  });
}

function onRegionTab(e) {
  const el = e.target.closest('[data-rt]');
  if (!el) return;
  const view = document.getElementById('view');
  view.querySelectorAll('[data-rt]').forEach(x => x.classList.toggle('on', x === el));
  renderRegionView(el.dataset.rt);
}
function onPageChange(next) {
  query.setPage(next);
  if (applyRegionPage()) renderRegionView();
}
function onSizeChange(next) {
  query.setSize(next);
  if (applyRegionPage()) renderRegionView();
}
</script>

<template>
  <PageQueryShell
    :status="queryStatus"
    :error-message="queryError"
    loading-text="正在加载运行统计…"
    empty-title="暂无运行统计"
    empty-description="当前没有可汇总的飞行与处罚记录"
    @retry="reloadStats"
  >
  <div class="view" id="view">
    <div class="panel mb12" style="flex:none"><div class="toolbar" style="border:0" v-html="toolbarHtml"></div></div>

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
    <PagePager
      :page="query.page.value"
      :size="query.size.value"
      :total="query.total.value"
      :page-sizes="[2, 5, 20]"
      @update:page="onPageChange"
      @update:size="onSizeChange"
    />
  </div>
  </PageQueryShell>
</template>
