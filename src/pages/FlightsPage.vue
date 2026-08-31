<script>
/* 模块级状态：跨导航保持（legacy 约定）。
   tab/tabHash 的语义见 syncTabByRoute —— risk 别名预置 events 页签，
   但从导航正常进入 flights 时要按路由回到 route。 */
const S = {
  /* 状态默认「待执行」（用户裁定 2026-08-30：和合法性页一样，把要处理的先选出来）——
     待执行是唯一还有动作可做的档；深链跳入时既有逻辑已重置为「全部」，不受影响。 */
  st: { page: 1, size: 10, status: '待执行', partner: '全部', region: '全部', kw: '', sel: null, hlRisk: null },
  tab: 'route',
  tabHash: ''
};
export default {};
</script>

<script setup>
/* 飞行活动管理（飞行计划 / 全部风险事件）—— 转换页（源：legacy pages/flights.js）。
   同一组件承接 flights / risk / airspace 三个路由 key：syncTabByRoute 按当前
   路由预置页签（#/risk → events），复刻 legacy 别名代理语义。
   「全部风险事件」页签整体委托 legacy g.RISK_IMPL（risk.js，字节保留）——
   状态机与写入口只有一份。四组 U.regParams 仍由 legacy script 模块加载期执行。 */
import { ref, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '../shell/usePageChrome.js';

const M = window.MOCK, U = window.UI;
const root = ref(null);
const st = S.st;
let map = null;

/* usePageChrome 需要当前 key（面包屑组/标题由 router afterEach 管，这里只管
   crumbCtx/openGrp/页脚/卸载清理，三个别名同属「飞行监管」组，用 flights 即可） */
usePageChrome('flights');
onUnmounted(() => {
  if (window.RISK_IMPL && window.RISK_IMPL.destroy) window.RISK_IMPL.destroy();
  if (map) map.destroy(); map = null;
});

/* ---- F0305 对照阈值（与 legacy 同构） ---- */
const DEV_TH = {
  lateral: { ok: 300, warn: 500, unit: 'm', name: '横向偏航' },
  timeMin: { ok: 10, warn: 20, unit: 'min', name: '时间偏差' },
  altDelta: { ok: 0, warn: 20, unit: 'm', name: '高度偏差' }
};
const DEV_C = { '正常': 't-green', '提示': 't-amber', '超限': 't-red', '不可判定': 't-gray' };
function devJudge(key, val) {
  if (val == null) return '不可判定';
  const th = DEV_TH[key], v = Math.abs(val);
  return v <= th.ok ? '正常' : v <= th.warn ? '提示' : '超限';
}
function devVerdict(p) {
  if (!p.deviation) return null;
  const items = Object.keys(DEV_TH).map(k => ({ k, val: p.deviation[k], lv: devJudge(k, p.deviation[k]) }));
  const judged = items.filter(i => i.lv !== '不可判定');
  const undet = items.filter(i => i.lv === '不可判定');
  const worst = judged.some(i => i.lv === '超限') ? '超限'
    : judged.some(i => i.lv === '提示') ? '提示'
      : judged.length ? '正常' : '不可判定';
  return { items, judged, undet, worst };
}
const devColor = lv => lv === '超限' ? '#ff8b95' : lv === '提示' ? '#ffd07a'
  : lv === '不可判定' ? '#8ca0be' : '#79e5a5';
const UNDET_WHY = { lateral: '无航线几何数据（航路点/走廊宽度未接入），横向偏航无判据可依' };

function filtered() {
  return M.flightPlans.filter(p =>
    (st.status === '全部' || p.status === st.status) &&
    (st.partner === '全部' || p.partner === st.partner) &&
    (st.region === '全部' || p.region === st.region) &&
    (!st.kw || p.id.includes(st.kw) || p.pilot.includes(st.kw) || p.droneId.includes(st.kw)));
}

const setTabRoute = t => { S.tab = t; S.tabHash = (location.hash || '').split('?')[0]; };
function syncTabByRoute() {
  const h = (location.hash || '').split('?')[0];
  if (h === S.tabHash) return;
  S.tabHash = h;
  S.tab = h.indexOf('#/risk') === 0 ? 'events' : 'route';
}
const TABS = [['route', '按航线看'], ['events', '全部风险事件']];
function tabBar() {
  return `<div class="tabs" style="margin-bottom:10px">${TABS.map(([k, t]) =>
    `<span class="tab ${S.tab === k ? 'on' : ''}" data-fltab="${k}" tabindex="0">${t}${
      k === 'events' ? ` <span style="color:var(--txt-3);font-size:11px">${M.riskEvents.length}</span>` : ''}</span>`).join('')}</div>`;
}

function render() {
  syncTabByRoute();
  if (S.tab === 'events') return tabBar() + window.RISK_IMPL.render();
  const ctx = U.consume('flights');
  if (ctx && ctx.plan) {
    const hit = M.flightPlans.find(p => p.id === ctx.plan);
    if (hit) {
      st.sel = hit; st.status = '全部'; st.partner = '全部'; st.region = '全部'; st.kw = '';
      const idx = filtered().findIndex(x => x.id === hit.id);
      if (idx >= 0) st.page = Math.max(1, Math.ceil((idx + 1) / st.size));
    }
  }
  // safe-default: 默认选中项跟随当前筛选（待执行视图选首条待执行计划），用户可见可改
  st.sel = st.sel || filtered()[0] || M.flightPlans[0];
  const F = M.flightPlans;
  const cnt = s => F.filter(p => p.status === s).length;
  const unmatched = F.filter(p => p.matched === '未匹配感知目标').length;
  return `${tabBar()}${U.kpis([
    { label: '今日报备计划', value: U.num(F.length), color: 'blue', icon: 'plan', desc: `来自上级管控平台 ${F.filter(p => p.source === '上级管控平台').length} 条` },
    { label: '执行中', value: U.num(cnt('执行中')), color: 'cyan', icon: 'radar', desc: '正在空中作业' },
    { label: '待执行', value: U.num(cnt('待执行')), color: 'purple', icon: 'check', desc: '未到窗口期' },
    { label: '已完成', value: U.num(cnt('已完成')), color: 'green', icon: 'check', desc: `完成率 ${U.pct(cnt('已完成'), F.length)}` },
    { label: '计划未匹配到目标', value: U.num(unmatched), color: 'amber', icon: 'alert', desc: '有计划无感知，需核查' },
    { label: '偏离报备计划', value: U.num(F.filter(p => { const v = devVerdict(p); return v && v.worst === '超限'; }).length), color: 'red', icon: 'alert', desc: `偏航>${DEV_TH.lateral.warn}m / 时差>${DEV_TH.timeMin.warn}min / 超高>${DEV_TH.altDelta.warn}m` }
  ])}

  <div class="row" style="margin-top:12px;height:max(812px, calc(100vh - 332px))">
    ${U.panel({
    title: '飞行计划与活动', style: 'flex:1.1', nopad: true,
    body: `<div class="toolbar">
        ${U.field('状态', U.select('status', ['全部', '待执行', '执行中', '已完成', '已终止'], st.status))}
        ${U.field('合作方', U.select('partner', ['全部', ...M.PARTNERS.map(p => p.name)], st.partner))}
        ${U.field('区域', U.select('region', ['全部', ...M.DISTRICTS.map(d => d.name)], st.region))}
        <input class="ip" id="flKw" style="width:190px" placeholder="计划编号 / 飞手 / 无人机ID">
        <span style="flex:1"></span><button class="btn" id="flExp">${U.icon('download')} 导出</button>
      </div>
      <div id="flList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`
  })}
    <div class="col" style="flex:1;min-width:560px;display:grid;grid-template-rows:320px minmax(460px,1fr);gap:var(--gap)">
      ${U.panel({
    title: '航线周边态势', style: 'min-height:0', nopad: true,
    bodyStyle: 'padding:6px',
    sub: `<span id="flMapRoute"></span>`,
    body: `<div id="flMapSum" style="flex:none;padding:2px 4px 5px;font-size:12px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis"></div>
      <div id="flMap" style="flex:1;min-height:0"></div>
      <div id="flMapNote" style="flex:none;height:19px;line-height:19px;font-size:10.5px;color:var(--txt-3);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>`
  })}
      ${U.panel({
    title: '计划详情', style: 'flex:3;min-height:0', nopad: true, extra: `<span id="flSt"></span>`,
    body: `<div id="flDetail" style="flex:1;overflow:auto;padding:12px"></div>`
  })}
    </div>
  </div>

  </div>`;
}

function list() {
  const rows = filtered(), page = rows.slice((st.page - 1) * st.size, st.page * st.size);
  return U.table([
    { t: '计划编号', w: '116px', cls: 'num', render: p => p.id.slice(-10) },
    { t: '计划时段', w: '146px', render: p => `<div class="mono" style="font-size:11.5px">${p.start.slice(11, 16)} ~ ${p.end.slice(11, 16)}</div><div style="font-size:11px;color:var(--txt-3)">${p.durMin} 分钟</div>` },
    { t: '最大高度', w: '82px', cls: 'num', render: p => p.maxAlt + ' m' },
    {
      t: '状态 / 匹配', w: '86px',
      render: p => `<div>${U.tag(p.status)}</div><div style="margin-top:2px">${p.matched === '已匹配'
        ? U.tag('已匹配', 't-green') : (p.matched === '—' ? '<span style="color:var(--txt-3)">—</span>' : U.tag('未匹配', 't-amber'))}</div>`
    },
    {
      t: '偏航/时差', w: '116px', align: 'right', cls: 'num', render: p => {
        const v = devVerdict(p);
        if (!v) return '<span style="color:var(--txt-3)">—</span>';
        const d = p.deviation;
        if (!d) return '<span style="color:var(--txt-3)" title="已匹配但无对照数据（数据层不一致）">—</span>';
        const lat = d.lateral == null
          ? `<span style="color:var(--txt-3)" title="${UNDET_WHY.lateral}">—</span>`
          : d.lateral + 'm';
        const tm = d.timeMin == null ? '—' : (d.timeMin > 0 ? '+' : '') + d.timeMin + 'min';
        return `<span style="color:${devColor(v.worst)}">${lat} / ${tm}</span>`;
      }
    },
    {
      t: '来源', w: '76px',
      render: p => `<div title="${p.source}" style="white-space:normal;line-height:1.4;font-size:11.5px">${p.source}</div>`
    }
  ], page, { rowId: p => p.id, activeId: st.sel && st.sel.id }) + U.pager({ total: rows.length, page: st.page, size: st.size });
}

function detail() {
  const p = st.sel;
  if (!p) return '<div class="empty">请选择计划</div>';
  document.getElementById('flSt').innerHTML = U.tag(p.status);
  const linked = M.todayTargets.filter(t => t.district === p.region && t.legal === '合法').slice(0, 2);
  return `<div class="warnbox" style="margin:0 0 10px;padding:6px 10px;font-size:11.5px;line-height:1.6">
    在左侧列表点选计划：本卡与上方「航线周边态势」地图联动更新，
    卡内下方「<b>本航线风险</b>」同步列出沿线风险事件，可逐条「通知上级」。</div>
  ${U.detailHero({
    icon: 'plan', variant: 'compact', subtitle: '飞行计划', title: p.purpose || p.route, id: p.id,
    tags: [U.tag(p.status), U.tag(p.matched, p.matched === '已匹配' ? 't-green' : 't-amber')]
  })}
    ${U.metricStrip([
      { label: '执行状态', value: p.status, tone: p.status === '已完成' ? 'good' : 'info', icon: 'play' },
      { label: '计划时长', value: p.durMin, unit: 'min', icon: 'clock' },
      { label: '最大高度', value: p.maxAlt, unit: 'm', icon: 'trend' },
      { label: '目标匹配', value: p.matched, tone: p.matched === '已匹配' ? 'good' : 'warn', icon: 'link' }
    ], { compact: true })}
    ${U.sect('计划信息', U.kv([
    ['无人机ID', `<span class="mono">${p.droneId}</span>`], ['机型', p.model],
    ['所属单位', p.partner], ['飞手', p.pilot + '（执照 ' + p.pilotLic + '）'],
    ['作业用途', p.purpose], ['申报区域', p.region],
    ['起飞点', `<span class="mono">${p.takeoff.lon}°E, ${p.takeoff.lat}°N</span>`],
    ['计划时段', p.start + ' ~ ' + p.end], ['最大高度', p.maxAlt + ' m'],
    ['航线', p.route], ['计划来源', p.source]
  ], { surface: true, density: 'compact' }), { icon: 'plan' })}
    ${U.sect('审批信息', U.kv([['审批单位', p.approver], ['审批时间', p.approvedAt], ['审批结论', U.tag('已批准', 't-green')]], { surface: true, density: 'compact' }), { icon: 'check' })}
    ${(function () {
      if (p.matched === '—') return U.sect('<span title="F0305 · C01">计划与实际对照</span>', '<div class="empty" style="padding:10px">计划尚未开始执行</div>');
      if (p.matched !== '已匹配') return U.sect('<span title="F0305 · C01">计划与实际对照</span>',
        `<div class="warnbox">该计划时段内<b>未匹配到感知目标</b>，可能为：未按计划起飞、目标在探测盲区、或设备异常。建议人工核实。</div>
         ${U.kv([['匹配依据', '时间窗 ±10min + 空间 500m + 身份一致'], ['处理建议', '联系飞手核实 / 检查区域设备状态']])}`);
      const v = devVerdict(p), d = p.deviation;
      if (!d) return U.sect('<span title="F0305 · C01">计划与实际对照</span>',
        `<div class="warnbox" style="border-color:rgba(255,176,32,.45);background:rgba(255,176,32,.08);line-height:1.85">
          注意：该计划标记为<b>已匹配</b>，但<b>没有对照数据</b>（<span class="mono">deviation</span> 为空）。<br>
          <span style="color:var(--txt-3)">"已匹配"意味着找到了对应的感知目标，那就应当能算出偏航/时差/超高三项。
          两者同时成立是数据层的不一致，已提请核查 —— 此处不显示"与报备一致"，因为那是一个我们并没有做出的判断。</span></div>`);
      const row = (k, txt) => {
        const it = v.items.find(x => x.k === k);
        if (it.lv === '不可判定') return [DEV_TH[k].name,
          `<span style="color:var(--txt-3)">—</span>　${U.tag('不可判定', 't-gray')}
           <div style="font-size:11px;color:var(--txt-3);line-height:1.7;margin-top:2px">${UNDET_WHY[k] || '无判据可依'}</div>`];
        return [DEV_TH[k].name, `<b class="mono" style="color:${devColor(it.lv)}">${txt}</b>　${U.tag(it.lv, DEV_C[it.lv])}`];
      };
      return U.sect('<span title="F0305 · C01">计划与实际对照</span>',
        U.kv([
          ['匹配目标', linked.length ? linked.map(t => `<span class="mono">${t.id}</span>`).join('<br>') : '—'],
          ['匹配依据', '时间窗 ±10min + 空间 500m + 身份一致'],
          row('lateral', d.lateral + ' m'),
          row('timeMin', (d.timeMin > 0 ? '晚 ' : d.timeMin < 0 ? '早 ' : '') + Math.abs(d.timeMin) + ' min'),
          row('altDelta', (d.altDelta > 0 ? '高于报备 ' : d.altDelta < 0 ? '低于报备 ' : '') + Math.abs(d.altDelta) + ' m（报备 ' + p.maxAlt + ' m）'),
          ['对照结论', (v.worst === '超限'
            ? '<span class="tag t-red">偏离报备计划</span> <span style="color:var(--txt-3);font-size:11.5px">建议转合法性判定</span>'
            : v.worst === '提示' ? '<span class="tag t-amber">轻微偏离</span> <span style="color:var(--txt-3);font-size:11.5px">持续观察</span>'
              : v.worst === '不可判定' ? '<span class="tag t-gray">不可判定</span> <span style="color:var(--txt-3);font-size:11.5px">全部对照项均无判据</span>'
                : '<span class="tag t-green">与报备一致</span>')
            + (v.undet.length ? `<div style="font-size:11px;color:#ffd07a;margin-top:3px;line-height:1.7">
                注意：本次对照有 ${v.undet.length} 项不可判定（${v.undet.map(i => DEV_TH[i.k].name).join('、')}），
                未计入上述结论 —— 不可判定不等于合规</div>` : '')]
        ]) + `<div style="font-size:11px;color:var(--txt-3);margin-top:6px">
          判定阈值：偏航 ≤${DEV_TH.lateral.ok}m 正常 / ≤${DEV_TH.lateral.warn}m 提示；
          时差 ≤${DEV_TH.timeMin.ok}min 正常 / ≤${DEV_TH.timeMin.warn}min 提示；
          超高 ≤${DEV_TH.altDelta.warn}m 提示。均为 Demo 缺省值，待业务方确认（C01/C02）。</div>`);
    })()}
    ${routeRiskSect(p)}
    ${p.status === '待执行' ? U.detailActions(`<button class="btn pri" style="flex:1;justify-content:center" data-fl="legal">合法性判定 →</button>`) : ''}`;
}

/* ===== 本航线风险（与 legacy 同构） ===== */
const NEAR_DAYS = 7;
const RISK_NEAR_KM = 5;
const routeOf = p => (M.routesOf ? (M.routesOf(p.id) || [])[0] : null)
  || (M.routes || []).find(r => (r.planIds || []).includes(p.id)) || null;

function distToRouteKm(pt, r) {
  let best = Infinity;
  for (let i = 1; i < r.waypoints.length; i++) {
    const a = r.waypoints[i - 1], b = r.waypoints[i];
    const ax = a.lon * 88.5, ay = a.lat * 111, bx = b.lon * 88.5, by = b.lat * 111;
    const px = pt.lon * 88.5, py = pt.lat * 111;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - (ax + dx * t), py - (ay + dy * t)));
  }
  return best;
}
function hazardsNear(r) {
  if (!r) return [];
  const halfKm = (r.widthM / 2 + (r.widthTolM || 0)) / 1000;
  const buf = RISK_NEAR_KM;
  const from = M.util.ymd(M.util.dayAdd(M.CONF.demoTime, -(NEAR_DAYS - 1)));
  return (M.riskEvents || []).filter(e => e.ymd >= from && distToRouteKm(e, r) <= halfKm + buf)
    .map(e => Object.assign({ _d: +distToRouteKm(e, r).toFixed(2) }, e))
    .sort((a, b) => a._d - b._d);
}
function zonesAlong(r) {
  if (!r) return [];
  const inPoly = (lon, lat, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return M.airspaces.filter(a => a.status === '生效中' && r.waypoints.some(w => inPoly(w.lon, w.lat, a.poly)));
}

function routeRiskSect(p) {
  if (['已完成', '已终止', '已取消'].includes(p.status))
    return U.sect('本航线风险', `<div style="color:var(--txt-3);font-size:12px;line-height:1.7">
      计划已${p.status}，不再显示航线风险预检 —— 该预检用于起飞前研判走廊沿线是否有异物，
      对已结束的计划没有意义。<br>历史风险事件仍可在「全部风险事件」页签按时间查阅。</div>`);
  const r = routeOf(p);
  if (!r) return U.sect('本航线风险', `<div style="color:var(--txt-3);font-size:12px">
    该计划未关联航线走廊，无法计算沿线风险。</div>`);
  const halfKm = (r.widthM / 2 + (r.widthTolM || 0)) / 1000;
  const list2 = hazardsNear(r);
  const inCor = list2.filter(e => e._d <= halfKm);
  const near = list2.filter(e => e._d > halfKm);
  if (!list2.length) return U.sect(`本航线风险（近 ${NEAR_DAYS} 天）`,
    `<div class="inline-icon" style="color:#79e5a5;font-size:12.5px">${U.icon('check')} 走廊内与 ${RISK_NEAR_KM} km 邻近范围内无风险事件</div>`);
  const row = (e, lv) => {
    const nx = ((M.riskNext ? M.riskNext(e.status) : []) || []).filter(t => t.to === '已通知');
    return `<div data-flrisk-hl="${e.id}" class="flrisk-row${st.hlRisk === e.id ? ' on' : ''}"
      title="点击在上方地图高亮该风险">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
        <span style="font-size:12.5px">${U.tag(lv, lv === '走廊内' ? 't-red' : 't-amber')}
          ${e.type}${e.subtype ? '（' + e.subtype + '）' : ''} ×${e.count}
          <span class="mono lnk" data-flrisk-go="${e.id}">${e.id.slice(-6)}</span></span>
        <span class="mono" style="color:var(--txt-3);font-size:11px">距中心线 ${e._d} km · ${e.alt}m</span></div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
        ${U.tag(e.status)}
        ${nx.length
        ? nx.map(t => `<button class="btn" style="padding:2px 8px;font-size:11px"
            data-flrisk-to="${e.id}|${t.to}" title="${e.status} → ${t.to}">${t.act}</button>`).join('')
        : '<span style="color:var(--txt-3);font-size:11px">本页仅提供「通知上级」，其余处置在「全部风险事件」页签</span>'}
      </div></div>`;
  };
  return U.sect(`本航线风险（近 ${NEAR_DAYS} 天 · 走廊内 ${inCor.length} / 邻近 ${near.length}）`,
    inCor.map(e => row(e, '走廊内')).join('') + near.map(e => row(e, '邻近')).join('')
    + `<div style="font-size:11px;color:var(--txt-3);margin-top:6px;line-height:1.7">
      走廊内 = 距中心线 ≤ 半宽 ${(r.widthM / 2 / 1000).toFixed(2)}km + 容差 ${((r.widthTolM || 0) / 1000).toFixed(2)}km；
      邻近 = 其外至 ${RISK_NEAR_KM} km。均为 Demo 缺省值，<b>待业务方确认</b>。
      处置动作与「全部风险事件」页签共用同一套状态机，此处推进即彼处推进。</div>`);
}

function paintMap() {
  if (!map) return;
  const p = st.sel;
  const sum = document.getElementById('flMapSum'), note = document.getElementById('flMapNote');
  const rn = document.getElementById('flMapRoute');
  const r = p && routeOf(p);
  if (!r) {
    map.setData({ airspaces: M.airspaces.filter(a => a.status === '生效中'), devices: [], targets: [], alarms: [] });
    map._fl = null;
    if (rn) rn.textContent = p ? '未关联航线' : '';
    if (sum) sum.textContent = '';
    if (note) note.innerHTML = p
      ? `<span style="color:#ffd07a">该计划未关联报备航线 —— 无走廊几何，周边异物无法按航线统计</span>`
      : '';
    return;
  }
  const hz = hazardsNear(r), zs = zonesAlong(r);
  const forbid = zs.filter(a => (M.airspaceType ? M.airspaceType(a.type).forbidsAllPlans : a.type === '禁飞空域'));
  map._fl = { route: r, hz };
  map.setData({ airspaces: zs.length ? zs : M.airspaces.filter(a => a.status === '生效中'), devices: [], targets: [], alarms: [] });
  const w = r.waypoints[Math.floor(r.waypoints.length / 2)];
  map.centerAt(w.lon, w.lat);
  if (rn) rn.textContent = `${r.id} ${r.name}`;
  if (sum) sum.innerHTML = `穿越空域 <b style="color:${forbid.length ? '#ff8b95' : '#cfe0f8'}">${zs.length}</b>`
    + (forbid.length ? `<span style="color:#ff8b95">（含禁止类 ${forbid.length}）</span>` : '')
    + ` · 近${NEAR_DAYS}天异物 <b style="color:${hz.length ? '#ffd07a' : '#79e5a5'}">${hz.length}</b> 起`;
  if (note) note.innerHTML = hz.length
    ? `最近一起 ${hz[0].type}${hz[0].subtype ? '（' + hz[0].subtype + '）' : ''} ×${hz[0].count}，距走廊中心线 ${hz[0]._d} km，${hz[0].time.slice(5, 16)}`
    : `<span style="color:#79e5a5">近 ${NEAR_DAYS} 天走廊沿线（半宽+容差+2km 缓冲内）无异物活动记录</span>`;
}

function revealHazard(id) {
  if (!map || !map._fl) return;
  const e = (map._fl.hz || []).find(x => x.id === id);
  if (!e) return;
  const q = map.px(e.lon, e.lat), pad = 60;
  if (q[0] >= pad && q[0] <= map.w - pad && q[1] >= pad && q[1] <= map.h - pad) return;
  map.centerAt(e.lon, e.lat);
}

function paint() {
  document.getElementById('flList').innerHTML = list();
  document.getElementById('flDetail').innerHTML = detail();
  paintMap();
}

function mountRoute(view) {
  U.on(view, '[data-flrisk-to]', 'click', (e, el) => {
    const [id, to] = el.dataset.flriskTo.split('|');
    const ev = (M.riskEvents || []).find(x => x.id === id);
    if (!ev) return;
    const rec = { act: '（航线视角）' + to, result: '经飞行活动管理·本航线风险发起', evidence: '事件全量记录' };
    window.RISK_IMPL.advance(ev, to, rec, () => window.APP.rerender());
  });
  U.on(view, '[data-flrisk-go]', 'click', (e, el) => {
    U.goto('risk', { eventId: el.dataset.flriskGo });
  });
  U.on(view, '[data-flrisk-hl]', 'click', (e, el) => {
    if (e.target.closest('[data-flrisk-go],[data-flrisk-to]')) return;
    const id = el.dataset.flriskHl;
    st.hlRisk = (st.hlRisk === id) ? null : id;
    view.querySelectorAll('[data-flrisk-hl]').forEach(n =>
      n.classList.toggle('on', n.dataset.flriskHl === st.hlRisk));
    if (st.hlRisk) revealHazard(st.hlRisk);
  });
  map = new window.MapView(document.getElementById('flMap'), {
    zoom: 3.2, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false }
  });
  const draw0 = map.draw.bind(map);
  map.draw = function () {
    draw0();
    const fl = this._fl;
    if (!fl) return;
    const c = this.ctx, r = fl.route;
    const half = (r.widthM / 2 + (r.widthTolM || 0)) / 1000;
    const L = [], R = [];
    for (let i = 0; i < r.waypoints.length; i++) {
      const a = r.waypoints[Math.max(0, i - 1)], b = r.waypoints[Math.min(r.waypoints.length - 1, i + 1)];
      let dx = (b.lon - a.lon) * 88.5, dy = (b.lat - a.lat) * 111;
      const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
      L.push([r.waypoints[i].lon + nx * half / 88.5, r.waypoints[i].lat + ny * half / 111]);
      R.push([r.waypoints[i].lon - nx * half / 88.5, r.waypoints[i].lat - ny * half / 111]);
    }
    const poly = L.concat(R.reverse()).map(q => this.px(q[0], q[1]));
    c.beginPath(); poly.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath();
    c.fillStyle = '#22d3ee22'; c.fill();
    c.setLineDash([5, 4]); c.strokeStyle = '#22d3eeaa'; c.lineWidth = 1; c.stroke(); c.setLineDash([]);
    c.beginPath();
    r.waypoints.forEach((w, i) => { const q = this.px(w.lon, w.lat); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
    c.strokeStyle = '#22d3ee'; c.lineWidth = 2; c.stroke();
    r.waypoints.forEach(w => { const q = this.px(w.lon, w.lat);
      c.beginPath(); c.arc(q[0], q[1], 3, 0, 7); c.fillStyle = '#22d3ee'; c.fill(); });
    const LVC = { '高': '#ff4d5e', '中': '#ffb020', '低': '#3d8bff' };
    (fl.hz || []).forEach(e => {
      const q = this.px(e.lon, e.lat);
      const col = LVC[e.level] || '#8ca0be';
      const ph = (this.t % 70) / 70;
      const isHl = e.id === st.hlRisk;
      if (isHl) {
        c.beginPath(); c.arc(q[0], q[1], 21, 0, 7);
        c.strokeStyle = col + '55'; c.lineWidth = 7; c.stroke();
        c.beginPath(); c.arc(q[0], q[1], 14.5 + Math.sin(this.t / 7) * 2.2, 0, 7);
        c.strokeStyle = '#fff'; c.lineWidth = 1.8; c.stroke();
      }
      c.beginPath(); c.arc(q[0], q[1], 4 + ph * 8, 0, 7);
      c.strokeStyle = col + Math.round((1 - ph) * 170).toString(16).padStart(2, '0'); c.lineWidth = 1.2; c.stroke();
      c.strokeStyle = col; c.lineWidth = 1.6;
      if (e.type === '鸟') {
        c.beginPath(); c.arc(q[0] - 3.2, q[1], 3.2, -Math.PI * .95, -Math.PI * .05); c.stroke();
        c.beginPath(); c.arc(q[0] + 3.2, q[1], 3.2, -Math.PI * .95, -Math.PI * .05); c.stroke();
      } else {
        c.beginPath(); c.moveTo(q[0], q[1] - 4.2); c.lineTo(q[0] + 4.2, q[1]);
        c.lineTo(q[0], q[1] + 4.2); c.lineTo(q[0] - 4.2, q[1]); c.closePath(); c.stroke();
      }
      if (isHl) {
        const tx = e.id.slice(-6);
        c.font = '600 11px ui-monospace,Menlo,monospace';
        const wd = c.measureText(tx).width + 12, bx = q[0] + 16, by = q[1] - 30;
        c.fillStyle = 'rgba(4,18,28,.92)';
        c.fillRect(bx, by, wd, 17);
        c.strokeStyle = col; c.lineWidth = 1; c.strokeRect(bx, by, wd, 17);
        c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(tx, bx + 6, by + 9);
      }
      (this._pickPts = this._pickPts || []).push({
        x: q[0], y: q[1], kind: 'hazard', data: e,
        tip: `<b style="color:${col}">${e.type}${e.subtype ? '（' + e.subtype + '）' : ''} ×${e.count}</b>
          <dl class="kv" style="margin-top:6px"><dt>事件</dt><dd>${e.id}</dd>
          <dt>距走廊中心线</dt><dd>${e._d} km</dd><dt>高度</dt><dd>${e.alt} m</dd>
          <dt>风险</dt><dd style="color:${col}">${e.level}</dd><dt>时间</dt><dd>${e.time.slice(5, 16)}</dd></dl>`
      });
    });
  };
  map.opt.onPick = pk => { if (pk && pk.kind === 'hazard' && window.SEARCH) window.SEARCH.goEntity('riskEvent', pk.data.id); };
  paint();
  requestAnimationFrame(paintMap);
  U.on(view, '[data-row]', 'click', (e, el) => {
    st.sel = M.flightPlans.find(p => p.id === el.dataset.row);
    U.selectRow(document.getElementById('flList'), el.dataset.row);
    document.getElementById('flDetail').innerHTML = detail();
    paintMap();
  });
  U.on(view, '[data-pg]', 'click', (e, el) => { if (el.dataset.pg) { st.page = +el.dataset.pg; paint(); } });
  U.on(view, '[data-size]', 'change', (e, el) => { st.size = parseInt(el.value); st.page = 1; paint(); });
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; paint(); });
  U.on(view, '[data-fl]', 'click', (e, el) => {
    if (el.dataset.fl !== 'legal') return;
    const p = st.sel;
    const t = p && ((M.todayTargets || []).find(x => x.alignedPlanId === p.id)
      || (M.allTargets || []).find(x => x.alignedPlanId === p.id));
    if (t) return U.goto('legality', { target: t.id });
    U.toast('该计划未匹配到感知目标，已跳转合法性判定，但无法自动选中对应目标');
    location.hash = '#/legality';
  });
  document.getElementById('flKw').oninput = e => { st.kw = e.target.value.trim(); st.page = 1; paint(); };
  document.getElementById('flExp').onclick = () => U.toast('已导出「飞行计划.xlsx」共 ' + filtered().length + ' 条', 'ok');
}

onMounted(() => {
  const view = root.value;
  view.innerHTML = render();
  /* 页签切换（与 legacy 同构）：在 #/risk 别名路由上切「按航线看」须回正到 #/flights */
  const switchTab = k => {
    S.tab = k;
    const h = (location.hash || '').split('?')[0];
    if (k === 'route' && h !== '#/flights') { location.hash = '#/flights'; return; }
    S.tabHash = h; window.APP.rerender();
  };
  U.on(view, '[data-fltab]', 'click', (e, el) => switchTab(el.dataset.fltab));
  U.on(view, '[data-fltab]', 'keydown', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(el.dataset.fltab); }
  });
  if (S.tab === 'events') return window.RISK_IMPL.mount(view);
  mountRoute(view);
});
</script>

<template>
  <div class="view" id="view" ref="root"></div>
</template>
