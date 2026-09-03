<script>
/* 模块级状态：跨导航保持（legacy 约定）。SORT 排序是页面状态，只排副本。 */
const S = {
  tab: 'list',
  st: { page: 1, size: 20, type: '全部', astatus: '全部', kw: '', target: '', device: '' },
  gran: '日',
  SORT: { key: null, dir: 'asc' }
};
export default {};
</script>

<script setup>
/* 日志归档 —— 第三个转换页（源：legacy pages/archive.js）。
   外骨架（KPI/页签）进 template；页签体、列表、图表沿用 legacy 的命令式
   渲染与 U.on 委托（绑在组件根上，组件按 :key 重挂时随节点销毁，无重复绑定）。    分页器（U.pager）本页暂保留：列表区在命令式 innerHTML 重刷区内（页签/整页字符串渲染），
   模板层 n-pagination 放不进去；待该区块结构化后随 P5 迁移。
*/
import { ref, computed, onMounted } from 'vue';
import { NTabs, NTab } from 'naive-ui';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { sliceLocal } from '@/hooks/pagedList.js';
import UKpis from '@/components/UKpis.vue';
import { toast } from '@/ui/nv.js';
import { openModal, closeModal } from '@/ui/modal.js';

const M = window.MOCK, U = window.UI, CH = window.CH, L = M.logStats;
usePageChrome('archive');

const root = ref(null);
const tab = ref(S.tab);

const AR_ST = ['待归档', '已归档'];
const SORT_KEYS = {
  id: l => l.id, type: l => l.type, target: l => l.target || '',
  deviceName: l => l.deviceName || '', summary: l => l.summary || '',
  time: l => l.time, status: l => AR_ST.indexOf(l.status)
};
function sortTh(label, key) {
  const on = S.SORT.key === key;
  return `<span data-sort="${key}" title="点击排序" style="cursor:pointer;user-select:none;white-space:nowrap;
    border-bottom:1px dotted ${on ? '#8fbaff' : 'rgba(159,182,217,.45)'};${on ? 'color:#8fbaff' : ''}">${label}${on ? (S.SORT.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>`;
}
function sorted(rows) {
  const f = S.SORT.key && SORT_KEYS[S.SORT.key];
  if (!f) return rows;
  const d = S.SORT.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * d; });
}
function filtered() {
  return M.logs.filter(l =>
    (S.st.type === '全部' || l.type === S.st.type) &&
    (S.st.astatus === '全部' || l.status === S.st.astatus) &&
    (!S.st.target || l.target.includes(S.st.target)) &&
    (!S.st.device || l.device.includes(S.st.device)) &&
    (!S.st.kw || l.summary.includes(S.st.kw) || l.id.includes(S.st.kw)));
}
const pendingN = () => M.logs.filter(l => l.status === '待归档').length;

const kpiList = computed(() => [
  { label: '归档总数', value: U.num(L.total), color: 'blue', icon: 'archive', desc: '历史累计 + 今日' },
  { label: '今日新增', value: U.num(L.today), color: 'orange', icon: 'chart', desc: '与趋势图末点一致' },
  { label: '目标类日志', value: U.num(L.target), color: 'cyan', icon: 'radar', desc: '轨迹 / 雷达 / 巡航' },
  { label: '设备类日志', value: U.num(L.device), color: 'purple', icon: 'device', desc: '状态 / 心跳 / 故障' },
  { label: '处置类日志', value: U.num(L.disposal), color: 'green', icon: 'check', desc: '告警 / 处置 / 授权' },
  { label: '待归档', value: `<span id="arPend">${pendingN()}</span>`, color: 'red', icon: 'alert', desc: '勾选后可批量归档' }
]);

/* ---- 页签一/二（与 legacy 同构） ---- */
function tabList() {
  return `<div class="panel" style="flex:none;margin-bottom:12px"><div class="toolbar" style="border:0">
    ${U.field('关键字', `<input class="ip" id="arKw" style="width:150px" placeholder="编号 / 摘要关键字（回车查询）">`)}
    ${U.field('日志类型', U.select('type', ['全部', ...L.byType.map(t => t.name)], S.st.type))}
    ${U.field('目标编号', `<input class="ip" id="arTgt" style="width:150px" placeholder="如 UAV20260826001">`)}
    ${U.field('设备编号', `<input class="ip" id="arDev" style="width:150px" placeholder="如 DEV260826001">`)}
    ${U.field('归档状态', U.select('astatus', ['全部', '待归档', '已归档'], S.st.astatus))}
    <div class="toolbar-actions">
    <button class="btn" id="arQ" title="下拉筛选即时生效；三个输入框需点查询或回车才应用">${U.icon('search')} 查询</button>
    <button class="btn" id="arR">重置筛选</button>
    <button class="btn warn" id="arBatch" disabled title="请先在列表中勾选待归档记录（仅「待归档」状态可勾选）">▤ 批量归档（<b id="arSelN">0</b>）</button>
    <button class="btn" id="arExp">${U.icon('download')} 导出日志</button>
    <button class="btn ghost" id="arCfg" aria-label="归档策略配置">${U.icon('settings')}</button>
    </div>
  </div></div>

  ${U.panel({
    title: '日志归档列表', sub: `<span id="arCnt"></span>`, style: 'height:calc(100vh - 362px);min-height:530px;margin-bottom:12px', nopad: true,
    body: `<div id="arList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`
  })}`;
}
function tabStat() {
  return `<div class="row" style="height:calc(100vh - 342px);min-height:550px;padding-bottom:12px">
    ${U.panel({
    title: '归档趋势统计', style: 'flex:1.5',
    extra: `<div class="tabs" style="border:0">${['日', '周', '月'].map(t => `<span class="tab ${t === S.gran ? 'on' : ''}" data-ag="${t}">${t}</span>`).join('')}</div>`,
    body: `<div id="arTrend" style="height:100%"></div>`
  })}
    ${U.panel({
    title: '归档类型分布', sub: '今日', style: 'flex:1',
    body: `<div id="arType" style="height:100%"></div>`
  })}
    ${U.panel({
    title: '归档存储与策略', style: 'width:300px',
    body: U.kv([['在线保留', '90 天（热数据）'], ['归档存储', '对象存储 · 3 副本'],
    ['冷备策略', '90 天后转冷，保留 3 年'], ['完整性', 'SHA-256 存证防篡改'],
    ['访问审计', '查看/下载均记录操作人'], ['异常日志', '保留期与案件卷宗一致']])
  })}
  </div>`;
}

const TC = { '告警事件': 't-red', '轨迹日志': 't-blue', '处置记录': 't-amber', '设备状态': 't-cyan', '雷达检测': 't-purple', '巡航飞行': 't-green' };

function list() {
  const rows = sorted(filtered());
  const paged = sliceLocal(rows, S.st.page, S.st.size);
  const page = paged.items;
  return U.table([
    { t: sortTh('记录编号', 'id'), k: 'id', w: '160px', cls: 'num' },
    { t: sortTh('日志类型', 'type'), w: '96px', render: l => U.tag(l.type, TC[l.type]) },
    { t: sortTh('关联目标', 'target'), k: 'target', w: '132px', cls: 'num' },
    { t: sortTh('关联设备', 'deviceName'), k: 'deviceName', w: '150px' },
    { t: sortTh('事件摘要', 'summary'), k: 'summary' },
    { t: sortTh('时间', 'time'), k: 'time', w: '150px', cls: 'num' },
    { t: sortTh('归档状态', 'status'), w: '86px', render: l => U.tag(l.status, l.status === '待归档' ? 't-amber' : 't-green') },
    { t: '操作', w: '96px', render: l => `<span class="lnk" data-lop="${l.id}">详情</span><span class="lnk" data-ldl="${l.id}">下载</span>` }
  ], page, {
    rowId: l => l.id,
    checkbox: l => l.status === '待归档' ? l.id : null
  })
    + U.pager({ total: paged.total, page: paged.page, size: paged.size });
}

function payload(l) {
  const t = M.allTargets.find(x => x.id === l.target);
  const d = M.devices.find(x => x.id === l.device);
  if (l.type === '设备状态') {
    return {
      eventType: 'DEVICE_STATUS', deviceId: l.device, deviceType: d ? d.type : '—',
      status: d ? d.status : '—', health: d ? d.health : '—',
      metrics: { temperature: d ? d.temp : 0, latencyMs: d ? d.latency : null, lossRate: d ? d.loss : null },
      eventTime: l.time, receiveTime: l.time, source: '设备监控'
    };
  }
  return {
    eventType: l.type === '告警事件' ? 'ALERT_INTRUSION' : (l.type === '处置记录' ? 'DISPOSAL_RECORD' : 'TRACK_UPDATE'),
    targetId: l.target, trackId: 'TRK' + (t ? t.seq : 0), deviceId: l.device,
    location: { lat: t ? t.lat : 0, lng: t ? t.lon : 0, alt: t ? t.alt : 0, coordinateSystem: 'WGS-84' },
    speed: t ? t.speed : 0, heading: t ? t.heading : 0,
    zone: t ? t.district : '—', level: t && ['高风险', '超高风险'].includes(t.risk) ? 'HIGH' : 'MEDIUM',
    description: l.summary, source: d ? d.type : '融合感知箱', confidence: t ? t.source_confidence : 0.9,
    eventTime: l.time, receiveTime: l.time
  };
}

function flowOf(l) {
  const base = new Date(l.ts);
  const off = [0, 14, 31, 99, 168, 207];
  const color = ['#ff4d5e', '#ffb020', '#ffb020', '#3d8bff', '#a97bff', '#2fd06e'];
  return M.DISPOSAL_FLOW.map((f, i) => ({
    time: M.util.fmtT(new Date(base.getTime() + off[i] * 1000)),
    label: f.n, desc: f.d, color: color[i]
  }));
}

function detailModal(l) {
  const rr = CH.seeded(l.id);
  const d = M.devices.find(x => x.id === l.device);
  const hasFlow = l.type === '告警事件' || l.type === '处置记录';
  const t = M.allTargets.find(x => x.id === l.target);
  let extra = '';
  if (hasFlow) {
    extra = U.sect('关联处置流程', U.timeline(flowOf(l)));
  } else if (l.type === '设备状态') {
    extra = U.sect('设备当时指标', U.kv([
      ['温度', (d ? d.temp : '—') + ' ℃'], ['时延 / 丢包', (d && d.latency != null ? d.latency + ' ms' : '—') + ' / ' + (d && d.loss != null ? d.loss + ' %' : '—')],
      ['信号强度', (d ? d.rssi : '—') + ' dBm'], ['最后心跳', d ? d.hb : '—']]));
  } else if (t) {
    extra = U.sect('目标轨迹概要', U.kv([
      ['目标类型', t.subtype || t.type], ['跟踪时长', t.durMin + ' 分钟'],
      ['轨迹长度', t.trackKm + ' km'], ['高度 / 速度', t.alt + ' m / ' + t.speed + ' m/s'],
      ['数据来源', t.source + '（置信度 ' + U.confPct(t.source_confidence) + '）']]));
  }
  openModal({
    title: `日志详情 · ${l.id}`, width: '720px',
    body: `${U.detailHero({
      icon: 'archive', title: l.summary, subtitle: '审计与日志归档', id: l.id,
      tags: [U.tag(l.type, TC[l.type]), U.tag(l.status, l.status === '待归档' ? 't-amber' : 't-green')],
      meta: [['事件时间', l.time], ['关联目标', l.target]]
    })}
      ${U.metricStrip([
        { label: '日志类型', value: l.type, icon: 'archive' },
        { label: '归档状态', value: l.status, tone: l.status === '已归档' ? 'good' : 'warn', icon: 'folder' },
        { label: '关联对象', value: l.target || l.device || '—', icon: 'link' },
        { label: '日志大小', value: l.size, icon: 'file' }
      ], { compact: true })}
      ${U.kv([['记录编号', `<span class="mono">${l.id}</span>`], ['事件时间', l.time],
    ['归档状态', l.status], ['归档时间', l.status === '已归档' ? M.util.fmtDT(new Date(l.ts + 207000)) : '—'],
    ['关联目标', l.target], ['关联设备', `${l.deviceName}（${l.device}）`]], { surface: true, density: 'compact' })}
      <div style="margin-top:12px">${U.codeBlock('完整日志内容', JSON.stringify(payload(l), null, 2), { language: 'JSON', maxH: '230px' })}</div>
      ${extra}
      ${U.sect('附件 (3)', `<div class="attachment-list">
        ${[['track_' + l.id.slice(-8) + '.json', '1.24 MB'], ['snapshot_' + l.id.slice(-8) + '.jpg', '512 KB'], ['radar_log_' + l.id.slice(-8) + '.zip', '3.68 MB']]
      .map(([n, sz]) => `<div class="attachment-card">
            <span aria-hidden="true">${U.icon('file')}</span><span class="lnk" style="flex:1">${n}</span><span style="color:var(--txt-3)">${sz}</span><span class="lnk" aria-label="下载附件">${U.icon('download')}</span></div>`).join('')}</div>`)}
      ${U.sect('操作人信息', U.kv([['操作人', M.PILOTS[rr(0, M.PILOTS.length - 1)]], ['角色', '值班员'],
      ['所属单位', '东营市低空安全管理中心'], ['操作终端', '终端-' + M.util.p2(rr(1, 12))],
      ['日志大小', l.size], ['存证哈希', `<span class="mono" style="font-size:11px">sha256:${l.id.replace(/[^0-9a-z]/gi, '').toLowerCase()}8f2a…</span>`]]))}`,
    footer: `<button class="btn" data-close>关闭</button>
      ${l.status === '待归档' ? `<button class="btn warn" data-act="arch" ${M.can('日志归档', 'op') ? '' : 'disabled title="当前角色无归档操作权限"'}>归档本条</button>` : ''}
      <button class="btn pri" data-act="down">${U.icon('download')} 下载完整日志包</button>`,
    on: {
      down: () => {
        if (!M.can('日志归档', 'op')) return toast('需要「日志归档」操作权限', 'err');
        M.pushAudit('日志归档', '下载完整日志包', l.id); toast('已生成日志包（JSON + 轨迹 + 截图 + 审计），共 5.4 MB', 'ok');
      },
      arch: () => {
        if (!M.can('日志归档', 'op')) return toast('需要「日志归档」操作权限', 'err');
        l.status = '已归档'; M.pushAudit('日志归档', '归档日志', l.id); closeModal(); paint(); toast(`「${l.id}」已归档`, 'ok');
      }
    }
  });
}

function paint() {
  const box = document.getElementById('arList');
  box.innerHTML = list();
  document.getElementById('arCnt').textContent = `共 ${U.num(filtered().length)} 条 · 本页可勾选待归档记录`;
  document.getElementById('arPend').textContent = pendingN();
  updateSelN();
}
function updateSelN() {
  const n = U.checked(document.getElementById('arList') || document.body).length;
  const el = document.getElementById('arSelN');
  if (el) el.textContent = n;
  const b = document.getElementById('arBatch');
  if (b) {
    b.disabled = !n;
    b.title = n ? `将 ${n} 条待归档记录批量归档` : '请先在列表中勾选待归档记录（仅「待归档」状态可勾选）';
  }
}

let trendChart = null;
function paintTrend() {
  const el = document.getElementById('arTrend');
  el.innerHTML = '';
  let x, total, abn;
  if (S.gran === '日') {
    x = L.trend.map(t => t.date); total = L.trend.map(t => t.total); abn = L.trend.map(t => t.abnormal);
  } else if (S.gran === '周') {
    const wk = L.trend.reduce((s, t) => s + t.total, 0);
    const wa = L.trend.reduce((s, t) => s + t.abnormal, 0);
    x = ['W31', 'W32', 'W33', 'W34(本周)'];
    total = [Math.round(wk * .82), Math.round(wk * .88), Math.round(wk * .94), wk];
    abn = [Math.round(wa * .82), Math.round(wa * .88), Math.round(wa * .94), wa];
  } else {
    const mo = L.total;
    x = ['2026-06', '2026-07', '2026-08(至今)'];
    total = [Math.round(mo * .29), Math.round(mo * .33), Math.round(mo * .38)];
    abn = total.map(v => Math.round(v * .012));
  }
  trendChart = CH.line(el, {
    x, yName: '归档总数', y2: '异常日志数', yScale: true,
    series: [{ name: '归档总数', data: total, color: CH.C.blue, area: true, label: S.gran !== '日' },
    { name: '异常日志数', data: abn, color: CH.C.red, yAxisIndex: 1, label: S.gran !== '日' }]
  });
}

function paintTab(view) {
  const body = document.getElementById('arBody');
  CH.disposeAll();
  if (S.tab === 'list') {
    body.innerHTML = tabList();
    paint();
    U.bindCheckAll(view || document);
    bindListTools();
  } else {
    body.innerHTML = tabStat();
    requestAnimationFrame(() => {
      if (S.tab !== 'stat' || !document.getElementById('arType')) return;
      paintTrend();
      CH.donut(document.getElementById('arType'), { data: L.byType, centerLabel: '今日合计', centerValue: L.today });
    });
  }
}

function bindListTools() {
  const g2 = id => document.getElementById(id);
  if (!g2('arQ')) return;
  const inputs = ['arKw', 'arTgt', 'arDev'];
  const cur = () => ({ kw: g2('arKw').value.trim(), target: g2('arTgt').value.trim(), device: g2('arDev').value.trim() });
  const dirty = () => { const c = cur(); return c.kw !== S.st.kw || c.target !== S.st.target || c.device !== S.st.device; };
  function syncQ() {
    const b = g2('arQ'); if (!b) return;
    const d = dirty();
    b.className = 'btn' + (d ? ' pri' : '');
    b.innerHTML = `${U.icon('search')} ${d ? '查询（有未应用条件）' : '查询'}`;
    b.title = d ? '点击应用输入框中的检索条件' : '输入框条件已全部应用；下拉筛选即时生效，无需点查询';
  }
  const doQuery = () => {
    if (!dirty()) return toast('检索条件未变化（下拉筛选已即时生效，输入框条件也已应用）');
    Object.assign(S.st, cur());
    S.st.page = 1; paint(); syncQ();
    toast('查询完成，命中 ' + filtered().length + ' 条', 'ok');
  };
  inputs.forEach(i => {
    const el = g2(i); if (!el) return;
    el.oninput = syncQ;
    el.onkeydown = e => { if (e.key === 'Enter') doQuery(); };
  });
  syncQ();
  g2('arQ').onclick = doQuery;
  g2('arR').onclick = () => {
    S.st = { page: 1, size: S.st.size, type: '全部', astatus: '全部', kw: '', target: '', device: '' };
    ['arKw', 'arTgt', 'arDev'].forEach(i => g2(i).value = '');
    document.querySelectorAll('#arBody select[data-f]').forEach(s2 => s2.selectedIndex = 0);
    paint(); syncQ();
  };
  g2('arExp').onclick = () => {
    if (!M.can('日志归档', 'op')) return toast('需要「日志归档」操作权限', 'err');
    M.pushAudit('日志归档', `导出日志归档 ${filtered().length} 条`, 'ARCHIVE'); toast('已导出「日志归档.csv」共 ' + filtered().length + ' 条', 'ok');
  };
  g2('arCfg').onclick = () => M.can('日志归档', 'op') ? cfgModal() : toast('需要「日志归档」操作权限', 'err');
  g2('arBatch').onclick = () => {
    if (!M.can('日志归档', 'op')) return toast('需要「日志归档」操作权限', 'err');
    const ids = U.checked(document.getElementById('arBody'));
    if (!ids.length) return toast('请先勾选左侧待归档记录（仅待归档记录可勾选）', 'err');
    ids.forEach(id => { const l = M.logs.find(x => x.id === id); if (l) l.status = '已归档'; });
    M.pushAudit('日志归档', `批量归档 ${ids.length} 条记录`, 'ARCHIVE');
    paint();
    const pe = document.getElementById('arPend');
    if (pe) pe.textContent = pendingN();
    toast(`已归档 ${ids.length} 条记录，待归档剩余 ${pendingN()} 条`, 'ok');
  };
}

function cfgModal() {
  openModal({
    title: '归档策略配置', width: '520px',
    body: U.kv([['自动归档', '事件闭环后 T+0 自动归档'], ['待归档兜底', '超 24h 未闭环记录转人工批量归档'],
    ['在线保留', '90 天（热数据）'], ['冷备周期', '90 天后转冷存储，保留 3 年'],
    ['完整性校验', 'SHA-256 存证，防篡改'], ['访问审计', '所有下载与查看均记录操作人与终端']])
  });
}

function setTab(k) {
  if (S.tab === k) return;
  S.tab = k; tab.value = k;
  paintTab(root.value);
}

onMounted(() => {
  const view = root.value;
  paintTab(view);
  U.on(view, '[data-row]', 'click', (e, el) => { const l = M.logs.find(x => x.id === el.dataset.row); if (l) detailModal(l); });
  U.on(view, '[data-lop]', 'click', (e, el) => { e.stopPropagation(); const l = M.logs.find(x => x.id === el.dataset.lop); if (l) detailModal(l); });
  U.on(view, '[data-ldl]', 'click', (e, el) => { e.stopPropagation(); toast('已下载日志 ' + el.dataset.ldl + '（Demo）', 'ok'); });
  U.on(view, '[data-pg]', 'click', (e, el) => { if (el.dataset.pg) { S.st.page = +el.dataset.pg; paint(); } });
  U.on(view, '[data-size]', 'change', (e, el) => { S.st.size = parseInt(el.value); S.st.page = 1; paint(); });
  U.on(view, '[data-f]', 'change', (e, el) => { S.st[el.dataset.f] = el.value; S.st.page = 1; paint(); });
  U.on(view, '[data-ck],[data-ckall]', 'change', updateSelN);
  U.on(view, '[data-sort]', 'click', (e, el) => {
    const k = el.dataset.sort;
    if (S.SORT.key === k) S.SORT.dir = S.SORT.dir === 'asc' ? 'desc' : 'asc';
    else { S.SORT.key = k; S.SORT.dir = 'asc'; }
    S.st.page = 1;
    paint();
  });
  U.on(view, '[data-ag]', 'click', (e, el) => {
    S.gran = el.dataset.ag;
    view.querySelectorAll('[data-ag]').forEach(x => x.classList.toggle('on', x === el));
    paintTrend();
  });
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <UKpis :list="kpiList" />
    <!-- P3：页签换 n-tabs（模板层受控；行为同 setTab） -->
    <n-tabs type="line" size="small" :value="tab" @update:value="setTab" style="margin:12px 0 0">
      <n-tab name="list">日志检索</n-tab>
      <n-tab name="stat">归档统计与策略</n-tab>
    </n-tabs>
    <div id="arBody" style="margin-top:12px"></div>
  </div>
</template>
