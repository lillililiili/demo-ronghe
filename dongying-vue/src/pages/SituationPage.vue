<script>
/* 模块级状态：筛选条件默认全量（顶部筛选条已按产品要求移除）；sel 每次进入重置为首个实时目标
   （legacy render() 行为）。 */
const S = {
  flt: { region: '东营市全域', ttype: '全部', risk: '全部', src: '全部' }
};
export default {};
</script>

<script setup>
/* 融合感知中心（实时态势）。数据全部来自只读接口，本页不再读 window.MOCK（阶段 11）。
   ⚠ g.TARGET_MEDIA / g.TARGET_ACTIONS 与两条 U.regParams 由 legacy script 模块加载期登记，这里不重复。

   三条贯穿本页的规矩：
   1. 未知不补默认值：没有 ACTIVE 研判的目标显示"待确认"而不是"合法"（决策 11-3）；
      没有位置的目标（AOA 只给方位）进列表但地图不画点；没有的数值不渲染成 0 或 —— 整行不出现。
   2. 后端不可达时显示错误态，绝不回退演示数据——回退会让人以为看到的是真实空情。
   3. 没有后端能力的按钮禁用并标"未接入"（决策 11-4），不删按钮（删按钮属于改布局）。 */
import { ref, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { toast } from '@/ui/nv.js';
import { targetApi } from '@/services/targetApi.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { deviceApi } from '@/services/deviceApi.js';
import { listAlarms } from '@/services/alarmApi.js';
import { legalityApi } from '@/services/legalityApi.js';
import { SOURCE_TYPE_LABEL, SCHEMA_STATUS_LABEL, labelOf } from '@/ui/labels.js';
import { disposalApi } from '@/services/disposalApi.js';
import { openDisposalRequest } from '@/ui/disposalAuthModal.js';
import {
  AIRSPACE_LAYERS, legalByTarget, percent, toAirspaces, toAlarms, toDevices, toTargets, toTrack
} from '@/services/situationData.js';

const U = window.UI;
usePageChrome('situation');
const root = ref(null);

let map = null, sel = null;
let almFocus = null;
let selAlarmId = null;
const flt = S.flt;
const fuseOpen = ref(false);
const fuseVisible = ref(false);
const fuseIcon = U.icon('radar');

/* 接口数据（模块内可变，不进模板；模板只用 fuseVisible/fuseOpen 两个 ref） */
let liveTargets = [];
let liveAlarms = [];
let liveAirspaces = [];
let liveDevices = [];
let selDetail = null;
let sourceOnline = {};
let timers = [];

/* 轮询节奏（决策 11-5）：目标与告警变化快，空域与设备是慢变基础数据。 */
const FAST_POLL_MS = 5000, SLOW_POLL_MS = 60000;

function toggleFuse() {
  if (!fuseVisible.value) return;
  fuseOpen.value = !fuseOpen.value;
}

function matchFilter(t) {
  if (flt.region !== '东营市全域' && t.district !== flt.region) return false;
  if (flt.ttype !== '全部' && t.type !== flt.ttype) return false;
  return true;
}
const shownTargets = () => liveTargets.filter(matchFilter);
const latestAlarmIdOf = id => {
  const as = shownAlarms().filter(a => a.targetId === id);
  if (!as.length) return null;
  return as.slice().sort((x, y) => y.ts - x.ts)[0].id;
};
function shownAlarms() {
  const ids = new Set(shownTargets().map(t => t.id));
  return liveAlarms.filter(a => {
    if (flt.region !== '东营市全域' && a.district !== flt.region) return false;
    if (flt.ttype !== '全部') return ids.has(a.targetId);
    return true;
  });
}

/* ---- 地图悬浮卡 ---- */
const STATUS_TAG = { '跟踪中': ['t-cyan', '#22d3ee'], '处置中': ['t-orange', '#ff8b3d'], '已处置': ['t-green', '#2fd06e'] };
function legalColor(t) {
  return t.legal === '非法' ? '#ff4d5e' : t.legal === '异常' ? '#ff8b3d'
    : t.legal === '待确认' ? '#ffb020' : t.legal === '不适用' ? '#8ca0be' : '#2fd06e';
}
function statusTag(t) {
  if (!t.status) return '';
  const [cls, col] = STATUS_TAG[t.status] || ['t-gray', '#8ca0be'];
  return `<span class="tag ${cls}"><span class="dot-s" style="background:${col}"></span>${t.status}</span>`;
}
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function tipActions(t) {
  const isUav = t.type === '无人机';
  const latest = alarmsOf(t.id).slice().sort((x, y) => y.ts - x.ts)[0] || null;
  const id = esc(t.id);
  const almBtn = latest
    ? `<button type="button" class="btn warn" data-tip-act="alarm" data-tip-id="${id}"
         title="转到「告警事件」并定位到该告警">⚠ 查看告警 →</button>`
    : '';
  /* 没有后端能力的按钮一律"保留 + 禁用 + 标注"，不删（决策 11-4 / 11-7）：删按钮属于改布局，
     而留着能点、点了弹一句假的成功提示，比禁用更糟——那会让人以为通知真的发出去了。 */
  const videoBtn = `<button type="button" class="btn" disabled title="尚未接入">${U.icon('video')} 实时视频（未接入）</button>`;
  const notifyBtn = `<button type="button" class="btn" disabled title="尚未接入">通知机场/周边（未接入）</button>`;
  /* 阶段 13：驱离改为走处置授权——按钮只负责“提申请”，批准与执行由授权流程决定，
     点了不会有任何设备动作，也不会弹假成功。 */
  const driveBtn = `<button type="button" class="btn" data-tip-act="drive" data-tip-id="${id}">派发驱离</button>`;
  /* "转风险监测"保持可用：它是 #/risk 深链的三个生产者之一（阶段 9 决策 9-15 专门保住的），去掉会断掉这条跳转。 */
  const riskBtn = `<button type="button" class="btn" data-tip-act="risk" data-tip-id="${id}">转风险监测 →</button>`;
  if (isUav) {
    return `<div class="maptip-track-acts">${videoBtn}${almBtn}</div>`;
  }
  return `<div class="maptip-track-note">非无人机不进入反制流程，仅评估与通知/驱离</div>
    <div class="maptip-track-acts is-grid">${videoBtn}${notifyBtn}${driveBtn}${riskBtn}${almBtn}</div>`;
}
function renderTargetTip(t) {
  const lon = Number.isFinite(t.lon) ? t.lon.toFixed(3) : '—';
  const lat = Number.isFinite(t.lat) ? t.lat.toFixed(3) : '—';
  return `<div class="maptip-track">
    <header class="maptip-track-hd">
      <div class="maptip-track-id">
        <b style="color:${legalColor(t)}">${esc(t.id)}</b>
        <span class="maptip-track-type">${esc(t.typeLabel || t.type)}</span>
      </div>
      ${statusTag(t)}
    </header>
    <div class="maptip-track-tags">${esc(t.legal)}</div>
    <div class="maptip-track-metrics">
      <div class="maptip-metric">
        <span class="maptip-metric-ic">${U.icon('trend')}</span>
        <span><small>飞行速度</small><b>${t.speed == null ? '—' : esc(t.speed)}<em>m/s</em></b></span>
      </div>
      <div class="maptip-metric">
        <span class="maptip-metric-ic">${U.icon('chart')}</span>
        <span><small>当前高度</small><b>${t.alt == null ? '—' : esc(t.alt)}<em>m</em></b></span>
      </div>
    </div>
    <div class="maptip-track-geo"><span>经纬度</span><span class="mono">${t.posValid ? `${lon}°E, ${lat}°N` : '未提供位置'}</span></div>
    ${tipActions(t)}
  </div>`;
}
function renderMapTip(hit) {
  if (hit.kind !== 'target' || !hit.data) return null;
  return renderTargetTip(hit.data);
}
function selectTarget(t) {
  if (!t) return;
  sel = t;
  almFocus = null;
  selAlarmId = latestAlarmIdOf(sel.id);
  if (map) map.sel = sel.id;
  loadSelected();
  refresh();
}
function onTipAction(act, hit) {
  const t = hit && hit.data;
  if (!t) return;
  const live = liveTargets.find(x => x.id === t.id);
  if (live && (!sel || live.id !== sel.id)) selectTarget(live);
  if (act === 'alarm') {
    const a = alarmsOf(t.id).slice().sort((x, y) => y.ts - x.ts)[0];
    if (!a) return toast('该目标暂无关联告警记录', 'err');
    sessionStorage.setItem('alarm.sel', a.alarmId || a.id);
    location.hash = '#/alarms';
    return;
  }
  /* video / notify 两个按钮仍是禁用态，点不到，因此没有对应分支——
     没有能力就不要留一条会弹出假成功提示的处理路径。 */
  if (act === 'drive') { requestDispersal(t); return; }
  if (act === 'risk') { toast('正在跳转空间安全风险监测…'); setTimeout(() => location.hash = '#/risk', 600); }
}

/* 对目标发起驱离申请：主体是目标本身（契约 subject_kind=TARGET）。
   策略读不到只影响提示文字，不阻断申请；能不能真的执行由审批与设备通道决定。 */
async function requestDispersal(t) {
  let policy = null;
  try { policy = await disposalApi.policies(); } catch { policy = null; }
  openDisposalRequest({
    actionType: 'DISPERSAL',
    subjectKind: 'TARGET',
    subjectId: t.id,
    subjectText: t.no || t.id,
    policy
  });
}

/* ---- 融合卡：来源来自目标详情的 source_links，在线态来自 /fusion/status ---- */
function hasFuseData(t) {
  return !!(t && selDetail && Array.isArray(selDetail.source_links) && selDetail.source_links.length);
}

function paintFuse() {
  const has = hasFuseData(sel);
  fuseVisible.value = has;
  if (!has) { fuseOpen.value = false; return; }
  const t = sel;
  const conf = t.fusedConf;
  const chips = selDetail.source_links.map(link => {
    const online = sourceOnline[link.source_id] !== false;
    const name = labelOf(SOURCE_TYPE_LABEL, link.source_type, link.source_name || '未知来源');
    const demo = link.schema_status === 'DEMO'
      ? `<em class="mono" title="${esc(labelOf(SCHEMA_STATUS_LABEL, link.schema_status))}">待联调</em>` : '';
    const col = online ? '#3d8bff' : '#5a6c88';
    /* 置信度条用的是**目标级** fusion_confidence——读接口没有按来源分路的置信度，
       所以 title 里说清它是整条融合链路的置信度，不让人误以为这是这一路自己的数。无值就整条不渲染。 */
    const bar = conf == null ? ''
      : `<span class="bar" title="目标融合置信度（非单一来源）"><i style="width:${conf}%;background:${col}"></i></span>`;
    return `<div class="sit-fuse-ch${online ? '' : ' off'}">
      <span class="dot-s" style="background:${col}"></span>
      <b>${esc(name)}</b>${demo}${bar}
    </div>`;
  }).join('');
  const col = conf != null && conf >= 80 ? '#79e5a5' : '#ffd07a';
  const meta = document.getElementById('stFuseMeta');
  if (meta) meta.innerHTML = conf == null ? '置信度未提供' : `置信度 <b class="mono" style="color:${col}">${conf}%</b>`;
  const orbPct = document.getElementById('stFuseOrbPct');
  if (orbPct) {
    orbPct.textContent = conf == null ? '—' : conf + '%';
    orbPct.style.color = col;
  }
  const level = selDetail.degradation && selDetail.degradation.determined ? selDetail.degradation.level : null;
  document.getElementById('stFuse').innerHTML = `
    <div class="sit-fuse">
      <div class="sit-fuse-copy">
        <div><b>${esc(t.typeLabel || t.type)}</b> ${U.legal(t.legal)}</div>
        ${level ? `<div><b style="color:#79e6f6">融合降级：${esc(level)}</b></div>` : ''}
      </div>
      <div class="sit-fuse-chs">${chips}</div>
    </div>`;
}

/* ---- 告警列表 ---- */
function paintAlarms() {
  const box = document.getElementById('stAlarms');
  if (!box) return;
  if (loadError) {
    box.innerHTML = `<div class="warnbox">${esc(loadError)}</div>`;
    return;
  }
  const list = shownAlarms();
  if (!list.length) {
    box.innerHTML = '<div class="empty">当前无告警<br>点选地图目标或等待新告警</div>';
    return;
  }
  box.innerHTML = list.slice(0, 12).map(a => {
    const live = liveTargets.some(t => t.id === a.targetId);
    return `
    <div class="a lv-${a.level}${live ? '' : ' hist'}" data-alm="${esc(a.targetId)}" data-alm-id="${esc(a.id)}"
      title="${live ? '点击：在地图上跟踪该目标' : '该目标已离开实时跟踪窗口'}"
      ${a.id === selAlarmId
      ? 'style="border:1px solid var(--cyan);background:rgba(34,211,238,.08)"' : ''}>
      <div class="r1"><span class="id">${esc(a.targetId)}</span>
        ${U.tag(a.level === '高' ? '高风险' : a.level === '中' ? '中风险' : '低风险')}
        <span style="margin-left:auto" class="mono">${a.ts ? new Date(a.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span></div>
      <div class="r2"><span>${esc(a.district)}</span>
        <span>${live ? '' : '<span class="hist-tag" title="目标已离开实时跟踪窗口">非实时</span>'}</span></div>
    </div>`; }).join('');
}

function alarmsOf(id) { return liveAlarms.filter(a => a.targetId === id); }

function applyFilter() {
  const ts = shownTargets();
  if (map) map.setData({
    airspaces: liveAirspaces,
    devices: liveDevices,
    targets: ts, alarms: []
  });
  if (ts.length && (!sel || !ts.some(t => t.id === sel.id))) {
    sel = ts[0];
    if (map) map.sel = sel.id;
    loadSelected();
  }
  paintAlarms();
}

function refresh() {
  paintFuse(); paintAlarms();
}

/* ---- 取数 ---- */
let loadError = '';

function messageOf(reason) {
  if (reason && reason.status === 403) return '当前账号没有查看融合感知数据的权限。';
  return (reason && reason.message) || '读取失败，请稍后重试。';
}

/* 研判分页上限是 100（size=200 会被服务端判为分页参数无效），因此按页取到 total 为止。
   取不到就整体退化为"待确认"，不是"合法"——宁可全场标待确认，也不能凭空给出一个合法结论。 */
const EVALUATION_PAGE_SIZE = 100, EVALUATION_MAX_PAGES = 10;
async function loadEvaluations() {
  const items = [];
  for (let page = 1; page <= EVALUATION_MAX_PAGES; page++) {
    const result = await legalityApi.listEvaluations({
      latest_only: true, mode: 'ACTIVE', size: EVALUATION_PAGE_SIZE, page
    });
    items.push(...(result.items || []));
    if (items.length >= (result.total || 0) || !(result.items || []).length) break;
  }
  return { items };
}

async function loadTargetsAndAlarms() {
  try {
    const [targetPage, evaluationPage, alarmPage] = await Promise.all([
      targetApi.listAll({ size: 100 }),
      loadEvaluations().catch(() => ({ items: [] })),
      listAlarms({ size: 100 }).catch(() => ({ items: [] }))
    ]);
    liveTargets = toTargets(targetPage.items || [], legalByTarget(evaluationPage.items || []));
    liveAlarms = toAlarms(alarmPage.items || []);
    loadError = '';
  } catch (reason) {
    // 后端不可达时如实报错，绝不回退演示数据。
    loadError = messageOf(reason);
    liveTargets = []; liveAlarms = [];
  }
  applyFilter();
  refresh();
}

async function loadAirspacesAndDevices() {
  try {
    const page = await airspaceApi.list({ size: 100, valid_at: Date.now() });
    const details = await Promise.all((page.items || []).map(item =>
      airspaceApi.detail(item.airspace_id).catch(() => null)));
    liveAirspaces = toAirspaces(details.filter(Boolean));
  } catch { liveAirspaces = []; }
  try {
    const page = await deviceApi.list({ size: 200 });
    liveDevices = toDevices(page.items || []);
  } catch { liveDevices = []; }
  applyFilter();
}

async function loadFusionStatus() {
  try {
    const status = await targetApi.fusionStatus();
    const map2 = {};
    for (const source of (status && status.sources) || []) map2[source.source_id] = source.online !== false;
    sourceOnline = map2;
  } catch { sourceOnline = {}; }
}

async function loadSelected() {
  if (!sel) { selDetail = null; return; }
  const targetId = sel.targetId;
  /* 详情与轨迹分开取：轨迹读不到（无权限、无轨迹）不该把已经拿到的融合详情一起丢掉，
     否则融合面板会因为一次无关的失败而整块消失。 */
  try {
    const detail = await targetApi.detail(targetId);
    if (!sel || sel.targetId !== targetId) return;
    selDetail = detail;
    sel.fusedConf = percent(detail.latest_state && detail.latest_state.fusion_confidence);
  } catch { selDetail = null; }
  try {
    const tracks = await targetApi.tracksAll(targetId, { size: 20 });
    const open = (tracks.items || [])[0];
    if (open) {
      const points = await targetApi.pointsAll(open.track_id, { size: 200 });
      if (sel && sel.targetId === targetId) sel.track = toTrack(points.items || []);
    }
  } catch { /* 没有轨迹就不画轨迹线，其余照常显示 */ }
  if (map) map.setData({ airspaces: liveAirspaces, devices: liveDevices, targets: shownTargets(), alarms: [] });
  refresh();
}

onUnmounted(() => {
  timers.forEach(clearInterval);
  timers = [];
  if (map) map.destroy();
  map = null;
});

onMounted(async () => {
  const view = root.value;
  map = new window.MapView(document.getElementById('stMap'), {
    maxDev: 46, maxAlarm: 0, zoom: 1.06, legend: false, layers: { alarm: false },
    interactiveTip: true, renderTip: renderMapTip, onTipAction,
    onPick: p => {
      if (p.kind === 'target') {
        const t = liveTargets.find(x => x.id === p.data.id);
        if (t) selectTarget(t);
      }
    }
  });

  /* 图层控制浮层：字典改为本页本地常量（决策 11-6），与 map.js 的图层键一致。 */
  const lyBox = document.createElement('div');
  lyBox.className = 'maplayers';
  const layerLabel = k => [...new Set(AIRSPACE_LAYERS.filter(a => a.layer === k).map(a => a.legend))].join(' / ');
  const layerColor = k => (AIRSPACE_LAYERS.find(a => a.layer === k) || {}).color;
  const LY = [
    ['device', '设备点位', '<span class="sw dot" style="background:#22d3ee"></span>'],
    ['track', '无人机轨迹', '<span class="sw ln" style="border-color:#2fd06e"></span>']
  ].concat([...new Set(AIRSPACE_LAYERS.map(a => a.layer))].map(k =>
    [k, layerLabel(k), `<span class="sw ln" style="border-color:${layerColor(k)}"></span>`]));
  lyBox.classList.add('collapsed');
  lyBox.innerHTML = `<div class="lyt" role="button" tabindex="0" aria-label="展开或收起图层与图例">图层与图例 <span class="lg-arrow">▸</span></div>` +
    LY.map(([k, n, sw]) => `<label><input type="checkbox" data-layer="${k}" checked>${sw}${n}</label>`).join('');
  document.getElementById('stMap').appendChild(lyBox);
  lyBox.querySelector('.lyt').addEventListener('click', () => {
    const c = lyBox.classList.toggle('collapsed');
    lyBox.querySelector('.lg-arrow').textContent = c ? '▸' : '▾';
  });
  U.on(view, '[data-layer]', 'change', (e, el) => map.setLayer(el.dataset.layer, el.checked));
  U.on(view, '[data-alm]', 'click', (e, el) => {
    selAlarmId = el.dataset.almId;
    const t = liveTargets.find(x => x.id === el.dataset.alm);
    if (!t) return toast('该告警未关联到当前实时目标', 'err');
    almFocus = null;
    selectTarget(t);
    if (map && map.w && t.posValid) map.centerAt(t.lon, t.lat);
  });

  await loadFusionStatus();
  await loadAirspacesAndDevices();
  await loadTargetsAndAlarms();

  const ctx = U.consume('situation');
  if (ctx && ctx.target) {
    const t = liveTargets.find(x => x.id === ctx.target || x.targetId === ctx.target);
    if (t) { selectTarget(t); if (map && map.w && t.posValid) map.centerAt(t.lon, t.lat); }
    else toast('该目标已脱离实时跟踪窗口，已显示当前追踪目标');
  }

  timers.push(setInterval(loadTargetsAndAlarms, FAST_POLL_MS));
  timers.push(setInterval(() => { loadAirspacesAndDevices(); loadFusionStatus(); }, SLOW_POLL_MS));
});
</script>

<template>
  <div class="view situation-page" id="view" ref="root">
    <div class="sit-stage">
      <div id="stMap" class="sit-map"></div>
      <aside class="sit-hud sit-hud-alarms" aria-label="实时告警列表">
        <header class="sit-hud-hd">
          <h3>实时告警</h3>
          <a class="lnk" href="#/alarms">查看更多 ›</a>
        </header>
        <div class="sit-hud-bd alarm" id="stAlarms"></div>
      </aside>
      <aside v-show="fuseVisible" class="sit-fuse-dock" :class="{ 'is-open': fuseOpen }" aria-label="多源融合结果">
        <button type="button" class="sit-fuse-orb" :aria-expanded="fuseOpen"
          :aria-label="fuseOpen ? '收起多源融合' : '展开多源融合'" @click="toggleFuse">
          <span class="sit-fuse-orb-cap">
            <small>多源融合</small>
            <b>置信度 <span id="stFuseOrbPct" class="mono">—</span></b>
          </span>
          <span class="sit-fuse-orb-ball" aria-hidden="true">
            <span class="sit-fuse-orb-icon" v-html="fuseIcon"></span>
          </span>
          <span class="sit-fuse-orb-hint">{{ fuseOpen ? '点击收起' : '点击展开' }}</span>
        </button>
        <div class="sit-fuse-panel" role="region">
          <header class="sit-hud-hd">
            <h3>多源融合</h3>
            <span class="sit-hud-sub" id="stFuseMeta"></span>
          </header>
          <div class="sit-hud-bd" id="stFuse"></div>
        </div>
      </aside>
    </div>
  </div>
</template>
