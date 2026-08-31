<script>
/* 模块级状态：筛选条跨导航保持（legacy 约定）；sel 每次进入重置为首个实时目标
   （legacy render() 行为）。 */
const S = {
  flt: { region: '东营市全域', ttype: '全部', risk: '全部', src: '全部' }
};
export default {};
</script>

<script setup>
/* 融合感知中心（实时态势）—— 转换页（源：legacy pages/situation.js）。
   ⚠ g.TARGET_MEDIA / g.TARGET_ACTIONS 与两条 U.regParams 由 legacy script
   模块加载期导出/登记，这里不重复；本页的「实时视频 / 轨迹回放」直接复用
   window.TARGET_MEDIA（同一套弹窗实现，跨页与本页共用一份）。 */
import { ref, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '../shell/usePageChrome.js';
import UPanel from '../ui/UPanel.vue';

const M = window.MOCK, U = window.UI, CH = window.CH;
usePageChrome('situation');
const root = ref(null);

let map = null, sel = null;
let almFocus = null;
let selAlarmId = null;
let drawerEl = null;
const flt = S.flt;

function matchFilter(t) {
  if (flt.region !== '东营市全域' && t.district !== flt.region) return false;
  if (flt.ttype !== '全部' && t.type !== flt.ttype) return false;
  if (flt.risk !== '全部' && t.risk !== flt.risk) return false;
  if (flt.src !== '全部' && t.source !== flt.src) return false;
  return true;
}
const shownTargets = () => M.liveTargets.filter(matchFilter);
const latestAlarmIdOf = id => {
  const as = shownAlarms().filter(a => a.targetId === id);
  if (!as.length) return null;
  return as.slice().sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))[0].id;
};
function shownAlarms() {
  const ids = new Set(shownTargets().map(t => t.id));
  return M.todayAlarms.filter(a => {
    if (flt.region !== '东营市全域' && a.district !== flt.region) return false;
    if (flt.ttype !== '全部' || flt.risk !== '全部' || flt.src !== '全部') return ids.has(a.targetId);
    return true;
  });
}

/* ---- 首屏骨架（与 legacy render() 同构） ---- */
sel = M.liveTargets[0];
const t0 = M.CONF.demoTime;
const from = M.util.fmtDT(new Date(t0.getTime() - 3600000));
const toolbarHtml = `${U.field('区域', U.select('region', ['东营市全域', ...M.DISTRICTS.map(d => d.name)], flt.region))}
    ${U.field('时间范围', `<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px"
      title="实时态势固定展示最近 1 小时；历史时段请使用「轨迹回放」或前往日志归档">${from} ~ ${M.util.fmtDT(t0)}
      <span style="color:var(--txt-3)">（近 1 小时）</span></span>`)}
    ${U.field('目标类型', U.select('ttype', ['全部', ...M.T_TYPES.map(x => x[0])], flt.ttype))}
    ${U.field('风险等级', U.select('risk', ['全部', '超高风险', '高风险', '中风险', '低风险'], flt.risk))}
    <span style="flex:1"></span>
    <span id="stFltInfo" style="font-size:11.5px"></span>
    <span style="font-size:11.5px;color:var(--txt-3);margin-left:10px">图层控制见地图右上角</span>`;
const techExtra = `<button class="btn ghost" id="btnTech">${U.icon('settings')} 技术详情</button>`;

/* ---- 当前追踪目标 ---- */
function paintTarget() {
  const t = sel;
  document.getElementById('stTarget').innerHTML = `
    <div class="target-summary-head">
      <span class="target-summary-icon">${U.icon('plane')}</span>
      <span><small>实时追踪目标</small><b class="mono">${t.id}</b></span>
      <span class="target-summary-tags">${U.legal(t.legal)}${U.risk(t.risk)}</span>
    </div>
    ${U.metricStrip([
      { label: '目标类型', value: t.subtype || t.type, icon: 'plane' },
      { label: '飞行速度', value: t.speed, unit: 'm/s', icon: 'trend' },
      { label: '当前高度', value: t.alt, unit: 'm', icon: 'chart' },
      { label: '融合来源', value: t.srcCount, unit: '路', tone: 'info', icon: 'radar' }
    ], { compact: true })}
    <div style="margin-top:5px;font-size:12.5px;display:flex;flex-direction:column;gap:4px">
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">经纬度</span>
        <span class="mono">${t.lon.toFixed(3)}°E, ${t.lat.toFixed(3)}°N</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">数据来源</span>
        <span>${t.srcCount} 路（融合置信度 <b style="color:#8fbaff">${t.fusedConf}%</b>）</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">所在空域</span>
        <span style="min-width:0">${t.zone ? `${t.zone.name}（${t.zone.limitTx}）` : '—'}</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">合法性</span>
        <span style="min-width:0">${t.type === '无人机'
      ? (t.violation ? `<span style="color:#ff8b95">${t.legal} · ${t.violation}</span>` : t.legal)
      : `<span class="tag t-gray">不适用</span> <span style="color:var(--txt-3);font-size:11px">非无人机走空间安全风险线（§4.2）</span>`}</span></div>
    </div>
    <div id="stAct" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-2)"></div>`;
}

/* ---- 融合卡（按接入路分组，与 legacy 同构） ---- */
const CH_OF = {
  '雷达': ['第1路 · 融合感知箱', '#3d8bff'], '光电': ['第1路 · 融合感知箱', '#ffb020'],
  'TDOA/AOA': ['第3路 · TDOA', '#a97bff'], '5G-A基站': ['第2路 · 5G-A', '#22d3ee']
};
const SHORT = { '雷达': '雷达', '光电': '光电', 'TDOA/AOA': 'TDOA', '5G-A基站': '5G-A' };

function paintFuse() {
  const t = sel, f = t.fused;
  const sensorRow = k => {
    const s2 = f[k], c = (CH_OF[k] || [null, '#8ca0be'])[1];
    const w = M.fusionWeights[k];
    return `<div style="display:flex;flex-direction:column;gap:4px;${s2.on ? '' : 'opacity:.42'}">
      <div class="sh" style="font-size:12.5px"><span class="dot-s" style="background:${s2.on ? c : '#5a6c88'}"></span>
        <b>${SHORT[k] || k}</b><span class="st">${s2.on ? s2.识别结果 : '未接入'}</span></div>
      <div class="bar"><i style="width:${s2.on ? s2.置信度 : 0}%;background:${c}"></i></div>
      <div class="sv"><span>置信度${w != null ? ' · 权重 ' + w + '%' : ''}</span>
        <b class="mono" style="color:${s2.on ? c : 'var(--txt-3)'}">${s2.on ? s2.置信度 + '%' : '—'}</b></div>
    </div>`;
  };
  const GROUPS = [
    { name: '融合感知箱', sub: '第1路 · 雷达 + 光电', ks: ['雷达', '光电'] },
    { name: '5G-A', sub: '第2路', ks: ['5G-A基站'] },
    { name: 'TDOA', sub: '第3路', ks: ['TDOA/AOA'] }
  ];
  const bars = GROUPS.filter(gp => gp.ks.some(k => f[k])).map(gp => {
    const anyOn = gp.ks.some(k => f[k] && f[k].on);
    return `<div class="s ${anyOn ? '' : 'off'}">
      <div class="sh"><b>${gp.name}</b><span class="st">${gp.sub}</span></div>
      ${gp.ks.filter(k => f[k]).map(sensorRow).join('')}
    </div>`;
  }).join('');
  document.getElementById('stFuse').innerHTML = `
    <div style="display:flex;align-items:center;gap:22px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:12.5px;color:var(--txt-3)">融合置信度</div>
        <div style="font-size:32px;font-weight:700;line-height:1.15;font-family:'DIN Alternate',Menlo,sans-serif;
          color:${t.fusedConf >= 80 ? '#79e5a5' : '#ffd07a'}">${t.fusedConf}<span style="font-size:17px">%</span></div></div>
      <div style="font-size:13.5px;line-height:1.9;color:var(--txt-2)">
        <div>当前结论　<b style="color:var(--txt)">${t.subtype || t.type}</b>　${U.legal(t.legal)}　${U.risk(t.risk)}</div>
        <div>接入来源　<b style="color:var(--txt)">${t.srcCount}</b> 路　·　建议动作
          <b style="color:#79e6f6">${t.type === '无人机'
      ? (t.legal === '非法' ? '核实后申请反制授权' : '持续跟踪')
      : M.riskAdvice(M.riskLevelOf(t))}</b></div>
      </div>
    </div>
    <div class="srcbar">${bars}</div>`;
}

/* ---- 技术详情抽屉 ---- */
function closeDrawer() {
  if (drawerEl) { drawerEl.remove(); drawerEl = null; }
  document.querySelectorAll('.drawer-mask').forEach(x => x.remove());
}
function techDrawer() {
  closeDrawer();
  const f = sel.fused;
  const cards = Object.keys(f).map(k => {
    const s2 = f[k];
    const col = s2.on ? (s2.置信度 >= 80 ? '#2fd06e' : '#ffb020') : '#8ca0be';
    const w = M.fusionWeights[k] != null ? `<span class="tag t-blue" style="margin-left:4px">权重 ${M.fusionWeights[k]}%</span>` : '';
    const ch = CH_OF[k] || ['—', '#8ca0be'];
    return `<div class="fc" style="border:1px solid var(--line);border-radius:6px;background:var(--panel-2);
        padding:10px 12px;margin-bottom:10px;${s2.on ? '' : 'opacity:.5'}">
      <h5 style="font-size:13.5px;color:#9ec6ff;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
        <span>${k}</span><span>${w}<span class="tag" style="background:${col}22;color:${col};border-color:${col}55">${s2.on ? '接入' : '无数据'}</span></span></h5>
      <div style="font-size:11.5px;color:${ch[1]};margin-bottom:6px">${ch[0]}</div>
      ${U.kv(Object.keys(s2).filter(x => x !== 'on').map(x => [x, x === '置信度' ? (s2[x] ? `<b style="color:${col}">${s2[x]}%</b>` : '—') : s2[x]]))}
    </div>`;
  }).join('');
  const mask = document.createElement('div'); mask.className = 'drawer-mask';
  mask.onclick = closeDrawer;
  drawerEl = document.createElement('div');
  drawerEl.className = 'drawer';
  drawerEl.innerHTML = `<div class="dh">技术详情 · <span class="mono" style="font-size:14px">${sel.id}</span>
      <span class="x" data-x>${U.icon('close')}</span></div>
    <div class="db">
      <div style="font-size:13px;color:var(--txt-3);margin-bottom:8px">各来源上报字段</div>
      ${cards}</div>`;
  document.body.appendChild(mask); document.body.appendChild(drawerEl);
  drawerEl.querySelector('[data-x]').onclick = closeDrawer;
}

/* ---- 告警列表 ---- */
function paintAlarms() {
  const list = shownAlarms();
  if (!list.length) {
    document.getElementById('stAlarms').innerHTML =
      '<div class="empty">当前筛选条件下无告警<div style="font-size:11.5px;margin-top:4px">可点击上方「清除」恢复全量</div></div>';
    return;
  }
  document.getElementById('stAlarms').innerHTML = list.slice(0, 12).map(a => {
    const live = M.liveTargets.some(t => t.id === a.targetId);
    return `
    <div class="a lv-${a.level}${live ? '' : ' hist'}" data-alm="${a.targetId}" data-alm-id="${a.id}"
      title="${live ? '点击：在地图上跟踪该目标' : '该目标已离开实时跟踪窗口 —— 点击在地图上定位其告警发生时位置'}"
      ${a.id === selAlarmId
      ? 'style="border:1px solid var(--cyan);background:rgba(34,211,238,.08)"' : ''}>
      <div class="r1"><span class="id">${a.targetId}</span>${U.tag(a.type)}
        ${U.tag(a.level === '高' ? '高风险' : a.level === '中' ? '中风险' : '低风险')}
        <span style="margin-left:auto" class="mono" style="color:var(--txt-3)">${a.time.slice(11)}</span></div>
      <div class="r2"><span>${a.district}</span>
        <span>${live ? '' : '<span class="hist-tag" title="目标已离开实时跟踪窗口">非实时</span>'}${U.tag(a.status)}</span></div>
    </div>`; }).join('');
}

/* ---- 处置动作区 ---- */
const alarmsOf = id => (M.alarms || []).filter(a => a.targetId === id);

function paintActions() {
  const t = sel, isUav = t.type === '无人机';
  const alms = alarmsOf(t.id);
  const latest = alms.length
    ? alms.slice().sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))[0] : null;
  const almBtn = latest
    ? `<button class="btn warn" id="btnAlm" style="flex:1;justify-content:center"
         title="转到「告警事件」并定位到 ${latest.id}">⚠ 查看告警${alms.length > 1 ? '（' + alms.length + ' 条）' : ''} →</button>`
    : '';
  document.getElementById('stAct').innerHTML = isUav
    ? `
       <div style="display:flex;gap:8px;margin-top:8px">
         <button class="btn" id="btnVideo" style="flex:1;justify-content:center">${U.icon('video')} 实时视频</button>
         <button class="btn" id="btnReplay" style="flex:1;justify-content:center">轨迹回放</button>
         ${almBtn}
       </div>`
    : `<button class="btn big" style="width:100%;justify-content:center" disabled title="非无人机目标不进入反制流程">
         ${U.icon('bolt')} 发起联动反制（不适用）</button>
       <div style="display:flex;gap:8px;margin-top:8px">
         <button class="btn" id="btnVideo" style="flex:1;justify-content:center">${U.icon('video')} 实时视频</button>
         <button class="btn" id="btnNotify" style="flex:1;justify-content:center">通知机场/周边</button>
         <button class="btn" id="btnDrive" style="flex:1;justify-content:center">派发驱离</button>
         <button class="btn" id="btnRisk" style="flex:1;justify-content:center">转风险监测 →</button>
       </div>
       <div class="warnbox" style="margin:6px 0 0;padding:6px 9px;font-size:11px;line-height:1.5">
         §4.2：<b>${t.subtype || t.type}</b>不做合法性判定、不进入反制与处罚流程，仅风险评估与通知/驱离。</div>`;
  bindActions(isUav);
}
function bindActions(isUav) {
  const g2 = id => document.getElementById(id);
  /* 视频/回放弹窗复用 legacy 的跨页导出（同一套实现，弹窗自管生命周期） */
  g2('btnVideo').onclick = () => window.TARGET_MEDIA.openVideo(sel);
  const almEl = g2('btnAlm');
  if (almEl) almEl.onclick = () => {
    const a = alarmsOf(sel.id).slice().sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))[0];
    if (!a) return U.toast('该目标暂无关联告警记录', 'err');
    sessionStorage.setItem('alarm.sel', a.id);
    location.hash = '#/alarms';
  };
  if (isUav) {
    g2('btnReplay').onclick = () => window.TARGET_MEDIA.openReplay(sel);
  } else {
    g2('btnNotify').onclick = () => U.toast('已通知东营胜利机场塔台与属地派出所（回执 2/2）', 'ok');
    g2('btnDrive').onclick = () => U.toast('已派发驱离作业任务至属地保障单位', 'ok');
    g2('btnRisk').onclick = () => { U.toast('正在跳转空间安全风险监测…'); setTimeout(() => location.hash = '#/risk', 600); };
  }
}

function paintTag() {
  const el = document.getElementById('stTag');
  if (!el) return;
  const m2 = { '跟踪中': ['t-cyan', '#22d3ee'], '处置中': ['t-orange', '#ff8b3d'], '已处置': ['t-green', '#2fd06e'] };
  const [cls, col] = m2[sel.status] || ['t-gray', '#8ca0be'];
  el.innerHTML = `<span class="tag ${cls}"><span class="dot-s" style="background:${col}"></span>${sel.status}</span>`;
}

function applyFilter() {
  const ts = shownTargets(), as = shownAlarms();
  let mapTargets = ts;
  if (almFocus && !ts.some(t => t.id === almFocus)) {
    const ht = (M.todayTargets || []).find(x => x.id === almFocus)
      || (M.allTargets || []).find(x => x.id === almFocus);
    if (ht) mapTargets = ts.concat([ht]);
  }
  if (map) map.setData({
    airspaces: M.airspaces,
    devices: M.devices.filter((d, i) => i % 4 === 0),
    targets: mapTargets, alarms: as
  });
  if (ts.length && !ts.some(t => t.id === sel.id)) { sel = ts[0]; if (map) map.sel = sel.id; }
  paintAlarms();
  const badge = document.getElementById('stFltInfo');
  if (badge) {
    const on = flt.region !== '东营市全域' || flt.ttype !== '全部' || flt.risk !== '全部' || flt.src !== '全部';
    badge.innerHTML = on
      ? `<span class="tag t-amber">已筛选</span> <span style="color:var(--txt-2)">目标 ${ts.length}/${M.liveTargets.length} · 告警 ${as.length}/${M.todayAlarms.length}</span>
         <span class="lnk" id="stFltReset" style="margin-left:6px">清除</span>`
      : `<span style="color:var(--txt-3)">目标 ${ts.length} · 告警 ${as.length}</span>`;
    const rs = document.getElementById('stFltReset');
    if (rs) rs.onclick = () => {
      Object.assign(flt, { region: '东营市全域', ttype: '全部', risk: '全部', src: '全部' });
      document.querySelectorAll('#view [data-f]').forEach(el => { if (flt[el.dataset.f] != null) el.value = flt[el.dataset.f]; });
      applyFilter(); refresh();
    };
  }
}

function refresh() {
  paintTarget(); paintFuse(); paintAlarms(); paintTag(); paintActions();
}

onUnmounted(() => { if (map) map.destroy(); map = null; closeDrawer(); });

onMounted(() => {
  const view = root.value;
  map = new window.MapView(document.getElementById('stMap'), {
    maxDev: 46, maxAlarm: 6, zoom: 1.06, legend: false,
    onPick: p => {
      if (p.kind === 'target') {
        sel = M.liveTargets.find(t => t.id === p.data.id) || sel;
        almFocus = null;
        selAlarmId = latestAlarmIdOf(sel.id);
        refresh();
      }
    }
  });
  const ctx = U.consume('situation');
  if (ctx && ctx.target) {
    const t = M.liveTargets.find(x => x.id === ctx.target);
    if (t) sel = t;
    else U.toast('该目标已脱离实时跟踪窗口，已显示当前追踪目标');
  }
  applyFilter();
  map.sel = sel.id;
  selAlarmId = latestAlarmIdOf(sel.id);
  if (ctx && ctx.target && map.w) {
    const q = map.px(sel.lon, sel.lat);
    map.ox += map.w / 2 - q[0]; map.oy += map.h / 2 - q[1];
  }
  refresh();

  // 图层控制浮层（图层键/名称/配色由 M.AIRSPACE_TYPES 生成，与 legacy 同源）
  const lyBox = document.createElement('div');
  lyBox.className = 'maplayers';
  const AT = M.AIRSPACE_TYPES;
  const layerLabel = k => [...new Set(AT.filter(a => a.layer === k).map(a => a.legend))].join(' / ');
  const layerColor = k => (AT.find(a => a.layer === k) || {}).color;
  const LY = [
    ['device', '设备点位', '<span class="sw dot" style="background:#22d3ee"></span>'],
    ['track', '无人机轨迹', '<span class="sw ln" style="border-color:#2fd06e"></span>']
  ].concat([...new Set(AT.map(a => a.layer))].map(k =>
    [k, layerLabel(k), `<span class="sw ln" style="border-color:${layerColor(k)}"></span>`]));
  lyBox.classList.add('collapsed');
  lyBox.innerHTML = `<div class="lyt" role="button" tabindex="0" aria-label="展开或收起图层与图例">图层与图例 <span class="lg-arrow">▸</span></div>` +
    LY.map(([k, n, sw]) => `<label><input type="checkbox" data-layer="${k}" checked>${sw}${n}</label>` +
      (k === 'track' ? `<div class="sub"><i style="border-color:#ff4d5e"></i>非法/告警</div>
        <div class="sub" title="弥合段（A03）"><i style="border-color:#ff8b3d"></i>推算补全段</div>
        <div class="sub" title="预测段（A04）"><i style="border-color:#22d3ee"></i>预测延伸段</div>` : '')).join('');
  document.getElementById('stMap').appendChild(lyBox);
  lyBox.querySelector('.lyt').addEventListener('click', () => {
    const c = lyBox.classList.toggle('collapsed');
    lyBox.querySelector('.lg-arrow').textContent = c ? '▸' : '▾';
  });
  U.on(view, '[data-layer]', 'change', (e, el) => map.setLayer(el.dataset.layer, el.checked));
  U.on(view, '[data-alm]', 'click', (e, el) => {
    selAlarmId = el.dataset.almId;
    const t = M.liveTargets.find(x => x.id === el.dataset.alm);
    if (t) {
      almFocus = null;
      applyFilter();
      sel = t; map.sel = t.id;
      if (map.w) { const q = map.px(t.lon, t.lat); map.ox += map.w / 2 - q[0]; map.oy += map.h / 2 - q[1]; }
      refresh();
    }
    else {
      const ht = (M.todayTargets || []).find(x => x.id === el.dataset.alm)
        || (M.allTargets || []).find(x => x.id === el.dataset.alm);
      if (!ht) return U.toast('该告警未关联到可定位的目标记录', 'err');
      almFocus = ht.id;
      applyFilter();
      map.sel = ht.id;
      if (map.w && ht.lon != null) {
        const q = map.px(ht.lon, ht.lat);
        map.ox += map.w / 2 - q[0]; map.oy += map.h / 2 - q[1];
      }
      refresh();
      U.toast('已在地图定位 ' + ht.id + '（该目标已离开实时跟踪窗口，显示为告警发生时位置）');
    }
  });
  U.on(view, '[data-f]', 'change', (e, el) => {
    if (flt[el.dataset.f] === undefined) return;
    flt[el.dataset.f] = el.value;
    almFocus = null;
    selAlarmId = null;
    applyFilter(); refresh();
  });
  document.getElementById('btnTech').onclick = techDrawer;
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div class="panel" style="flex:none;margin-bottom:12px">
      <div class="toolbar" style="border:0" v-html="toolbarHtml"></div>
    </div>

    <div class="row" style="height:calc(100vh - 184px);min-height:560px;padding-bottom:12px">
      <!-- 左栏：地图(主) + 多源融合识别结果 -->
      <div class="col" style="flex:1;min-width:0">
        <UPanel :title="false" panel-style="flex:1;min-height:0" nopad body-style="padding:6px"
          body-html='<div id="stMap" style="width:100%;height:100%"></div>' />
        <UPanel title="多源融合结果" sub="融合置信度阈值 80%" panel-style="flex:none;height:264px"
          :extra="techExtra" body-html='<div id="stFuse"></div>' />
      </div>

      <!-- 右栏：当前目标与处置 → 实时告警。
           420px 固定宽 → 占 40%（用户 2026-08-30）；420px 下限保窄屏排版不塌 -->
      <div class="col" style="width:40%;min-width:420px;flex:none">
        <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导） -->
        <div class="warnbox" style="margin:0;padding:8px 11px;font-size:12px;flex:none">
          演示动线：在<b>地图</b>或下方<b>「实时告警列表」</b>点选目标 → 本卡查看研判结论 →
          底部按「<b>实时视频 / 轨迹回放 / 查看告警</b>」演示；反制在告警详情内发起。</div>
        <UPanel title="当前追踪目标 · 处置" panel-style="flex:none" nopad
          extra='<span id="stTag"></span>' body-style="padding:12px;overflow:auto"
          body-html='<div id="stTarget"></div>' />
        <UPanel title="实时告警列表" panel-style="flex:1;min-height:172px" nopad
          extra='<span class="lnk" onclick="location.hash=&#39;#/alarms&#39;">查看更多 ›</span>'
          body-style="padding:8px;overflow:auto"
          body-html='<div class="alarm" id="stAlarms"></div>' />
      </div>
    </div>
  </div>
</template>
