<script>
/* 模块级状态：跨导航保持（legacy 约定）。
   level/status 映射为服务端契约的 severity/state；kind/region 保留控件但阶段 4 无契约支持，
   固定为「全部」且禁用；sort/dir 保留字段，服务端固定按接收时间倒序，页面不做假排序。 */
const S = {
  st: { page: 1, size: 10, level: '全部', status: '全部', kind: '全部', region: '全部', sel: null, selId: null,
    sort: 'ts', dir: -1 }
};
export default {};
</script>

<script setup>
/* 异常飞行与告警中心 —— 转换页（源：legacy pages/alarms.js）。
   阶段 4：数据真源全部改为 alarmApi.js（apiRequest 唯一入口）。本流程不再读写
   window.MOCK / window.EVT；API 失败显示错误并允许重试，不回退 Mock。
   页面骨架（KPI / 工具条 / 列头 / 列表 + 分页 / 地图 / 详情 / 处置步骤与动作区）
   沿用 HEAD 版本的 DOM 结构与 class 名，只替换数据源与状态口径。
   地图（MapView）在 onUnmounted 销毁；usePageChrome 先注册，故卸载顺序
   与旧版 route() 一致：CH.disposeAll → map.destroy → closeModal。 */
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { toast } from '@/ui/nv.js';
import { getAlarm, getUavEvent, listAlarms, listUavVerifications } from '@/services/alarmApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import { targetApi } from '@/services/targetApi.js';
import { DISPOSAL_ACTION_LABEL, disposalStatusText, labelOf, SOURCE_MODE_LABEL as MODE_TEXT, targetTypeLabel } from '@/ui/labels.js';
import { disposalApi, isDisposalUnavailable } from '@/services/disposalApi.js';
import { DISPOSAL_UNAVAILABLE_TEXT, openDisposalRequest } from '@/ui/disposalAuthModal.js';

const U = window.UI;
usePageChrome('alarms');
const root = ref(null);
/* reactive 代理同一份模块级状态：n-pagination 的 :page/:page-size 需要响应式，
   底层对象仍是 S.st，跨导航记忆不变 */
const st = reactive(S.st);
const totalCount = ref(0);
let map = null;
onUnmounted(() => { if (map) map.destroy(); map = null; });

/* ---------- 契约词典（阶段 4 固定） ---------- */
const NOT_WIRED = '阶段 4 未接入';
const SEVERITY = {
  CRITICAL: { t: '紧急', c: 't-red', tone: 'bad' }, HIGH: { t: '高', c: 't-red', tone: 'bad' },
  MEDIUM: { t: '中', c: 't-amber', tone: 'warn' }, LOW: { t: '低', c: 't-blue', tone: 'info' }
};
/* CONFIRMED 只表示「已核实，待处置」——反制、干扰、处罚交接都未接入，页面不得出现「反制中 / 已处置」。 */
const STATE = {
  PENDING_VERIFICATION: { t: '待核实', c: 't-amber', color: '#ffb020' },
  EVIDENCE_REQUIRED: { t: '证据待补充', c: 't-orange', color: '#ff8b3d' },
  CONFIRMED: { t: '已核实，待处置', c: 't-cyan', color: '#22d3ee' },
  FALSE_POSITIVE: { t: '误报', c: 't-blue', color: '#8fbaff' }
};
const NO_EVENT = { t: '未建事件', c: 't-gray', color: '#8ca0be' };
const ALARM_TYPE = { UAV_INTRUSION: '无人机入侵', UAV: '无人机告警' };
const SOURCE_MODE = { mock: { t: MODE_TEXT.mock, c: 't-purple' }, replay: { t: MODE_TEXT.replay, c: 't-amber' }, live: { t: MODE_TEXT.live, c: 't-green' } };
const LEVEL_OPTS = [{ v: '全部', t: '全部' }, { v: 'CRITICAL', t: '紧急' }, { v: 'HIGH', t: '高' }, { v: 'MEDIUM', t: '中' }, { v: 'LOW', t: '低' }];
const STATUS_OPTS = [{ v: '全部', t: '全部' }, ...Object.entries(STATE).map(([v, s]) => ({ v, t: s.t }))];

/* ---------- 通用小工具：服务端字符串一律转义后才进 innerHTML ---------- */
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const el = id => document.getElementById(id);
function fmt(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const clock = ms => fmt(ms).slice(11) || '—';
const sevOf = a => SEVERITY[a.severity] || { t: esc(a.severity || '—'), c: 't-gray', tone: 'info' };
const stateOf = a => a.event_id ? (STATE[a.state] || { t: esc(a.state || '状态未知'), c: 't-gray', color: '#8ca0be' }) : NO_EVENT;
const stateText = code => (STATE[code] || { t: esc(code || '—') }).t;
const typeOf = a => ALARM_TYPE[a.alarm_type] || esc(a.alarm_type || '—');
const modeOf = a => SOURCE_MODE[a.source_mode] || { t: esc(a.source_mode || '—'), c: 't-gray' };
const sevTag = a => U.tag(sevOf(a).t, sevOf(a).c);
const stateTag = a => U.tag(stateOf(a).t, stateOf(a).c);
function messageOf(e) {
  if (!e) return '请求失败，请稍后重试';
  if (e.status === 401) return '登录已失效，请重新登录';
  if (e.status === 403) return '当前账号没有相应权限';
  if (e.code === 'TIMEOUT' || e.code === 'NETWORK_ERROR') return e.message || '服务不可用，请稍后重试';
  return e.message || '请求失败，请稍后重试';
}
/* 只信任 WGS84 且数值在合法区间的坐标；未知/不可信不画点，也不以 (0,0) 补位。 */
function coord(loc, issues, field) {
  if (!loc || loc.coordinate_system !== 'WGS84') return null;
  if (field && Array.isArray(issues) && issues.some(i => i && i.field === field)) return null;
  const lon = Number(loc.longitude), lat = Number(loc.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

/* ---------- 页面数据（服务端事实的一次性快照，不作为状态机真源） ---------- */
const list = { rows: [], loading: false, error: '' };
let listSeq = 0, detailSeq = 0;
const emptyDetail = () => ({ alarm: null, event: null, history: [], historyTotal: 0, loading: false, error: '', eventError: '',
  target: null, targetLoading: false, targetError: '', track: null, trackError: '' });
let cur = emptyDetail();
/* 深链（sessionStorage alarm.sel）—— 与 legacy render() 同构：mount 后按 ID 直接向服务端取详情 */
const deepId = sessionStorage.getItem('alarm.sel');
sessionStorage.removeItem('alarm.sel');

/* ---------- KPI：全部由服务端 total 得出；无法由后端得出的指标显示「尚未接入」 ---------- */
/* 当前选中事件的处置授权：按动作类型取最新一条，供流程步骤与按钮显示真实状态。
   读不到（13.1 未落地时是 404）就记下原因并显示“尚未接入”，绝不假装“无授权”。 */
const disposal = reactive({ byAction: {}, unavailable: false, error: '' });
const DISPOSAL_ACTIVE = ['APPROVED', 'EXECUTING'];

async function loadEventDisposals(eventId) {
  disposal.byAction = {}; disposal.unavailable = false; disposal.error = '';
  if (!eventId) return;
  try {
    const page = await disposalApi.list({ subject_kind: 'UAV_EVENT', subject_id: eventId, page: 1, size: 50 });
    // 同一动作可能申请过多次：按申请时间取最新一条代表当前状态。
    for (const row of page?.items || []) {
      const prev = disposal.byAction[row.action_type];
      if (!prev || Number(row.requested_at || 0) >= Number(prev.requested_at || 0)) disposal.byAction[row.action_type] = row;
    }
  } catch (error) {
    disposal.unavailable = isDisposalUnavailable(error);
    disposal.error = disposal.unavailable ? DISPOSAL_UNAVAILABLE_TEXT : messageOf(error);
  }
}

const KPI_DEFS = [
  { label: '今日告警总数', color: 'blue', icon: 'alert' },
  { label: '待核实', color: 'amber', icon: 'alert' },
  { label: '反制中', color: 'orange', icon: 'radar' },
  { label: '干扰中', color: 'red', icon: 'radar' },
  { label: '待处置', color: 'green', icon: 'check' },
  { label: '误报', color: 'purple', icon: 'check' }
];
const kpiList = ref(KPI_DEFS.map(k => ({ ...k, value: '…', desc: '正在读取服务端统计' })));
async function loadKpis() {
  const count = q => listAlarms({ ...q, page: 1, size: 1 }).then(p => Number(p && p.total) || 0);
  /* “反制中 / 干扰中”问的是当前有多少处置在进行，因此按状态计数（契约的列表接口没有日期过滤，
     跨页在前端数日期会数错）。EXECUTING 是正在执行，APPROVED 是已批准待执行，两者分开报。 */
  const disposalCount = actionType => Promise.all(DISPOSAL_ACTIVE.map(status =>
    disposalApi.list({ action_type: actionType, status, page: 1, size: 1 }).then(p => Number(p && p.total) || 0)
  )).then(([approved, executing]) => ({ approved, executing }));
  // 非展示用：算 KPI 查询窗口（今日 / 近 30 天）的时间戳边界，只当查询参数发给服务端。
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = from + 86400000, d30 = from - 29 * 86400000;
  const r = await Promise.allSettled([
    count({ occurred_from: from, occurred_to: to }), count({ occurred_from: d30, occurred_to: to }),
    count({ state: 'PENDING_VERIFICATION' }), count({ state: 'EVIDENCE_REQUIRED' }),
    count({ state: 'CONFIRMED' }), count({ state: 'FALSE_POSITIVE' }),
    disposalCount('COUNTERMEASURE'), disposalCount('JAMMING')
  ]);
  const v = r.map(x => x.status === 'fulfilled' ? x.value : null);
  const num = x => x == null ? '—' : U.num(x);
  /* 处置授权读不到时如实说明原因，不写 0——“没有在执行”与“读不到”是两件事。 */
  const disposalKpi = (def, settled, value) => {
    if (!value) {
      const unavailable = settled?.reason && isDisposalUnavailable(settled.reason);
      return { ...def, value: unavailable ? '尚未接入' : '—', desc: unavailable ? DISPOSAL_UNAVAILABLE_TEXT : '读取失败：' + esc(messageOf(settled?.reason)) };
    }
    return { ...def, value: U.num(value.executing), desc: `另有 ${U.num(value.approved)} 起已批准待执行` };
  };
  const fail = i => v[i] == null ? '读取失败：' + esc(messageOf(r[i].reason)) : null;
  kpiList.value = [
    { ...KPI_DEFS[0], value: num(v[0]), desc: fail(0) || `近30天 ${num(v[1])} 起（按发生时间统计，发生时间未知者不计）` },
    { ...KPI_DEFS[1], value: num(v[2]), desc: fail(2) || `另有证据待补充 ${num(v[3])} 起，可再次核实` },
    disposalKpi(KPI_DEFS[2], r[6], v[6]),
    disposalKpi(KPI_DEFS[3], r[7], v[7]),
    { ...KPI_DEFS[4], value: num(v[4]), desc: fail(4) || '已核实，待处置；反制与处罚交接未接入' },
    { ...KPI_DEFS[5], value: num(v[5]), desc: fail(5) || '人工核实后已排除' }
  ];
}

/* ---------- 工具条：只暴露契约支持的过滤；不支持的保留控件但禁用并说明 ---------- */
const disabledSelect = (name, reason) =>
  `<select class="sel" data-f="${name}" disabled aria-disabled="true" title="${reason}"><option value="全部" selected>全部</option></select>`;
const listPanelBody = `<div class="toolbar">
    <div class="toolbar-fields">
      ${U.field('等级', U.select('level', LEVEL_OPTS, st.level))}
      ${U.field('类别', disabledSelect('kind', `服务端契约未提供类别筛选，${NOT_WIRED}`))}
      ${U.field('状态', U.select('status', STATUS_OPTS, st.status))}
      ${U.field('区域', disabledSelect('region', `服务端支持 district_id 过滤，但本页尚无区域字典，${NOT_WIRED}`))}
    </div>
  </div>
  <div id="alList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
const mapExtra = `<span id="alMapSrc" style="font-size:11px;color:var(--txt-3);white-space:nowrap"></span>
  <button class="btn" id="alLoc" style="height:24px;font-size:11.5px;flex:none" title="重新定位到当前告警的关联目标">${U.icon('location')} 定位</button>`;
const mapBody = `<div id="alMap" style="flex:1;min-height:0"></div>
    <div id="alMapInfo" style="flex:none;height:19px;line-height:19px;padding:2px 2px 0;font-size:10.5px;
      color:var(--txt-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>`;

/* 列头排序：服务端固定 received_at DESC, alarm_id DESC；控件保留但禁用，不对一页数据做假排序。 */
const SORT_REASON = `服务端固定按接收时间倒序（received_at DESC, alarm_id DESC），列排序${NOT_WIRED}`;
function sortTh(key, label) {
  const on = key === 'ts';
  return `<span class="lnk" data-sort="${key}" role="button" tabindex="0" aria-disabled="true" title="${SORT_REASON}"
    style="color:inherit;cursor:not-allowed;text-decoration:underline dotted;text-underline-offset:3px;text-decoration-color:rgba(156,198,255,.3)"
    >${label}${on ? '<span style="font-size:10px;margin-left:2px">▼</span>' : ''}</span>`;
}

function queryOf() {
  const q = { page: st.page, size: st.size };
  if (st.level !== '全部') q.severity = st.level;
  if (st.status !== '全部') q.state = st.status;
  return q;
}

function summaryOf(a) {
  const text = `${typeOf(a)} · 来源 ${esc(a.source_name || a.source_code || '—')}（${modeOf(a).t}）· 发生 ${fmt(a.occurred_at) || '未知'}`;
  return `<div title="${text}" style="white-space:normal;line-height:1.5;
        max-height:34px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${text}</div>`;
}

function listHtml() {
  if (list.loading && !list.rows.length) return `<div class="empty">正在读取告警列表…</div>`;
  if (list.error) return `<div class="empty">${esc(list.error)}<br><button class="btn" data-al="retry" style="margin-top:10px">重试</button></div>`;
  return U.table([
    {
      t: sortTh('ts', '告警编号 / 时间'), w: '108px', cls: 'num',
      render: a => U.cell(esc(a.alarm_no || String(a.alarm_id).slice(-9)), clock(a.received_at), { mono: true, title: esc(a.alarm_id) })
    },
    { t: sortTh('level', '等级'), w: '52px', align: 'center', render: sevTag },
    { t: sortTh('kind', '类别 / 类型'), w: '128px', render: a => U.cell(U.tag(modeOf(a).t, modeOf(a).c), typeOf(a)) },
    { t: sortTh('district', '关联目标 / 区域'), w: '146px', render: a => U.cell(a.target_id ? esc(a.target_no || a.target_id) : '—', esc(a.district_name || a.district_id || '—'), { mono: true, title: a.target_id ? esc(a.target_id) : '无关联目标或无目标读取权限' }) },
    { t: '告警内容', render: summaryOf },
    { t: sortTh('status', '状态'), w: '86px', render: stateTag }
  ], list.rows, { rowId: a => a.alarm_id, activeId: cur.alarm && cur.alarm.alarm_id });
}

/* ---------- 处置流程与动作：只有人工核实接入；其余节点/按钮保留位置但禁用并说明 ---------- */
function disposalSteps(a, ev) {
  const trigger = { n: '告警触发', t: clock(a.received_at), done: true, act: false };
  const na = n => ({ n, t: NOT_WIRED, done: false, act: false, applicable: false });
  /* 反制 / 信号干扰按该事件的最新授权显示状态；读不到时说“尚未接入”，没有授权时说“尚无授权”，
     两者不能混为一谈。“处置”仍是处罚交接，阶段 4 起就未接入。 */
  const step = actionType => {
    const name = labelOf(DISPOSAL_ACTION_LABEL, actionType);
    if (disposal.unavailable || disposal.error) return { n: name, t: disposal.error || DISPOSAL_UNAVAILABLE_TEXT, done: false, act: false, applicable: false };
    const auth = disposal.byAction[actionType];
    if (!auth) return { n: name, t: '尚无授权', done: false, act: false, applicable: true };
    return {
      n: name,
      t: disposalStatusText(auth),
      done: auth.status === 'COMPLETED',
      act: DISPOSAL_ACTIVE.includes(auth.status),
      applicable: true
    };
  };
  const tail = [step('COUNTERMEASURE'), step('JAMMING'), na('处置')];
  if (!ev) return [trigger, { n: '人工核实', t: '未建事件', done: false, act: false }, ...tail];
  if (ev.state === 'FALSE_POSITIVE') return [trigger, { n: '人工核实', t: '误报', done: true, act: false }];
  if (ev.state === 'CONFIRMED') return [trigger, { n: '人工核实', t: '属实', done: true, act: false }, ...tail];
  if (ev.state === 'EVIDENCE_REQUIRED') return [trigger, { n: '人工核实', t: '证据待补充', done: false, act: true }, ...tail];
  return [trigger, { n: '人工核实', t: '', done: false, act: true }, ...tail];
}

function disposalActions(a, ev) {
  const dis = (key, label, reason, cls) => `<button class="btn ${cls || ''}" data-al="${key}" disabled title="${reason}">${label}</button>`;
  if (!ev) return dis('verify', '人工核实', '尚未创建核实事件，无法核实');
  if ((ev.allowed_actions || []).includes('VERIFY')) return `<button class="btn pri" data-al="verify">人工核实</button>`;
  if (ev.state === 'CONFIRMED') {
    /* 已核实的事件可以发起联动反制申请：按钮本身只负责“提申请”，能不能执行由审批与时限决定。 */
    const counter = disposal.unavailable || disposal.error
      ? dis('counter', `${U.icon('bolt')} 发起联动反制`, esc(disposal.error || DISPOSAL_UNAVAILABLE_TEXT), 'danger')
      : `<button class="btn danger" data-al="counter">${U.icon('bolt')} 发起联动反制</button>`;
    return counter + ` ${dis('punish', '通知处罚部门', `${NOT_WIRED}：通知处罚部门未接入`)}`;
  }
  if (ev.state === 'FALSE_POSITIVE') return '';
  return dis('verify', '人工核实', '当前账号缺少核实权限（alarm:verify），或事件不在可核实状态');
}

function historyHtml() {
  if (!cur.event) return `<div class="empty">尚未创建核实事件</div>`;
  if (cur.eventError) return `<div class="empty">${esc(cur.eventError)}</div>`;
  if (!cur.history.length) return `<div class="empty">暂无核实历史</div>`;
  const more = cur.historyTotal > cur.history.length ? `<div class="empty">仅显示前 ${cur.history.length} 条，共 ${U.num(cur.historyTotal)} 条</div>` : '';
  /* 说明文本是用户输入：这里只留占位 span，innerHTML 写入后再以 textContent 填充，不进 v-html。 */
  return U.timeline(cur.history.map((h, i) => ({
    time: clock(h.created_at),
    label: `${stateText(h.previous_state)} → ${stateText(h.resulting_state)}（v${Number(h.version)}）`,
    desc: `操作人 ${esc(h.actor_name || h.actor_id || '—')} · <span data-note="${i}"></span>`,
    color: (STATE[h.resulting_state] || NO_EVENT).color
  }))) + more;
}
function fillNotes(host) {
  host.querySelectorAll('[data-note]').forEach(n => { const h = cur.history[Number(n.dataset.note)]; n.textContent = h ? String(h.note == null ? '' : h.note) : ''; });
}

function detailHtml() {
  const a = cur.alarm, stEl = el('alSt');
  if (!a) {
    if (stEl) stEl.innerHTML = '';
    if (cur.loading) return '<div class="empty">正在读取告警详情…</div>';
    if (cur.error) return `<div class="empty">${esc(cur.error)}<br><button class="btn" data-al="retry-detail" style="margin-top:10px">重试</button></div>`;
    return '<div class="empty">请选择告警</div>';
  }
  if (stEl) stEl.innerHTML = stateTag(a);
  const ev = cur.event, t = cur.target, ls = t && t.latest_state;
  const targetType = !a.target_id ? '—' : cur.targetLoading ? '读取中…' : cur.targetError ? '读取失败' : esc(t ? targetTypeLabel(t.subtype, t.object_type_code) : '—');
  const altSpeed = ls ? `${ls.altitude_amsl_m == null ? '—' : esc(ls.altitude_amsl_m)} m / ${ls.speed_mps == null ? '—' : esc(ls.speed_mps)} m/s` : '— m / — m/s';
  return `${U.detailHero({
    icon: 'alert', subtitle: '告警事件', title: typeOf(a), id: esc(a.alarm_no || a.alarm_id),
    tags: [sevTag(a), stateTag(a)],
    meta: [['区域', esc(a.district_name || a.district_id || '—')], ['时间', clock(a.received_at)]]
  })}
    ${U.metricStrip([
      { label: '告警等级', value: sevOf(a).t, tone: sevOf(a).tone, icon: 'alert' },
      { label: '处置状态', value: stateOf(a).t, tone: a.state === 'CONFIRMED' || a.state === 'FALSE_POSITIVE' ? 'info' : 'warn', icon: 'play' },
      { label: '目标类型', value: targetType, icon: 'plane' },
      { label: '来源置信', value: NOT_WIRED, icon: 'radar' }
    ], { compact: true })}
    ${U.sect('处置流程', U.steps(disposalSteps(a, ev)), { icon: 'trend' })}
    ${U.sect('告警信息', U.kv([
    ['告警类型', typeOf(a)], ['告警等级', sevTag(a)],
    ['触发时间', fmt(a.occurred_at) || '未知'], ['接收时间', fmt(a.received_at) || '—'],
    ['所在区域', esc(a.district_name || a.district_id || '—')], ['所属机构', esc(a.owner_org_name || a.owner_org_id || '—')],
    ['关联目标', a.target_id ? `<span class="mono" title="${esc(a.target_id)}">${esc(a.target_no || a.target_id)}</span>` : '无关联目标或无目标读取权限'],
    ['目标类型', targetType],
    ['高度/速度', altSpeed],
    ['数据来源', `${esc(a.source_name || a.source_code || '—')}（${modeOf(a).t}）`],
    ['核实事件', ev ? `已建核实事件　v${Number(ev.version)}` : (a.event_id ? '已建核实事件（详情读取失败）' : '尚未创建核实事件')]
  ], { surface: true, density: 'compact' }), { icon: 'alert' })}
    ${U.sect('核实历史', historyHtml(), { icon: 'trend' })}
    ${U.detailActions(`
      <button class="btn" data-al="video" disabled title="${NOT_WIRED}：实时视频">${U.icon('video')} 实时视频</button>
      <button class="btn" data-al="replay" disabled title="${NOT_WIRED}：轨迹回放">${U.icon('trend')} 轨迹回放</button>
      ${disposalActions(a, ev)}`)}`;
}

function paintList() { const host = el('alList'); if (host) host.innerHTML = listHtml(); }
function paintDetail() { const host = el('alDetail'); if (!host) return; host.innerHTML = detailHtml(); fillNotes(host); }

/* ---------- 地图：只有响应含 target_id（服务端已按 target:read 与范围元组裁剪）才读目标/轨迹 ---------- */
function focusMap() {
  if (!map) return;
  const info = el('alMapInfo'), srcEl = el('alMapSrc'), a = cur.alarm;
  const setInfo = (html, title) => { if (info) { info.innerHTML = html; info.title = title || ''; } };
  const warn = text => `<span class="inline-icon" style="color:#ffd07a">${U.icon('warning')} ${text}</span>`;
  map.sel = null;
  map.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  if (srcEl) srcEl.textContent = '';
  if (!a) return setInfo(cur.loading ? '正在读取告警…' : '请选择告警');
  if (!a.target_id) return setInfo(warn('无关联目标或无目标读取权限，无法定位'));
  if (cur.targetLoading) return setInfo('正在读取关联目标…');
  if (cur.targetError) return setInfo(warn(`关联目标 ${esc(a.target_no || a.target_id)} 读取失败：${esc(cur.targetError)}`));
  const t = cur.target, ls = t && t.latest_state;
  const pos = ls ? coord(ls.location, ls.field_issues, 'location') : null;
  const pts = ((cur.track && cur.track.points) || []).map(p => {
    const c = coord(p.location);
    return c ? { lon: c.lon, lat: c.lat, alt: p.altitude_amsl_m == null ? null : Number(p.altitude_amsl_m), t: p.sort_time, kind: 'meas' } : null;
  }).filter(Boolean);
  const last = pos || (pts.length ? pts[pts.length - 1] : null);
  if (!t || !last) return setInfo(warn(`关联目标 ${esc(t?.target_no || a.target_no || a.target_id)} 坐标未知或不可信，不以 (0,0) 补位，无法定位`));
  const subtype = targetTypeLabel(t.subtype, t.object_type_code, '目标');
  const target = {
    id: t.target_no || t.target_id, lon: last.lon, lat: last.lat,
    alt: ls && ls.altitude_amsl_m != null ? Number(ls.altitude_amsl_m) : null,
    speed: ls && ls.speed_mps != null ? Number(ls.speed_mps) : null,
    heading: ls && ls.heading_deg != null ? Number(ls.heading_deg) : 0,
    // 合法性判定阶段 4 未接入：不向 MapView 传任何结论词（'待确认' 等），maptip 与信息栏同文案。
    type: targetTypeLabel(null, t.object_type_code, '目标'), subtype, legal: '尚未接入', risk: '—', tracked: true,
    track: pts.length > 1 ? pts : []
  };
  map.sel = target.id;
  map.setData({
    airspaces: [], devices: [], targets: [target],
    alarms: [{ id: a.alarm_id, targetId: target.id, type: typeOf(a), level: sevOf(a).t, time: fmt(a.received_at), status: stateOf(a).t }]
  });
  if (map.w) map.centerAt(last.lon, last.lat);
  const trackNote = pts.length > 1 ? `服务端轨迹 · 实测 ${pts.length} 点` : cur.trackError ? `轨迹读取失败：${esc(cur.trackError)}` : '仅最新位置，无可信轨迹点';
  if (srcEl) srcEl.innerHTML = pts.length > 1
    ? `<span class="tag t-amber" title="/api/v1/targets/{id}/tracks 最新一条轨迹的最近点位（WGS84）">服务端轨迹</span> <span style="color:#8fbaff">实${pts.length}</span>`
    : `<span class="tag t-gray" title="${cur.trackError ? esc(cur.trackError) : '该目标暂无可信轨迹点'}">无轨迹</span>`;
  setInfo(`<span class="mono" style="color:var(--txt-2)" title="${esc(t.target_id)}">${esc(t.target_no || t.target_id)}</span> · ${esc(subtype)} · 合法性 <span style="color:#8ca0be">尚未接入</span> · 高度 ${target.alt == null ? '—' : esc(target.alt) + ' m'} · ${trackNote}`,
    `${t.target_no || t.target_id}｜${subtype}｜高度 ${target.alt == null ? '—' : target.alt + ' m'}\n${trackNote}`);
}

/* ---------- 数据加载 ---------- */
async function loadList() {
  const my = ++listSeq;
  list.loading = true; list.error = '';
  paintList();
  try {
    const page = await listAlarms(queryOf());
    if (my !== listSeq) return;
    list.rows = Array.isArray(page && page.items) ? page.items : [];
    totalCount.value = Number(page && page.total) || 0;
    list.loading = false;
    if (!list.rows.length && st.page > 1 && totalCount.value) {
      st.page = Math.max(1, Math.ceil(totalCount.value / st.size));
      return loadList();
    }
  } catch (e) {
    if (my !== listSeq) return;
    // API 失败只显示错误并允许重试，绝不回退 Mock 列表。
    list.rows = []; totalCount.value = 0; list.loading = false; list.error = messageOf(e);
  }
  paintList();
}

async function selectAlarm(id) {
  const my = ++detailSeq;
  st.selId = id; st.sel = null;
  cur = emptyDetail(); cur.loading = true;
  const listEl = el('alList');
  if (listEl) U.selectRow(listEl, id);
  paintDetail(); focusMap();
  try {
    const alarm = await getAlarm(id);
    if (my !== detailSeq) return;
    cur.alarm = alarm;
    if (alarm.event_id) {
      try {
        const [ev, hist] = await Promise.all([getUavEvent(alarm.event_id), listUavVerifications(alarm.event_id, { page: 1, size: 100 })]);
        if (my !== detailSeq) return;
        cur.event = ev; cur.history = Array.isArray(hist && hist.items) ? hist.items : []; cur.historyTotal = Number(hist && hist.total) || 0;
        await loadEventDisposals(alarm.event_id);
        if (my !== detailSeq) return;
      } catch (e) { if (my !== detailSeq) return; cur.eventError = messageOf(e); }
    }
  } catch (e) {
    if (my !== detailSeq) return;
    cur.error = messageOf(e);
  }
  cur.loading = false;
  paintDetail(); focusMap();
  await loadTarget(my);
}

async function loadTarget(my) {
  const a = cur.alarm;
  if (!a || !a.target_id) return;
  cur.targetLoading = true;
  focusMap();
  try {
    const t = await targetApi.detail(a.target_id);
    if (my !== detailSeq) return;
    cur.target = t;
    try {
      const tracks = await targetApi.tracks(a.target_id, { page: 1, size: 1 });
      const track = tracks && Array.isArray(tracks.items) ? tracks.items[0] : null;
      if (track) {
        // 点位按时间升序分页：先取第一页得到 total，再取最后一页即最近 ≤100 个点位。
        let points = await targetApi.points(track.track_id, { page: 1, size: 100 });
        const total = Number(points && points.total) || 0;
        if (total > 100) points = await targetApi.points(track.track_id, { page: Math.ceil(total / 100), size: 100 });
        if (my !== detailSeq) return;
        cur.track = { id: track.track_id, points: Array.isArray(points && points.items) ? points.items : [] };
      }
    } catch (e) { if (my !== detailSeq) return; cur.trackError = messageOf(e); }
  } catch (e) {
    if (my !== detailSeq) return;
    cur.targetError = messageOf(e);
  }
  if (my !== detailSeq) return;
  cur.targetLoading = false;
  paintDetail(); focusMap();
}

async function refreshAfterWrite() {
  const id = cur.alarm && cur.alarm.alarm_id;
  await Promise.all([loadList(), id ? selectAlarm(id) : Promise.resolve(), loadKpis()]);
}

/* ---------- 人工核实：共享弹窗（与工作台同一实现，幂等键保留与 409/超时回读在弹窗内处理） ---------- */
function verifyModal() {
  const a = cur.alarm, ev = cur.event;
  if (!a || !ev) return toast('尚未创建核实事件，无法核实', 'err');
  openUavVerification({
    alarm: a,
    event: ev,
    refresh: async () => { await refreshAfterWrite(); return cur.event; }
  });
}

/* 发起联动反制申请：主体是这条已核实的无人机事件，策略与时限由服务端返回，前端不预设。 */
async function counterModal() {
  const a = cur.alarm, ev = cur.event;
  if (!a || !ev) return toast('尚未创建核实事件，无法发起处置申请', 'err');
  let policy = null;
  try { policy = await disposalApi.policies(); } catch { policy = null; }   // 策略读不到只影响提示文字，不阻断申请
  /* 决策 13-19：信号干扰与联动反制共用这一个入口，动作类型在弹窗里选，不给页面新增按钮。 */
  openDisposalRequest({
    actionType: 'COUNTERMEASURE',
    actionOptions: ['COUNTERMEASURE', 'JAMMING'],
    subjectKind: 'UAV_EVENT',
    subjectId: ev.event_id,
    subjectText: a.alarm_no || a.alarm_id,
    policy,
    // refreshAfterWrite 会重读列表、详情（内含授权）与 KPI，详情重读后步骤与按钮即反映新状态。
    refresh: async () => {
      await refreshAfterWrite();
      return disposal.byAction.COUNTERMEASURE || disposal.byAction.JAMMING || null;
    }
  });
}

function onPage(p2) { st.page = p2; loadList(); }
function onPageSize(s2) { st.size = s2; st.page = 1; loadList(); }

onMounted(async () => {
  const view = root.value;
  paintList(); paintDetail();
  map = new window.MapView(el('alMap'), {
    zoom: 2.2, maxDev: 0, maxAlarm: 1, legend: false, layers: { device: false }
  });
  focusMap();
  requestAnimationFrame(focusMap);

  U.on(view, '[data-row]', 'click', (e, row) => { if (row.dataset.row) selectAlarm(row.dataset.row); });
  /* 分页交互已由模板层 <n-pagination> 受控接管（P2），[data-pg]/[data-size] 委托删除 */
  U.on(view, '[data-f]', 'change', (e, ctl) => {
    if (ctl.disabled) return;
    st[ctl.dataset.f] = ctl.value; st.page = 1; loadList();
  });
  const sortNote = () => toast(SORT_REASON);
  U.on(view, '[data-sort]', 'click', sortNote);
  U.on(view, '[data-sort]', 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortNote(); } });
  U.on(view, '[data-al]', 'click', (e, btn) => {
    if (btn.disabled) return;
    const k = btn.dataset.al;
    if (k === 'verify') verifyModal();
    else if (k === 'counter') counterModal();
    else if (k === 'retry') loadList();
    else if (k === 'retry-detail' && st.selId) selectAlarm(st.selId);
  });
  el('alLoc').onclick = () => { if (map) map.resetView(2.2); focusMap(); };

  loadKpis();
  await loadList();
  // safe-default：深链 > 上次选中 > 当前页首条；用户可见可改
  const id = deepId || st.selId || (list.rows[0] && list.rows[0].alarm_id) || null;
  if (id) {
    const pending = selectAlarm(id);
    // 深链/默认选中的行可能落在列表滚动区外：把选中行滚到列表可视区中部。
    const selTr = document.querySelector('#alList tr.on');
    if (selTr && selTr.scrollIntoView) selTr.scrollIntoView({ block: 'center' });
    await pending;
  }
});
</script>

<template>
  <div class="view" id="view" ref="root" style="overflow:hidden">
    <div class="alarms-page" style="height:100%;min-height:0;display:flex;flex-direction:column">
      <UKpis :list="kpiList" />
      <div class="row" style="margin-top:12px;flex:1;min-height:0">
        <UPanel title="告警列表" panel-style="flex:6;min-width:0" nopad>
          <div style="display:contents" v-html="listPanelBody"></div>
          <div class="pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`共 ${totalCount.toLocaleString()} 条`" @update:page="onPage" @update:page-size="onPageSize" />
          </div>
        </UPanel>
        <div class="col" style="flex:4;min-width:0">
          <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导） -->
          <div class="warnbox" style="margin:0;padding:8px 11px;font-size:12px;flex:none">
            演示动线：点左侧<b>告警列表</b>任一行 → 地图定位关联目标 → 下方详情底部点
            「<b>人工核实</b>」推进处置；已核实的事件可点「<b>发起联动反制</b>」提交处置申请（需另一人审批后才能执行）；
            「实时视频 / 轨迹回放 / 通知处罚」尚未接入，按钮保留但禁用。</div>
          <UPanel title="关联目标定位与轨迹" panel-style="height:244px;max-height:50%;flex:none" nopad
            body-style="padding:6px" :extra="mapExtra" :body-html="mapBody" />
          <UPanel title="告警详情与处置" panel-style="flex:1;min-height:0" nopad
            extra='<span id="alSt"></span>' body-html='<div id="alDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
        </div>
      </div>
    </div>
  </div>
</template>
