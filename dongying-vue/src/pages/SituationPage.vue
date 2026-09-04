<script>
/* 模块级状态：筛选条跨导航保持（legacy 约定）；sel 每次进入重置为首个实时目标
   （legacy render() 行为）。 */
const S = {
  flt: { region: '东营市全域', ttype: '全部', risk: '全部', src: '全部' }
};
export default {};
</script>

<script setup>
/* 融合感知中心（实时态势）—— 保留 legacy 地图与页面生命周期，
   目标摘要、详情、轨迹和轨迹点改由标准 API 驱动。 */
import { ref, onMounted, onUnmounted } from 'vue';
import { NDrawer, NDrawerContent } from 'naive-ui';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPanel from '@/components/UPanel.vue';
import { targetApi } from '@/services/targetApi.js';

const U = window.UI;
usePageChrome('situation');
const root = ref(null);

let map = null, sel = null;
let liveTargets = [];
let pageLoading = false;
let pageError = '';
let pageForbidden = false;
let alive = false;
/* P3：技术详情抽屉换 n-drawer（受控）；内容仍是既有卡片字符串（B 类展示串保留） */
const showDrawer = ref(false);
const drawerTitle = ref('');
const drawerHtml = ref('');
const flt = S.flt;
Object.assign(flt, { region: '东营市全域', risk: '全部', src: '全部' });
if (!['全部', '无人机', '非无人机', '未分类'].includes(flt.ttype)) flt.ttype = '全部';

const esc = value => String(value ?? '—').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
function fmtTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
const asPercent = value => value == null
  ? null
  : Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
const asNumber = value => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
function trustedLocation(location) {
  const lon = Number(location?.longitude), lat = Number(location?.latitude);
  return location?.coordinate_system === 'WGS84' && Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}
function targetFields(item) {
  const state = item.latest_state || null;
  const located = trustedLocation(state?.location);
  const code = item.object_type_code || '';
  const type = code === 'UAV' ? '无人机' : code ? '非无人机' : '未分类';
  return {
    id: item.target_id, targetNo: item.target_no, objectTypeCode: code,
    type, subtype: item.subtype || (code || '未分类目标'), uavSn: item.uav_sn || '',
    sourceMode: item.source_mode, ownerOrgId: item.owner_org_id, districtId: item.district_id,
    district: item.district_id, firstSeenAt: item.first_seen_at, lastSeenAt: item.last_seen_at,
    latestState: state, posValid: located,
    lon: located ? Number(state.location.longitude) : null,
    lat: located ? Number(state.location.latitude) : null,
    altitudeAmsl: asNumber(state?.altitude_amsl_m),
    heightAgl: asNumber(state?.height_agl_m),
    alt: asNumber(state?.altitude_amsl_m),
    speed: asNumber(state?.speed_mps), heading: asNumber(state?.heading_deg),
    fusedConf: asPercent(state?.fusion_confidence),
    classificationConf: asPercent(state?.classification_confidence),
    legal: code && code !== 'UAV' ? '不适用' : '待确认',
    violation: code && code !== 'UAV' ? '' : '合法性尚未接入', risk: '尚未接入',
    source: item.source_mode ? item.source_mode.toUpperCase() : '—'
  };
}
function pointFields(point) {
  if (!trustedLocation(point.location)) return null;
  return {
    lon: Number(point.location.longitude), lat: Number(point.location.latitude),
    altitudeAmsl: asNumber(point.altitude_amsl_m),
    heightAgl: asNumber(point.height_agl_m),
    alt: asNumber(point.altitude_amsl_m),
    ts: point.sort_time, observedAt: point.observed_at, receivedAt: point.received_at, kind: 'meas'
  };
}

function matchFilter(t) {
  if (flt.ttype !== '全部' && t.type !== flt.ttype) return false;
  return true;
}
const shownTargets = () => liveTargets.filter(matchFilter);

/* ---- 首屏骨架（与 legacy render() 同构） ---- */
const toolbarHtml = `${U.field('区域', '<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px">按服务端数据权限范围</span>')}
    ${U.field('时间范围', '<span class="mono" style="font-size:12px;color:var(--txt-2);padding:0 4px">服务端目标列表</span>')}
    ${U.field('目标类型', U.select('ttype', ['全部', '无人机', '非无人机', '未分类'], flt.ttype))}
    ${U.field('风险等级', '<span class="tag t-gray">尚未接入</span>')}
    ${U.field('来源筛选', '<span class="tag t-gray">尚未接入</span>')}
    <span style="flex:1"></span>
    <span id="stFltInfo" style="font-size:11.5px"></span>
    <span style="font-size:11.5px;color:var(--txt-3);margin-left:10px">图层控制见地图右上角</span>`;
const techExtra = `<button class="btn ghost" id="btnTech">${U.icon('settings')} 技术详情</button>`;

/* ---- 当前追踪目标 ---- */
function paintTarget() {
  const t = sel;
  const box = document.getElementById('stTarget');
  if (!box) return;
  if (!t) {
    const message = pageLoading ? '目标数据加载中…'
      : pageForbidden ? '无权限访问目标数据（403）'
        : pageError ? '目标数据加载失败，请在顶部重试' : '当前没有可见目标';
    box.innerHTML = `<div class="empty">${esc(message)}</div>`;
    return;
  }
  const locationText = t.posValid
    ? `${t.lon.toFixed(5)}°E, ${t.lat.toFixed(5)}°N · WGS84`
    : '无可信 WGS84 最新位置（最新位置不绘点；如有历史轨迹，可按需查看）';
  const sourceText = t.detail?.source_links?.length
    ? t.detail.source_links.map(link => esc(link.source_code)).join('、')
    : esc(t.source);
  const legalText = t.type === '非无人机' ? '不适用（非无人机）' : '尚未接入';
  const detailState = t.detailLoading ? '<div class="info-line">详情与轨迹加载中…</div>'
    : t.detailError
      ? `<div class="warnbox" style="margin-top:8px">${esc(t.detailError)}${t.detailRetryable
        ? ' <button class="btn ghost" id="stDetailRetry">重试</button>' : ''}</div>`
      : '';
  box.innerHTML = `
    <div class="target-summary-head">
      <span class="target-summary-icon">${U.icon('plane')}</span>
      <span><small>服务端目标详情</small><b class="mono">${esc(t.id)}</b></span>
      <span class="target-summary-tags"><span class="tag t-gray">合法性：${legalText}</span><span class="tag t-gray">风险：尚未接入</span></span>
    </div>
    ${U.metricStrip([
      { label: '目标类型', value: esc(t.subtype || t.type), icon: 'plane' },
      { label: '速度', value: t.speed ?? '—', unit: t.speed == null ? '' : 'm/s', icon: 'trend' },
      { label: '海拔高度', value: t.altitudeAmsl ?? '—', unit: t.altitudeAmsl == null ? '' : 'm AMSL', icon: 'chart' },
      { label: '距地高度', value: t.heightAgl ?? '—', unit: t.heightAgl == null ? '' : 'm AGL', icon: 'chart' },
      { label: '来源链路', value: t.detail?.source_links?.length ?? '—', unit: t.detail?.source_links?.length == null ? '' : '路', tone: 'info', icon: 'radar' }
    ], { compact: true })}
    <div style="margin-top:5px;font-size:12.5px;display:flex;flex-direction:column;gap:4px">
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">经纬度</span>
        <span class="mono">${locationText}</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">数据来源</span>
        <span>${sourceText} · ${esc(t.sourceMode || '—')}</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">最新观测</span>
        <span>${esc(fmtTime(t.latestState?.observed_at ?? t.lastSeenAt))}</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">合法性</span>
        <span style="min-width:0">${legalText}</span></div>
      <div style="display:flex;gap:6px"><span style="color:var(--txt-3);flex:none">风险</span>
        <span style="min-width:0">尚未接入</span></div>
    </div>
    ${detailState}
    <div id="stAct" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-2)"></div>`;
  const retry = document.getElementById('stDetailRetry');
  if (retry) retry.onclick = () => loadTargetData(t, true);
}

/* ---- 服务端目标状态与来源映射 ---- */
function paintFuse() {
  const box = document.getElementById('stFuse');
  if (!box) return;
  const t = sel;
  if (!t) {
    box.innerHTML = `<div class="empty">${pageLoading ? '目标数据加载中…' : '暂无可展示的目标状态'}</div>`;
    return;
  }
  const links = t.detail?.source_links || [];
  const bars = links.length ? links.map(link => `<div class="s">
      <div class="sh"><b>${esc(link.source_code)}</b><span class="st">${esc(link.source_mode)}</span></div>
      <div class="sv"><span>来源目标</span><b class="mono">${esc(link.external_target_id)}</b></div>
    </div>`).join('') : '<div class="empty">来源明细加载后显示；融合解释尚未接入</div>';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:22px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:12.5px;color:var(--txt-3)">融合置信度</div>
        <div style="font-size:32px;font-weight:700;line-height:1.15;font-family:'DIN Alternate',Menlo,sans-serif;
          color:${t.fusedConf == null ? '#8ca0be' : t.fusedConf >= 80 ? '#79e5a5' : '#ffd07a'}">${t.fusedConf ?? '—'}<span style="font-size:17px">${t.fusedConf == null ? '' : '%'}</span></div></div>
      <div style="font-size:13.5px;line-height:1.9;color:var(--txt-2)">
        <div>目标分类　<b style="color:var(--txt)">${esc(t.subtype || t.type)}</b>　·　分类置信度 <b>${t.classificationConf ?? '—'}${t.classificationConf == null ? '' : '%'}</b></div>
        <div>来源链路　<b style="color:var(--txt)">${links.length || '—'}</b> 路　·　融合解释、建议动作：<b style="color:var(--txt-3)">尚未接入</b></div>
      </div>
    </div>
    <div class="srcbar">${bars}</div>`;
}

/* ---- 技术详情抽屉 ---- */
function closeDrawer() { showDrawer.value = false; }
function techDrawer() {
  if (!sel) return;
  const links = sel.detail?.source_links || [];
  const cards = links.map(link => `<div class="fc" style="border:1px solid var(--line);border-radius:6px;background:var(--panel-2);padding:10px 12px;margin-bottom:10px">
      <h5 style="font-size:13.5px;color:#9ec6ff;margin-bottom:6px">${esc(link.source_code)}</h5>
      ${U.kv([
    ['来源模式', esc(link.source_mode)], ['来源会话', esc(link.source_session_key)],
    ['外部目标', esc(link.external_target_id)], ['协议版本', esc(link.protocol_version || '—')],
    ['设备 ID', esc(link.device_id || '—')]
  ])}</div>`).join('');
  drawerTitle.value = sel.id;
  drawerHtml.value = `<div style="font-size:13px;color:var(--txt-3);margin-bottom:8px">服务端来源映射（融合解释尚未接入）</div>${cards || '<div class="empty">暂无来源映射或详情尚未加载</div>'}`;
  showDrawer.value = true;
}

function currentTrack(target = sel) {
  return target?.tracks?.[target.currentTrackIndex || 0] || null;
}

function trackDrawer() {
  const target = sel;
  const track = currentTrack(target);
  if (!target || !track) return;
  target.showTrack = true;
  applyFilter();
  const points = target.rawTrackPoints || [];
  const shown = points.slice(0, 200);
  const rows = shown.map(point => {
    const location = trustedLocation(point.location)
      ? `${Number(point.location.longitude).toFixed(6)}, ${Number(point.location.latitude).toFixed(6)} · WGS84`
      : '无可信 WGS84 坐标';
    const amsl = point.altitude_amsl_m == null ? '—' : `${esc(point.altitude_amsl_m)} m AMSL`;
    const agl = point.height_agl_m == null ? '—' : `${esc(point.height_agl_m)} m AGL`;
    return `<tr><td>${esc(point.point_seq)}</td><td>${esc(fmtTime(point.sort_time))}</td><td class="mono">${location}</td><td>${amsl}</td><td>${agl}</td></tr>`;
  }).join('');
  drawerTitle.value = `真实轨迹 · ${target.id}`;
  drawerHtml.value = `<div class="warnbox" style="margin-bottom:10px">当前轨迹 ${target.currentTrackIndex + 1}/${target.tracks.length}；
      轨迹点来自后端接口。历史轨迹末点仅用于绘制轨迹，不作为目标最新位置。</div>
    ${U.kv([
    ['轨迹 ID', esc(track.track_id)], ['开始时间', esc(fmtTime(track.started_at))],
    ['来源', esc(track.source_code || track.source_mode || '—')],
    ['后端点数', String(target.pointTotal ?? points.length)], ['可信 WGS84 点', String(target.track?.length || 0)]
  ])}
    <div style="font-size:12px;color:var(--txt-3);margin:10px 0 6px">${points.length > shown.length ? `已加载全部 ${points.length} 点，表格显示前 ${shown.length} 点；地图使用全部可信点。` : `已加载全部 ${points.length} 点。`}</div>
    ${rows ? `<div style="overflow:auto;max-height:360px"><table class="tbl"><thead><tr><th>序号</th><th>时间</th><th>坐标</th><th>海拔高度</th><th>距地高度</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">该轨迹没有轨迹点</div>'}`;
  showDrawer.value = true;
  const last = target.track?.[target.track.length - 1];
  if (last && map?.w) map.centerAt(last.lon, last.lat);
}

function cycleTrack() {
  if (!sel?.tracks?.length) return;
  const next = ((sel.currentTrackIndex || 0) + 1) % sel.tracks.length;
  loadTrackPoints(sel, next, true);
}

/* ---- 目标列表 ---- */
function paintAlarms() {
  const list = shownTargets();
  const box = document.getElementById('stAlarms');
  if (!box) return;
  if (!list.length) {
    const message = pageLoading ? '目标数据加载中…'
      : pageForbidden ? '无权限访问目标数据（403）'
        : pageError ? '目标数据加载失败，请在顶部重试' : '当前筛选条件下无目标';
    box.innerHTML = `<div class="empty">${esc(message)}</div>`;
    return;
  }
  box.innerHTML = list.map(t => `
    <div class="a" data-target="${esc(t.id)}"
      title="点击查看目标详情${t.posValid ? '并在地图定位' : '；该目标无可信坐标，不在地图绘点'}"
      ${t.id === sel?.id
      ? 'style="border:1px solid var(--cyan);background:rgba(34,211,238,.08)"' : ''}>
      <div class="r1"><span class="id">${esc(t.id)}</span>${U.tag(t.type)}
        <span class="tag t-gray">${t.posValid ? 'WGS84' : '无可信位置'}</span>
        <span style="margin-left:auto;color:var(--txt-3)" class="mono">${esc(fmtTime(t.lastSeenAt))}</span></div>
      <div class="r2"><span>${esc(t.targetNo)} · ${esc(t.districtId)}</span>
        <span>${esc(t.sourceMode || '—')}</span></div>
    </div>`).join('');
}

/* ---- 处置动作区 ---- */
function paintActions() {
  const box = document.getElementById('stAct');
  if (!box || !sel) return;
  const track = currentTrack(sel);
  const trackCount = sel.tracks?.length || 0;
  const pointCount = sel.pointTotal ?? sel.rawTrackPoints?.length ?? 0;
  const trackStatus = sel.trackLoading ? '轨迹点加载中…'
    : sel.trackLoadError ? esc(sel.trackLoadError)
      : trackCount ? `当前轨迹 ${sel.currentTrackIndex + 1}/${trackCount} · ${pointCount} 点` : '该目标无轨迹';
  const trackButton = sel.trackLoading
    ? '<button class="btn" style="flex:1;justify-content:center" disabled>轨迹点加载中…</button>'
    : track && sel.trackLoadError && !sel.trackLoadRetryable
      ? `<button class="btn" style="flex:1;justify-content:center" disabled>${sel.trackLoadError.includes('403') ? '无权限查看轨迹（403）' : '轨迹暂不可用'}</button>`
      : track
        ? `<button class="btn" id="btnTrack" style="flex:1;justify-content:center">${sel.trackLoadRetryable ? '重试真实轨迹' : `查看真实轨迹（${pointCount} 点）`}</button>`
      : '<button class="btn" style="flex:1;justify-content:center" disabled>无真实轨迹</button>';
  const cycleButton = trackCount > 1 && !sel.detailForbidden
    && (!sel.trackLoadError || sel.trackLoadRetryable)
    ? `<button class="btn ghost" id="btnTrackNext" style="flex:1;justify-content:center">下一条轨迹</button>` : '';
  box.innerHTML = `<div class="warnbox" style="margin:0 0 8px;padding:6px 9px;font-size:11px;line-height:1.5">
      ${trackStatus}。告警、合法性、风险、视频与处置能力尚未接入。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" style="flex:1;justify-content:center" disabled title="视频尚未接入">${U.icon('video')} 实时视频（尚未接入）</button>
      ${trackButton}${cycleButton}
      <button class="btn warn" style="flex:1;justify-content:center" disabled title="告警尚未接入">查看告警（尚未接入）</button>
      <button class="btn big" style="width:100%;justify-content:center" disabled title="处置尚未接入">${U.icon('bolt')} 处置（尚未接入）</button>
    </div>`;
  const trackEl = document.getElementById('btnTrack');
  if (trackEl) trackEl.onclick = () => {
    if (sel.trackLoadRetryable) loadTrackPoints(sel, sel.currentTrackIndex || 0, true);
    else trackDrawer();
  };
  const nextEl = document.getElementById('btnTrackNext');
  if (nextEl) nextEl.onclick = cycleTrack;
}

function paintTag() {
  const el = document.getElementById('stTag');
  if (!el) return;
  if (!sel) { el.innerHTML = ''; return; }
  const cls = sel.posValid ? 't-cyan' : 't-gray';
  const col = sel.posValid ? '#22d3ee' : '#8ca0be';
  el.innerHTML = `<span class="tag ${cls}"><span class="dot-s" style="background:${col}"></span>${sel.posValid ? '可信 WGS84' : '无可信位置'}</span>`;
}

function mapTarget(target) {
  if (target.posValid) return target;
  if (!target.showTrack || !target.track?.length) return null;
  const last = target.track[target.track.length - 1];
  return {
    ...target,
    id: `${target.id} · 历史轨迹`,
    originalTargetId: target.id,
    subtype: `${target.subtype || target.type}（历史轨迹）`,
    posValid: true,
    lon: last.lon,
    lat: last.lat,
    alt: last.altitudeAmsl,
    latestState: null
  };
}

function applyFilter() {
  const ts = shownTargets();
  const previous = sel;
  if (!sel || !ts.some(t => t.id === sel.id)) sel = ts[0] || null;
  const mappedTargets = ts.map(mapTarget).filter(Boolean);
  if (map) map.setData({
    airspaces: [], devices: [], targets: mappedTargets, alarms: []
  });
  if (map) map.sel = sel?.posValid ? sel.id
    : sel?.showTrack && sel.track?.length ? `${sel.id} · 历史轨迹` : null;
  paintAlarms();
  const badge = document.getElementById('stFltInfo');
  if (badge) {
    if (pageLoading) badge.innerHTML = '<span style="color:var(--txt-3)">目标数据加载中…</span>';
    else if (pageForbidden) badge.innerHTML = '<span class="tag t-red">403 无权限</span> <span style="color:var(--txt-2)">无法访问目标数据</span>';
    else if (pageError) badge.innerHTML = `<span class="tag t-red">加载失败</span> <span style="color:var(--txt-2)">${esc(pageError)}</span> <button class="btn ghost" id="stRetry" style="margin-left:6px">重试</button>`;
    else if (flt.ttype !== '全部') badge.innerHTML = `<span class="tag t-amber">已筛选</span> <span style="color:var(--txt-2)">目标 ${ts.length}/${liveTargets.length}</span>
         <span class="lnk" id="stFltReset" style="margin-left:6px">清除</span>`;
    else badge.innerHTML = `<span style="color:var(--txt-3)">目标 ${ts.length} · 告警尚未接入</span>`;
    const retry = document.getElementById('stRetry');
    if (retry) retry.onclick = () => loadTargets(sel?.id || '');
    const rs = document.getElementById('stFltReset');
    if (rs) rs.onclick = () => {
      flt.ttype = '全部';
      document.querySelectorAll('#view [data-f]').forEach(el => { if (flt[el.dataset.f] != null) el.value = flt[el.dataset.f]; });
      applyFilter(); refresh();
    };
  }
  if (sel && sel !== previous && !sel.detail && !sel.detailLoading) loadTargetData(sel);
}

function refresh() {
  paintTarget(); paintFuse(); paintAlarms(); paintTag(); paintActions();
  const tech = document.getElementById('btnTech');
  if (tech) tech.disabled = !sel;
}

async function loadTrackPoints(target, index = 0, openWhenLoaded = false) {
  const track = target?.tracks?.[index];
  if (!track || target.trackLoading) return;
  target.currentTrackIndex = index;
  target.trackId = track.track_id;
  target.trackLoading = true;
  target.trackLoadError = '';
  target.trackLoadRetryable = false;
  target.rawTrackPoints = [];
  target.track = [];
  target.pointTotal = 0;
  refresh();
  applyFilter();
  try {
    const pointPage = await targetApi.pointsAll(track.track_id, { size: 100 });
    if (!alive || !liveTargets.includes(target) || currentTrack(target)?.track_id !== track.track_id) return;
    target.rawTrackPoints = Array.isArray(pointPage?.items) ? pointPage.items : [];
    target.pointTotal = Number(pointPage?.total) || target.rawTrackPoints.length;
    target.track = target.rawTrackPoints.map(pointFields).filter(Boolean);
    target.loadedTrackId = track.track_id;
    if (openWhenLoaded) target.showTrack = true;
  } catch (error) {
    if (alive && liveTargets.includes(target)) {
      const forbidden = error?.status === 403 || error?.code === 'FORBIDDEN';
      target.trackLoadError = forbidden
        ? '无权限加载轨迹点（403）' : error?.message || '轨迹点加载失败';
      target.trackLoadRetryable = error?.code === 'NETWORK_ERROR'
        || (Number(error?.status) >= 500 && Number(error?.status) <= 599);
    }
  } finally {
    if (alive && liveTargets.includes(target) && currentTrack(target)?.track_id === track.track_id) {
      target.trackLoading = false;
      applyFilter();
      refresh();
      if (openWhenLoaded && !target.trackLoadError && sel === target) trackDrawer();
    }
  }
}

async function loadTargetData(target, force = false) {
  if (!target || target.detailLoading || (target.detail && !force)) return;
  target.detailLoading = true;
  target.detailError = '';
  target.detailRetryable = false;
  target.detailForbidden = false;
  refresh();
  try {
    const [detail, trackPage] = await Promise.all([
      targetApi.detail(target.id),
      targetApi.tracksAll(target.id, { size: 100 })
    ]);
    if (!alive || !liveTargets.includes(target)) return;
    Object.assign(target, targetFields(detail));
    target.detail = detail;
    target.detailRetryable = false;
    target.detailForbidden = false;
    target.tracks = Array.isArray(trackPage?.items) ? trackPage.items : [];
    target.source = detail.source_links?.length
      ? detail.source_links.map(link => link.source_code).join('、')
      : target.source;
    target.track = [];
    target.rawTrackPoints = [];
    target.pointTotal = 0;
    target.currentTrackIndex = 0;
    target.trackId = target.tracks[0]?.track_id || '';
    if (target.trackId) await loadTrackPoints(target, 0);
  } catch (error) {
    if (alive && liveTargets.includes(target)) {
      const forbidden = error?.status === 403 || error?.code === 'FORBIDDEN';
      target.detailError = forbidden
        ? '无权限加载该目标详情或轨迹（403）'
        : error?.message || '目标详情或轨迹加载失败';
      target.detailForbidden = forbidden;
      target.detailRetryable = error?.code === 'NETWORK_ERROR'
        || (Number(error?.status) >= 500 && Number(error?.status) <= 599);
    }
  } finally {
    if (alive && liveTargets.includes(target)) {
      target.detailLoading = false;
      applyFilter();
      refresh();
    }
  }
}

function selectTarget(target, center = true) {
  if (!target) return;
  sel = target;
  if (map) {
    map.sel = target.posValid ? target.id : null;
    if (center && target.posValid && map.w) map.centerAt(target.lon, target.lat);
  }
  refresh();
  loadTargetData(target);
}

async function loadTargets(preferredId = '') {
  pageLoading = true;
  pageError = '';
  pageForbidden = false;
  liveTargets = [];
  sel = null;
  applyFilter();
  refresh();
  try {
    const page = await targetApi.listAll({ size: 100 });
    if (!alive) return;
    liveTargets = (Array.isArray(page?.items) ? page.items : []).map(item => ({
      ...targetFields(item), detail: null, tracks: [], track: [], trackId: '',
      rawTrackPoints: [], pointTotal: 0, currentTrackIndex: 0, trackLoading: false,
      trackLoadError: '', trackLoadRetryable: false, showTrack: false, detailLoading: false,
      detailError: '', detailRetryable: false, detailForbidden: false
    }));
    // safe-default: 上下文目标不可见时选中用户可见的首项；空列表保持显式空态。
    sel = liveTargets.find(target => target.id === preferredId) || liveTargets[0] || null;
  } catch (error) {
    if (!alive) return;
    pageForbidden = error?.status === 403 || error?.code === 'FORBIDDEN';
    pageError = pageForbidden ? '' : error?.message || '目标数据加载失败';
  } finally {
    if (!alive) return;
    pageLoading = false;
    applyFilter();
    refresh();
    if (sel) loadTargetData(sel);
  }
}

onUnmounted(() => { alive = false; if (map) map.destroy(); map = null; closeDrawer(); });

onMounted(() => {
  alive = true;
  const view = root.value;
  map = new window.MapView(document.getElementById('stMap'), {
    maxDev: 46, maxAlarm: 6, zoom: 1.06, legend: false,
    onPick: p => {
      if (p.kind === 'target') selectTarget(liveTargets.find(t => t.id === (p.data.originalTargetId || p.data.id)));
    }
  });
  const ctx = U.consume('situation');
  applyFilter();
  refresh();

  // 当前阶段地图只展示标准目标 API 的可信位置与轨迹；设备、空域接口尚未接入。
  const lyBox = document.createElement('div');
  lyBox.className = 'maplayers';
  const LY = [
    ['track', '目标轨迹（服务端 WGS84）', '<span class="sw ln" style="border-color:#ffb020"></span>']
  ];
  lyBox.classList.add('collapsed');
  lyBox.innerHTML = `<div class="lyt" role="button" tabindex="0" aria-label="展开或收起图层与图例">图层与图例 <span class="lg-arrow">▸</span></div>` +
    LY.map(([k, n, sw]) => `<label><input type="checkbox" data-layer="${k}" checked>${sw}${n}</label>`).join('') +
    '<div class="sub">设备、空域：尚未接入，不展示</div>';
  document.getElementById('stMap').appendChild(lyBox);
  lyBox.querySelector('.lyt').addEventListener('click', () => {
    const c = lyBox.classList.toggle('collapsed');
    lyBox.querySelector('.lg-arrow').textContent = c ? '▸' : '▾';
  });
  U.on(view, '[data-layer]', 'change', (e, el) => map.setLayer(el.dataset.layer, el.checked));
  U.on(view, '[data-target]', 'click', (e, el) => {
    selectTarget(liveTargets.find(target => target.id === el.dataset.target));
  });
  U.on(view, '[data-f]', 'change', (e, el) => {
    if (el.dataset.f !== 'ttype') return;
    flt[el.dataset.f] = el.value;
    applyFilter(); refresh();
  });
  document.getElementById('btnTech').onclick = techDrawer;
  loadTargets(ctx?.target || '');
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
        <UPanel title="多源融合结果" sub="服务端目标状态与来源映射" panel-style="flex:none;height:264px"
          :extra="techExtra" body-html='<div id="stFuse"></div>' />
      </div>

      <!-- 右栏：当前目标与处置 → 目标列表。
           420px 固定宽 → 占 40%（用户 2026-08-30）；420px 下限保窄屏排版不塌 -->
      <div class="col" style="width:40%;min-width:420px;flex:none">
        <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导） -->
        <div class="warnbox" style="margin:0;padding:8px 11px;font-size:12px;flex:none">
          在<b>地图</b>或下方<b>「目标列表」</b>点选目标查看服务端详情与轨迹；
          无可信 WGS84 最新位置的目标不绘最新点，如有历史轨迹可按需查看。告警、合法性、风险、视频与处置尚未接入。</div>
        <UPanel title="当前目标 · 详情与处置" panel-style="flex:none" nopad
          extra='<span id="stTag"></span>' body-style="padding:12px;overflow:auto"
          body-html='<div id="stTarget"></div>' />
        <UPanel title="目标列表" panel-style="flex:1;min-height:172px" nopad
          extra='<span class="tag t-gray">告警尚未接入</span>'
          body-style="padding:8px;overflow:auto"
          body-html='<div class="alarm" id="stAlarms"></div>' />
      </div>
    </div>
    <n-drawer v-model:show="showDrawer" :width="600" :z-index="150" to="body">
      <n-drawer-content closable body-content-style="padding:14px 16px">
        <template #header>技术详情 · <span class="mono" style="font-size:14px;margin-left:6px">{{ drawerTitle }}</span></template>
        <div v-html="drawerHtml"></div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>
