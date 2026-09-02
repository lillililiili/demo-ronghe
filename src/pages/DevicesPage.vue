<script>
/* 模块级状态：跨导航保持（legacy 约定）。SORT 同为页面状态。 */
const S = {
  st: { page: 1, size: 10, type: '全部', region: '全部', vendor: '全部', status: '全部', kw: '', sel: null, tab: 'pos' },
  SORT: { key: null, dir: 'asc' }
};
export default {};
</script>

<script setup>
/* 设备管理 —— 转换页（源：legacy pages/devices.js）。
   ⚠ 模块加载期设施（DS 状态机初始化、window.DATASOURCE 导出、两条 U.regParams、
   DOMContentLoaded paintFooter）仍由 legacy script 执行。数据源切换 UI（modeBar/
   switchModal）已按用户裁定删除、运行时不可达，页面在此复刻一份同构 DS 自用
   （含 sessionStorage 恢复，语义与 legacy 完全一致；两份 DS 均恒为所存模式，
   无运行时分叉路径）。 */
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { NPagination } from 'naive-ui';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { toast } from '@/ui/nv.js';
import { closeModal } from '@/ui/modal.js';
import { openFormModal, optionsOf } from '@/ui/formModal.js';

const M = window.MOCK, U = window.UI, CH = window.CH;
usePageChrome('devices');
const root = ref(null);
/* reactive 代理同一份模块级状态：n-pagination 需要响应式，底层仍是 S.st */
const st = reactive(S.st), SORT = S.SORT;
const totalCount = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(totalCount.value / st.size)));
let map = null;
onUnmounted(() => { if (map) map.destroy(); map = null; });

const TYPES = [...new Set(M.devices.map(d => d.type))];
const VENDORS = [...new Set(M.devices.map(d => d.vendor))];

const TBD = '【待确认：正式环境接入地址】';
const MODES = {
  mock: { name: 'Mock 模拟数据', mark: '模拟', foot: 'Mock 模拟数据源（非真实感知结果）', color: '#ffb020', tag: 't-amber', adapter: 'assets/js/mock.js · MockAdapter', writable: true },
  replay: { name: '历史回放', mark: '回放', foot: '历史回放数据源', color: '#a97bff', tag: 't-purple', adapter: 'assets/js/mock.js · ReplayAdapter（历史录制回放）', writable: false },
  live: { name: '正式接口', mark: '实时', foot: '正式接口数据源', color: '#2fd06e', tag: 't-green', adapter: 'RestAdapter（正式环境端点）', writable: false }
};
const SNAPS = Array.from({ length: 7 }, (_, k) => M.util.dayAdd(M.CONF.demoTime, k - 7));
const snapTime = () => SNAPS[DS.snapIdx];
const snapKey = () => M.util.fmtDT(snapTime());

const DS = {
  mode: 'mock', snapIdx: SNAPS.length - 1, endpoint: '', probe: null,
  by: '系统默认', since: M.util.fmtDT(M.CONF.demoTime), reason: '平台启动加载默认 Adapter', log: []
};
(function restore() {
  try {
    const v = JSON.parse(sessionStorage.getItem('ds.mode.v1') || 'null');
    if (v && MODES[v.mode]) Object.assign(DS, v);
  } catch (e) { }
})();

let replayCache = {};
function replayList() {
  const key = snapKey();
  if (replayCache[key]) return replayCache[key];
  const t = snapTime().getTime();
  const out = M.devices.map(d => {
    const r = CH.seeded(d.id + '@' + key);
    let status = d.status;
    if (r(0, 99) < 12) { const alt = ['在线', '离线', '异常'].filter(s => s !== d.status); status = alt[r(0, alt.length - 1)]; }
    const hbMin = status === '离线' ? r(12, 320) : r(0, 2);
    const alarm = status === '异常' ? true : (status === '在线' ? r(0, 99) < 6 : r(0, 1) === 1);
    return Object.assign({}, d, {
      status, alarm, hbMin,
      hb: M.util.fmtDT(new Date(t - hbMin * 60000 - r(0, 59) * 1000)),
      health: status === '在线' ? (alarm ? '一般' : '良好') : (status === '异常' ? '异常' : '未知'),
      latency: status === '离线' ? null : r(12, 180),
      loss: status === '离线' ? null : +(r(0, alarm ? 2600 : 140) / 100).toFixed(2),
      rssi: -r(52, 98),
      temp: r(38, 79)
    });
  });
  replayCache[key] = out;
  return out;
}
const probeOk = () => DS.probe ? DS.probe.items.filter(x => x.ok).length : 0;

function dsList() {
  if (DS.mode === 'replay') return replayList();
  if (DS.mode === 'live') return probeOk() ? M.devices : [];
  return M.devices;
}
function stats(list) {
  const total = list.length;
  const n = s => list.filter(d => d.status === s).length;
  const rate = v => total ? +(v / total * 100).toFixed(1) : 0;
  const online = n('在线'), offline = n('离线'), abnormal = n('异常');
  return {
    total, online, offline, abnormal, alarm: list.filter(d => d.alarm).length,
    onlineRate: rate(online), offlineRate: rate(offline), abnormalRate: rate(abnormal),
    vendors: new Set(list.map(d => d.vendor)).size, models: new Set(list.map(d => d.model)).size
  };
}
const writable = () => MODES[DS.mode].writable;
function guardWrite(action) {
  if (!M.can('设备管理', 'op')) {
    M.pushAudit('设备管理', `${action}被拒绝：无操作权限`, st.sel ? st.sel.id : 'DEVICE', '失败');
    toast('需要「设备管理」操作权限', 'err');
    return false;
  }
  if (writable()) return true;
  toast(`当前数据源为「${MODES[DS.mode].name}」，${DS.mode === 'replay'
    ? '历史回放是只读视图，不允许写台账' : '正式接口未连通，禁止下发配置'}，无法执行「${action}」。请先切回 Mock 数据源。`, 'err');
  return false;
}
function paintFooter() {
  const f = document.getElementById('fver');
  // 版本号里的 (D3) 是内部评审轮次标记，主界面不露技术编号 —— 与 app.js 面包屑同口径
  if (f) f.textContent = M.CONF.version.replace(/\s*\(D\d+\)/, '') + ' · ' + MODES[DS.mode].foot +
    (DS.mode === 'replay' ? ' @ ' + snapKey() : DS.mode === 'live' ? '（' + (probeOk() ? '已连通' : '未连通') + '）' : '');
}

/* ---------- 排序 ---------- */
const ST_ORDER = ['在线', '离线', '异常'];
const HL_ORDER = ['良好', '一般', '异常', '未知'];
const SORT_KEYS = {
  id: d => d.id, name: d => d.name, type: d => d.type + d.channel,
  owner: d => d.owner, vendor: d => d.vendor,
  status: d => ST_ORDER.indexOf(d.status), health: d => HL_ORDER.indexOf(d.health),
  hb: d => d.hb
};
function sortTh(label, key) {
  const on = SORT.key === key;
  return `<span data-sort="${key}" title="点击排序" style="cursor:pointer;user-select:none;white-space:nowrap;
    border-bottom:1px dotted ${on ? '#8fbaff' : 'rgba(159,182,217,.45)'};${on ? 'color:#8fbaff' : ''}">${label}${on ? (SORT.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>`;
}
function sorted(rows) {
  const f = SORT.key && SORT_KEYS[SORT.key];
  if (!f) return rows;
  const d = SORT.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = f(a), y = f(b);
    return (x < y ? -1 : x > y ? 1 : 0) * d;
  });
}
function filtered() {
  /* 默认异常 → 离线 → 在线（用户裁定 2026-08-30：把要处理的先选出来）。
     只是未点表头时的缺省序：sorted() 一旦有 SORT.key 会整体重排，互不干扰；
     sort 稳定，同状态内保持数据层原序。 */
  const rank = d => d.status === '异常' ? 0 : d.status === '离线' ? 1 : 2;
  return dsList().filter(d =>
    (st.type === '全部' || d.type === st.type) &&
    (st.region === '全部' || d.region === st.region) &&
    (st.vendor === '全部' || d.vendor === st.vendor) &&
    (st.status === '全部' || d.status === st.status) &&
    (!st.kw || d.id.includes(st.kw) || d.name.includes(st.kw)))
    .sort((a, b) => rank(a) - rank(b));
}

/* ---------- 首屏（与 legacy render() 同构） ---------- */
const all0 = dsList();
const D = stats(all0);
const dash = v => D.total ? v : '—';
st.sel = (st.sel && all0.find(d => d.id === st.sel.id)) || all0[0] || null;
const noData = !D.total;
const kpiList = [
  { label: '设备总数', value: dash(U.num(D.total)), color: 'blue', icon: 'device', desc: noData ? '正式接口未连通' : '在线 + 离线 + 异常' },
  { label: '在线数', value: dash(U.num(D.online)), color: 'green', icon: 'check', desc: noData ? '—' : `在线率 ${D.onlineRate}%` },
  { label: '离线数', value: dash(U.num(D.offline)), color: 'gray', icon: 'alert', desc: noData ? '—' : `离线率 ${D.offlineRate}%` },
  { label: '异常数', value: dash(U.num(D.abnormal)), color: 'red', icon: 'alert', desc: noData ? '—' : `异常率 ${D.abnormalRate}%` },
  { label: '告警中设备', value: dash(U.num(D.alarm)), color: 'amber', icon: 'alert', desc: '含在上述状态内，非独立分类' },
  { label: '接入厂家数', value: dash(U.num(D.vendors)), color: 'purple', icon: 'api', desc: noData ? '—' : `设备型号 ${D.models} 种` }
];
const mgrSub = DS.mode === 'mock' ? '模拟数据源 · 非真实感知结果'
  : DS.mode === 'replay' ? '回放 · 原始录制时间 ' + snapKey() + ' · 只读'
    : '实时 · 正式接口' + (probeOk() ? '已连通' : '未连通');
const mgrBody = `<div class="toolbar">
    ${U.field('设备类型', U.select('type', ['全部', ...TYPES], st.type))}
    ${U.field('所属区域', U.select('region', ['全部', ...M.DISTRICTS.map(d => d.name)], st.region))}
    ${U.field('供应商', U.select('vendor', ['全部', ...VENDORS], st.vendor))}
    ${U.field('在线状态', U.select('status', ['全部', '在线', '离线', '异常'], st.status))}
    <input class="ip" id="dvKw" style="width:170px" placeholder="请输入设备编号/名称" value="${st.kw}">
    <button class="btn pri" id="dvAdd" ${writable() ? '' : 'disabled'}>${U.icon('plus')} 新增设备</button>
    <button class="btn" id="dvImp" ${writable() ? '' : 'disabled'}>⭱ 批量导入</button>
    <button class="btn" id="dvExp">${U.icon('download')} 导出</button>
  </div>
  <div id="dvList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

function list() {
  const rows = sorted(filtered());
  const page = rows.slice((st.page - 1) * st.size, st.page * st.size);
  totalCount.value = rows.length;
  const ro = !writable();
  return U.table([
    { t: sortTh('设备编号', 'id'), w: '112px', cls: 'num', render: d => d.id.slice(-9) },
    {
      t: sortTh('设备名称', 'name'), w: '124px',
      render: d => `<div title="${d.name}" style="white-space:normal;line-height:1.4">${d.disabled
        ? `<span style="color:var(--txt-3)">${d.name}</span> <span class="tag t-gray">已停用</span>` : d.name}</div>`
    },
    { t: sortTh('类型 / 通道', 'type'), w: '142px', render: d => `${U.tag(d.type, 't-cyan')} <span style="color:var(--txt-3)">${d.channel}</span>` },
    {
      t: sortTh('产权单位 / 位置', 'owner'), w: '164px',
      render: d => `<div style="white-space:normal;line-height:1.4">${d.owner}</div>
        <div title="${d.addr}" style="font-size:11px;color:var(--txt-3);white-space:normal;line-height:1.4;
          max-height:31px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${d.addr}</div>`
    },
    {
      t: sortTh('型号 / 供应商', 'vendor'), w: '128px', priority: 'optional',
      render: d => `<div title="${d.model}" style="white-space:normal;line-height:1.4;font-size:11.5px;
          max-height:33px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${d.model}</div>
        <div style="font-size:11px;color:var(--txt-3)">${d.vendor}</div>`
    },
    {
      t: sortTh('状态', 'status'), w: '76px',
      render: d => `<span style="color:${d.status === '在线' ? '#79e5a5' : d.status === '离线' ? '#a8bcd8' : '#ff8b95'}">${U.dotState(d.status)}</span>`
    },
    { t: '健康', w: '72px', render: d => U.tag(d.health) },
    { t: sortTh('最后心跳', 'hb'), w: '78px', cls: 'num', priority: 'optional', render: d => d.hb.slice(11) },
    {
      t: '操作', w: '132px', render: d => `<span class="lnk" data-op="view|${d.id}">查看</span>` +
        (ro ? `<span class="lnk" style="color:var(--txt-3);cursor:not-allowed" title="非 Mock 数据源不可写">编辑</span>
           <span class="lnk" style="color:var(--txt-3);cursor:not-allowed" title="非 Mock 数据源不可写">停用</span>`
          : `<span class="lnk" data-op="edit|${d.id}">编辑</span><span class="lnk" data-op="stop|${d.id}">${d.disabled ? '启用' : '停用'}</span>`)
    }
  ], page, { rowId: d => d.id, activeId: st.sel && st.sel.id });
}

function detail() {
  const d = st.sel;
  if (!d) return `<div class="empty">${DS.mode === 'live'
    ? '正式接口未连通，无设备数据<br><span style="font-size:11.5px">页面逻辑未变，仅 Adapter 取数失败</span>' : '请选择设备'}</div>`;
  const tabs = [['pos', '位置概览'], ['base', '基础参数'], ['api', '接口信息'], ['zone', '所属区域']];
  let body = '';
  if (st.tab === 'pos') {
    body = `<div id="dvMap" style="height:200px;margin-bottom:12px;border:1px solid var(--line-2);border-radius:6px"></div>
      ${U.kv([['经度', `<span class="mono">${d.lon.toFixed(6)}° E</span>`], ['纬度', `<span class="mono">${d.lat.toFixed(6)}° N</span>`],
    ['安装高度', d.alt + ' m'], ['坐标系', M.CONF.coordSys], ['安装位置', d.addr], ['所属区域', d.region]], { surface: true, density: 'compact' })}`;
  } else if (st.tab === 'base') {
    body = U.kv([['设备型号', d.model], ['设备品类', d.cat], ['供应商', d.vendor], ['产权单位', d.owner],
    ['接入通道', d.channel], ['安装时间', d.installed], ['工作频段', d.freq], ['覆盖半径', d.cover],
    ['固件版本', d.fw], ['设备状态', d.status + (d.alarm ? ' · 告警中' : '')], ['健康状态', d.health],
    ['最后心跳', d.hb + `（${d.hbMin} 分钟前）`]], { surface: true, density: 'compact' });
  } else if (st.tab === 'api') {
    body = U.kv([['通信方式', d.proto], ['IP 地址', `<span class="mono">${d.ip}</span>`], ['端口', `<span class="mono">${d.port}</span>`],
    ['接入地址', `<span class="mono">${d.proto === 'TCP' ? 'tcp://' + d.ip + ':' + d.port
      : (d.port === 8443 ? 'https://' : 'http://') + d.ip + ':' + d.port + '/api/v1/data'}</span>`],
    ['鉴权方式', d.channel === '5G-A' ? 'AK/SK' : 'Token'], ['心跳间隔', '30 s'], ['上报周期', '1000 ms'],
    ['数据格式', 'JSON'], ['时钟同步', 'NTP · ntp.dongying.gov.cn'],
    ['当前时延', d.latency == null ? '—' : d.latency + ' ms'], ['丢包率', d.loss == null ? '—' : d.loss + ' %'],
    ['信号强度', d.rssi + ' dBm']], { surface: true, density: 'compact' })
      + `<div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn" style="flex:1;justify-content:center" data-dv="test">连通性测试</button>
        <button class="btn" style="flex:1;justify-content:center" onclick="location.hash='#/commission'">进入调测 →</button></div>`;
  } else {
    const near = M.airspaces.filter(a => Math.abs(a.center.lon - d.lon) < .25 && Math.abs(a.center.lat - d.lat) < .25);
    body = U.kv([['所属区域', d.region], ['覆盖空域', near.length ? near.map(a => a.name).join('<br>') : '未覆盖管制空域'],
    ['关联案件(近30天)', M.cases.filter(c => c.district === d.region).length + ' 件'],
    ['区域目标(近30天)', M.allTargets.filter(t => t.district === d.region).length + ' 个']], { surface: true, density: 'compact' });
  }
  return `<div style="padding:12px 12px 0">${U.detailHero({
      icon: 'device', subtitle: '设备详情', title: d.name, id: d.id,
      tags: [U.tag(d.status), U.tag(d.health), DS.mode === 'replay' ? U.tag('回放', 't-purple') : DS.mode === 'live' ? U.tag('实时', 't-green') : ''],
      meta: [['区域', d.region], ['通道', d.channel]]
    })}
    ${U.metricStrip([
      { label: '在线状态', value: d.status, tone: d.status === '在线' ? 'good' : d.status === '异常' ? 'bad' : 'warn', icon: 'device' },
      { label: '健康度', value: d.health, tone: d.health === '良好' ? 'good' : 'warn', icon: 'shield' },
      { label: '最后心跳', value: d.hb.slice(11), sub: d.hbMin + ' 分钟前', icon: 'clock' },
      { label: '链路时延', value: d.latency == null ? '—' : d.latency, unit: d.latency == null ? '' : 'ms', tone: d.latency != null && d.latency > 150 ? 'warn' : 'info', icon: 'trend' }
    ], { compact: true })}</div>
    <div class="tabs" style="padding:0 12px">${tabs.map(([k, t]) => `<span class="tab ${st.tab === k ? 'on' : ''}" data-tab="${k}">${t}</span>`).join('')}</div>
    <div style="padding:12px">${body}</div>`;
}

function paintDetail() {
  document.getElementById('dvDetail').innerHTML = detail();
  if (map) { map.destroy(); map = null; }
  const el = document.getElementById('dvMap');
  if (st.tab === 'pos' && el && st.sel) {
    map = new window.MapView(el, { zoom: 2.4, maxDev: 30, layers: { track: false, alarm: false }, legend: false });
    map.setData({ airspaces: M.airspaces, devices: [st.sel], targets: [], alarms: [] });
    const p = [st.sel.lon, st.sel.lat];
    setTimeout(() => { if (map) map.centerAt(p[0], p[1]); }, 30);
  }
}
function paint() { document.getElementById('dvList').innerHTML = list(); paintDetail(); }

function addModal() {
  openFormModal({
    title: '新增设备', width: '640px', columns: 2,
    warning: '设备接入需同时登记 <b>协议、鉴权、上报频率、错误码、坐标基准</b>（会议纪要 §8.1），否则无法进入调测流程。',
    fields: [
      { key: 'name', label: '设备名称', placeholder: '如：东营区雷达09号' },
      { key: 'type', label: '设备类型', type: 'select', options: optionsOf(TYPES), clearable: false },
      { key: 'channel', label: '接入通道', type: 'select', options: optionsOf(['融合感知箱', 'TDOA', '5G-A']), clearable: false },
      { key: 'vendor', label: '供应商', type: 'select', options: optionsOf(VENDORS), clearable: false },
      { key: 'ip', label: 'IP 地址', placeholder: '192.168.10.45' },
      { key: 'port', label: '端口', placeholder: '8080' },
      { key: 'proto', label: '通信协议', type: 'select', options: optionsOf(['HTTP', 'TCP', 'WS']), clearable: false },
      { key: 'auth', label: '鉴权方式', type: 'select', options: optionsOf(['Token', 'AK/SK', '无']), clearable: false },
      { key: 'lon', label: '经度', placeholder: '118.582000' },
      { key: 'lat', label: '纬度', placeholder: '37.449000' }
    ],
    initial: { name: '', type: TYPES[0] || null, channel: '融合感知箱', vendor: VENDORS[0] || null, ip: '', port: '', proto: 'HTTP', auth: 'Token', lon: '', lat: '' },
    confirmText: '保存并进入调测',
    onSubmit: () => {
      closeModal();
      toast('已保存，正在跳转设备调测…', 'ok');
      setTimeout(() => location.hash = '#/commission', 600);
    }
  });
}

const MODES_NAME = () => MODES[DS.mode].name;

function onPage(p2) { st.page = p2; paint(); }
function onPageSize(s2) { st.size = s2; st.page = 1; paint(); }

onMounted(() => {
  const view = root.value;
  paint();
  /* legacy 的 mount 里 paintFooter 写入模式后缀后，route() 的 renderCrumb 会立刻
     覆盖回纯版本号 —— 净效果是导航进入本页时页脚为纯版本号（usePageChrome 已做）。
     初始加载那次后缀写入由 legacy script 的 DOMContentLoaded+setTimeout 承担。
     故这里不调 paintFooter（其定义保留，语义与 legacy 相同，切换 UI 已删无其它调用点）。 */
  U.on(view, '[data-row]', 'click', (e, el) => {
    st.sel = dsList().find(d => d.id === el.dataset.row);
    U.selectRow(view, el.dataset.row);      // 只切换选中态,列表不重建、滚动位置保持
    paintDetail();
  });
  U.on(view, '[data-tab]', 'click', (e, el) => { st.tab = el.dataset.tab; paintDetail(); });
  U.on(view, '[data-sort]', 'click', (e, el) => {
    const k = el.dataset.sort;
    if (SORT.key === k) SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
    else { SORT.key = k; SORT.dir = 'asc'; }
    st.page = 1;
    document.getElementById('dvList').innerHTML = list();
  });
  /* 分页交互已由模板层 <n-pagination> 受控接管（P2），[data-pg]/[data-size] 委托删除 */
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; paint(); });
  U.on(view, '[data-op]', 'click', (e, el) => {
    e.stopPropagation();
    const [op, id] = el.dataset.op.split('|');
    st.sel = dsList().find(d => d.id === id);
    if (op === 'view') { paint(); return; }
    if (!guardWrite(op === 'edit' ? '编辑设备' : '停用/启用设备')) return;
    if (op === 'edit') toast('编辑设备 ' + id + '（Demo）；正式环境 PUT /api/v1/device/' + id);
    else {
      st.sel.disabled = !st.sel.disabled;
      replayCache = {};        // 台账变了,历史快照需按新台账重算
      paint();
      toast(st.sel.disabled
        ? `已停用「${st.sel.name}」，该设备数据不再参与融合计算（台账保留）`
        : `已重新启用「${st.sel.name}」`, st.sel.disabled ? 'err' : 'ok');
    }
  });
  U.on(view, '[data-dv]', 'click', () => toast(
    DS.mode === 'live' ? '正式接口未连通，无法发起连通性测试'
      : DS.mode === 'replay' ? '历史回放为只读视图，连通性测试针对当前时刻，请先切回 Mock 数据源'
        : '连通性测试：TCP 握手成功，心跳正常，往返时延 ' + (st.sel.latency || 0) + ' ms',
    DS.mode === 'mock' ? 'ok' : 'err'));
  document.getElementById('dvKw').oninput = e => { st.kw = e.target.value.trim(); st.page = 1; document.getElementById('dvList').innerHTML = list(); };
  document.getElementById('dvAdd').onclick = () => { if (guardWrite('新增设备')) addModal(); };
  document.getElementById('dvImp').onclick = () => { if (guardWrite('批量导入')) toast('支持 Excel 批量导入设备台账（模板含编号/型号/坐标/协议字段）'); };
  document.getElementById('dvExp').onclick = () => toast(`已导出「设备台账.xlsx」共 ${filtered().length} 条（数据源：${MODES_NAME()}${DS.mode === 'replay' ? ' @ ' + snapKey() : ''}）`, 'ok');
  document.getElementById('dvGoMon').onclick = () => location.hash = '#/monitor';
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <UKpis :list="kpiList" />
    <!-- 操作引导（用户裁定 2026-08-30：设备管理/设备监测/证据管理补黄字引导） -->
    <div class="warnbox" style="margin:12px 0 0;padding:8px 11px;font-size:12px">
      演示动线：列表默认<b>异常 / 离线设备排前面</b> → 点任一行，右侧看设备详情与运行指标 →
      右上「<b>实时监测 ›</b>」跳到该设备的实时监测页。</div>
    <!-- 284 → 330：引导条实占约 46px，不补偿会底部溢出；min-height 同步 608 → 562 -->
    <div class="row" style="margin-top:12px;height:calc(100vh - 330px);min-height:562px;padding-bottom:12px">
      <UPanel title="设备管理" panel-style="flex:6;min-width:0" nopad :sub="mgrSub">
        <div style="display:contents" v-html="mgrBody"></div>
          <!-- P2：分页器换 n-pagination（受控），容器样式内联复刻旧 .pager 观感 -->
          <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;min-height:42px;
            background:rgba(8,19,32,.54);border-top:1px solid rgba(130,174,218,.10);flex:none">
            <n-pagination :page="st.page" :page-size="st.size" :item-count="totalCount"
              show-size-picker :page-sizes="[10, 20, 50]"
              @update:page="onPage" @update:page-size="onPageSize">
              <template #prefix>共 {{ totalCount.toLocaleString() }} 条</template>
              <template #suffix>共 {{ pageCount }} 页</template>
            </n-pagination>
          </div>
      </UPanel>
      <UPanel title="设备详情预览" panel-style="flex:4;min-width:0" nopad
        extra='<span class="lnk" id="dvGoMon">实时监测 ›</span>'
        body-style="padding:0;display:flex;flex-direction:column"
        body-html='<div id="dvDetail" style="flex:1;overflow:auto"></div>' />
    </div>
  </div>
</template>
