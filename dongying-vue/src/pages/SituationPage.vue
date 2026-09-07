<script>
/* 模块级状态：筛选条件默认全量（顶部筛选条已按产品要求移除）；sel 每次进入重置为首个实时目标
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
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { toast } from '@/ui/nv.js';

const M = window.MOCK, U = window.UI, CH = window.CH;
usePageChrome('situation');
const root = ref(null);

let map = null, sel = null;
let almFocus = null;
let selAlarmId = null;
const flt = S.flt;
const fuseOpen = ref(false);
const fuseVisible = ref(false);
const fuseIcon = U.icon('radar');

function toggleFuse() {
  if (!fuseVisible.value) return;
  fuseOpen.value = !fuseOpen.value;
}

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

/* ---- 首屏骨架 ---- */
sel = M.liveTargets[0];

/* ---- 地图悬浮卡：承接原「当前追踪目标」的研判信息与处置按钮 ---- */
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
function tipActions(t) {
  const isUav = t.type === '无人机';
  const alms = alarmsOf(t.id);
  const latest = alms.length
    ? alms.slice().sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))[0] : null;
  const id = t.id;
  const almBtn = latest
    ? `<button type="button" class="btn warn" data-tip-act="alarm" data-tip-id="${id}"
         title="转到「告警事件」并定位到 ${latest.id}">⚠ 查看告警 →</button>`
    : '';
  if (isUav) {
    return `<div class="maptip-track-acts">
      <button type="button" class="btn" data-tip-act="video" data-tip-id="${id}">${U.icon('video')} 实时视频</button>
      ${almBtn}
    </div>`;
  }
  return `<div class="maptip-track-note">非无人机不进入反制流程，仅评估与通知/驱离</div>
    <div class="maptip-track-acts is-grid">
      <button type="button" class="btn" data-tip-act="video" data-tip-id="${id}">${U.icon('video')} 实时视频</button>
      <button type="button" class="btn" data-tip-act="notify" data-tip-id="${id}">通知机场/周边</button>
      <button type="button" class="btn" data-tip-act="drive" data-tip-id="${id}">派发驱离</button>
      <button type="button" class="btn" data-tip-act="risk" data-tip-id="${id}">转风险监测 →</button>
    </div>`;
}
function renderTargetTip(t) {
  const lon = Number.isFinite(t.lon) ? t.lon.toFixed(3) : '—';
  const lat = Number.isFinite(t.lat) ? t.lat.toFixed(3) : '—';
  const tags = `${t.legal}${t.violation ? ' · ' + t.violation : ''} · ${t.risk}`;
  return `<div class="maptip-track">
    <header class="maptip-track-hd">
      <div class="maptip-track-id">
        <b style="color:${legalColor(t)}">${t.id}</b>
        <span class="maptip-track-type">${t.subtype || t.type}</span>
      </div>
      ${statusTag(t)}
    </header>
    <div class="maptip-track-tags">${tags}</div>
    <div class="maptip-track-metrics">
      <div class="maptip-metric">
        <span class="maptip-metric-ic">${U.icon('trend')}</span>
        <span><small>飞行速度</small><b>${t.speed == null ? '—' : t.speed}<em>m/s</em></b></span>
      </div>
      <div class="maptip-metric">
        <span class="maptip-metric-ic">${U.icon('chart')}</span>
        <span><small>当前高度</small><b>${t.alt == null ? '—' : t.alt}<em>m</em></b></span>
      </div>
    </div>
    <div class="maptip-track-geo"><span>经纬度</span><span class="mono">${lon}°E, ${lat}°N</span></div>
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
  refresh();
}
function onTipAction(act, hit) {
  const t = hit && hit.data;
  if (!t) return;
  const live = M.liveTargets.find(x => x.id === t.id);
  if (live && live.id !== sel.id) selectTarget(live);
  if (act === 'video') {
    if (!window.TARGET_MEDIA) return toast('媒体查看组件尚未加载', 'err');
    window.TARGET_MEDIA.openVideo(live || t);
    return;
  }
  if (act === 'alarm') {
    const a = alarmsOf(t.id).slice().sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))[0];
    if (!a) return toast('该目标暂无关联告警记录', 'err');
    sessionStorage.setItem('alarm.sel', a.id);
    location.hash = '#/alarms';
    return;
  }
  if (act === 'notify') toast('已通知东营胜利机场塔台与属地派出所（回执 2/2）', 'ok');
  else if (act === 'drive') toast('已派发驱离作业任务至属地保障单位', 'ok');
  else if (act === 'risk') { toast('正在跳转空间安全风险监测…'); setTimeout(() => location.hash = '#/risk', 600); }
}

/* ---- 融合卡（按接入路分组，与 legacy 同构） ---- */
const CH_OF = {
  '雷达': ['第1路 · 融合感知箱', '#3d8bff'], '光电': ['第1路 · 融合感知箱', '#ffb020'],
  'TDOA/AOA': ['第3路 · TDOA', '#a97bff'], '5G-A基站': ['第2路 · 5G-A', '#22d3ee']
};
const SHORT = { '雷达': '雷达', '光电': '光电', 'TDOA/AOA': 'TDOA', '5G-A基站': '5G-A' };

function hasFuseData(t) {
  const f = t && t.fused;
  if (!f) return false;
  return Object.keys(f).some(k => f[k] && f[k].on);
}

function paintFuse() {
  const has = hasFuseData(sel);
  fuseVisible.value = has;
  if (!has) { fuseOpen.value = false; return; }
  const t = sel, f = t.fused;
  const advice = t.type === '无人机'
    ? (t.legal === '非法' ? '核实后申请反制授权' : '持续跟踪')
    : M.riskAdvice(M.riskLevelOf(t));
  const chips = ['雷达', '光电', '5G-A基站', 'TDOA/AOA'].filter(k => f[k]).map(k => {
    const s2 = f[k], c = (CH_OF[k] || [null, '#8ca0be'])[1];
    return `<div class="sit-fuse-ch${s2.on ? '' : ' off'}">
      <span class="dot-s" style="background:${s2.on ? c : '#5a6c88'}"></span>
      <b>${SHORT[k] || k}</b>
      <em class="mono" style="color:${s2.on ? c : 'var(--txt-3)'}"><small>置信度</small>${s2.on ? s2.置信度 + '%' : '—'}</em>
      <span class="bar"><i style="width:${s2.on ? s2.置信度 : 0}%;background:${c}"></i></span>
    </div>`;
  }).join('');
  const col = t.fusedConf >= 80 ? '#79e5a5' : '#ffd07a';
  const meta = document.getElementById('stFuseMeta');
  if (meta) meta.innerHTML = `置信度 <b class="mono" style="color:${col}">${t.fusedConf}%</b>`;
  const orbPct = document.getElementById('stFuseOrbPct');
  if (orbPct) {
    orbPct.textContent = t.fusedConf + '%';
    orbPct.style.color = col;
  }
  document.getElementById('stFuse').innerHTML = `
    <div class="sit-fuse">
      <div class="sit-fuse-copy">
        <div><b>${t.subtype || t.type}</b> ${U.legal(t.legal)} ${U.risk(t.risk)}</div>
        <div><b style="color:#79e6f6">${t.violation ? t.violation + ' · ' : ''}${advice}</b></div>
      </div>
      <div class="sit-fuse-chs">${chips}</div>
    </div>`;
}

/* ---- 告警列表 ---- */
function paintAlarms() {
  const list = shownAlarms();
  if (!list.length) {
    document.getElementById('stAlarms').innerHTML =
      '<div class="empty">当前无告警<br>点选地图目标或等待新告警</div>';
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

function alarmsOf(id) { return (M.alarms || []).filter(a => a.targetId === id); }

function applyFilter() {
  const ts = shownTargets();
  let mapTargets = ts;
  if (almFocus && !ts.some(t => t.id === almFocus)) {
    const ht = (M.todayTargets || []).find(x => x.id === almFocus)
      || (M.allTargets || []).find(x => x.id === almFocus);
    if (ht) mapTargets = ts.concat([ht]);
  }
  if (map) map.setData({
    airspaces: M.airspaces,
    devices: M.devices.filter((d, i) => i % 4 === 0),
    targets: mapTargets, alarms: []
  });
  if (ts.length && !ts.some(t => t.id === sel.id)) { sel = ts[0]; if (map) map.sel = sel.id; }
  paintAlarms();
}

function refresh() {
  paintFuse(); paintAlarms();
}

onUnmounted(() => { if (map) map.destroy(); map = null; });

onMounted(() => {
  const view = root.value;
  map = new window.MapView(document.getElementById('stMap'), {
    maxDev: 46, maxAlarm: 0, zoom: 1.06, legend: false, layers: { alarm: false },
    interactiveTip: true, renderTip: renderMapTip, onTipAction,
    onPick: p => {
      if (p.kind === 'target') {
        const t = M.liveTargets.find(x => x.id === p.data.id) || p.data;
        if (t && t.id) {
          sel = M.liveTargets.find(x => x.id === t.id) || sel;
          map.sel = t.id;
          almFocus = M.liveTargets.some(x => x.id === t.id) ? null : t.id;
          selAlarmId = latestAlarmIdOf(t.id);
          refresh();
        }
      }
    }
  });
  const ctx = U.consume('situation');
  if (ctx && ctx.target) {
    const t = M.liveTargets.find(x => x.id === ctx.target);
    if (t) sel = t;
    else toast('该目标已脱离实时跟踪窗口，已显示当前追踪目标');
  }
  applyFilter();
  map.sel = sel.id;
  selAlarmId = latestAlarmIdOf(sel.id);
  if (ctx && ctx.target && map.w) {
    map.centerAt(sel.lon, sel.lat);
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
    LY.map(([k, n, sw]) => `<label><input type="checkbox" data-layer="${k}" checked>${sw}${n}</label>`).join('');
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
      if (map.w) map.centerAt(t.lon, t.lat);
      refresh();
    }
    else {
      const ht = (M.todayTargets || []).find(x => x.id === el.dataset.alm)
        || (M.allTargets || []).find(x => x.id === el.dataset.alm);
      if (!ht) return toast('该告警未关联到可定位的目标记录', 'err');
      almFocus = ht.id;
      applyFilter();
      map.sel = ht.id;
      if (map.w && ht.lon != null) {
        map.centerAt(ht.lon, ht.lat);
      }
      refresh();
    }
  });
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
