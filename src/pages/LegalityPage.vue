<script>
/* 模块级状态：跨导航保持（legacy 约定）。gateDone 也是模块级 —— 证据门禁每次
   会话只跑一次（legacy 同语义；门禁已下沉数据层，此处通常命中 0，属兜底探针）。 */
const S = {
  st: { page: 1, size: 10, legal: '待处理', region: '全部', sel: null },
  gateDone: false
};
export default {};
</script>

<script setup>
/* 飞行合法性判定中心 —— 转换页（源：legacy pages/legality.js 当前版）。
   ⚠ 两条 U.regParams（C03/C02P）仍由 legacy script 模块加载期登记，不重复。
   collapseAbnormal / applyEvidenceGate 在 legacy 的 render() 里执行（对共享
   数据层的归并/门禁），转换后移到本组件 setup —— 时机等价（进入页面时）。
   legacy 中已无到达路径的 evidModal / reviewModal / confirmModal / legacyDetail /
   evidSect / factorSect 不带入（同 evidence 页先例）。 */
import { ref, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '../shell/usePageChrome.js';
import UPanel from '../ui/UPanel.vue';

const M = window.MOCK, U = window.UI, CH = window.CH, EVT = window.EVT;
usePageChrome('legality');
const root = ref(null);
const st = S.st;

const OPER = { name: '系统管理员', account: 'admin', role: '超级管理员' };
const nowStr = () => M.nowStr();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const C03 = {
  ver: 'C03-demo-v1',
  w: { violation: 0.34, category: 0.10, region: 0.16, track: 0.16, source: 0.24 },
  wName: { violation: '违规项严重度', category: '目标类别', region: '区域敏感度', track: '轨迹稳定性', source: '来源可信度' },
  severity: {
    '侵入禁飞区': 1.00, '超出空域限高': 0.90, '超出空域管制时段': 0.80,
    '未经批准飞行': 0.65, '身份不匹配': 0.60, '偏离报备航线': 0.55,
    '超出计划批准高度': 0.50, '超视距飞行': 0.45, '超出计划批准时段': 0.40, '夜间飞行': 0.35
  },
  zone: { '禁飞空域': 1.00, '重点防控区域': 0.75, '临时管制区': 0.60, '限高区域': 0.55, '适飞空域': 0.20 },
  track: { '稳定': 0.00, '暂定': 0.40, '终止': 0.55, '短时丢失': 0.70 },
  category: { '无人机': 0.60, '未知': 0.85, '识别中': 0.85 },
  idMissing: 0.35,
  unproven: 0.50,
  confMin: 0.75,
  grade: [[67, '高'], [34, '中'], [0, '低']]
};
const c03Grade = v => (C03.grade.find(g => v >= g[0]) || C03.grade[C03.grade.length - 1])[1];

const LEGAL_STATUS = M.LEGAL_STATUS || ['合法', '异常', '非法', '待确认'];
const DISPLAY_STATUSES = ['合法', '非法', '待确认'];
const FORBIDDEN_SPACE = M.AIRSPACE_TYPES.filter(a => a.forbidsAllPlans).map(a => a.type);
const FORBIDDEN_VIOLATIONS = ['侵入禁飞区', '超出空域限高', '超出空域管制时段'];
const PLAN_PARAM_VIOLATIONS = ['超出计划批准高度', '超出计划批准时段', '偏离报备航线'];
const SEVERE_C02 = ['侵入禁飞区', '超出空域限高', '超出空域管制时段', '偏离报备航线'];

function enumDrift() {
  const known = M.VIOLATIONS || [];
  const mine = [...new Set([].concat(Object.keys(C03.severity), FORBIDDEN_VIOLATIONS, PLAN_PARAM_VIOLATIONS, SEVERE_C02))];
  const dup = M.allTargets.filter(t => t.violations !== undefined);
  const legalStale = M.LEGAL_STATUS
    ? LEGAL_STATUS.filter(v => M.LEGAL_STATUS.indexOf(v) < 0)
      .concat(M.LEGAL_STATUS.filter(v => LEGAL_STATUS.indexOf(v) < 0)) : [];
  return {
    stale: mine.filter(v => known.indexOf(v) < 0).concat(legalStale),
    missing: known.filter(v => C03.severity[v] == null),
    truncated: dup.length,
    truncatedSample: dup[0] || null
  };
}

const vlist = t => t.violation_reasons || [];
const hasV = (t, v) => vlist(t).indexOf(v) >= 0;
const undet = t => t.undeterminable || [];
const anyV = (t, arr) => vlist(t).some(v => arr.indexOf(v) >= 0);

const C02P = { nightFrom: 20, nightTo: 6, vlosM: 500 };
const GATE_MODE = 'identity';
const R = id => RULES.find(r => r.id === id) || { id: id, n: '(规则缺失)', d: '' };
const RULES = [
  { id: 'C01', n: '飞行计划匹配', d: '五维度比对（时间窗口/起降点/航线走廊/无人机身份/飞手单位），结果分完全命中·部分命中·未命中。'
      + '当前上限为「部分命中」：目标对象无起飞点字段，「起降点」维度恒不可判定' },
  { id: 'C02-1', n: '禁飞空域校验', d: '是否进入禁飞空域' },
  { id: 'C02-2', n: '限高校验', d: '是否超过空域限高' },
  { id: 'C02-3', n: '航线偏离校验', d: '是否偏离报备航线走廊' },
  { id: 'C02-4', n: '时间窗校验', d: '是否超出报备时段' },
  { id: 'C02-5', n: '夜间飞行校验', d: '是否处于夜间管制时段（阈值待业务方确认）' },
  { id: 'C02-6', n: '超视距校验', d: '目标与遥控源距离是否超出目视视距（依赖 pilot_position）' },
  { id: 'C03', n: '风险评分', d: '五因子加权评分，结论收敛至合法/非法/待确认' }
];

const ID_SOURCES = [
  { abbr: 'dcd', type: '协议破解', dt: 11, gives: 'uavSN 实名编号 / 机型 / 飞手位置', kind: 'sn' },
  { abbr: 'rid', type: 'RemoteID', dt: 102, gives: 'uavSN 实名编号 / 机型 / 起飞点', kind: 'sn' },
  { abbr: 'tdoa', type: 'TDOA', dt: 10, gives: '机型（uavModel）/ 遥控器位置', kind: 'model' },
  { abbr: 'aoa', type: 'AOA', dt: 9, gives: '机型（uavModel）/ 遥控器方位', kind: 'model' },
  { abbr: 'radar', type: '雷达', dt: 1, gives: '—（仅位置与航迹，无身份信息）', kind: 'none' },
  { abbr: 'oe', type: '光电', dt: 3, gives: '—（仅外形分类 A06，不构成身份）', kind: 'none' }
];
const dep = (abbr, region) => {
  const d = M.devices.filter(x => x.deviceTypeAbbr === abbr && (!region || x.region === region));
  return { total: d.length, online: d.filter(x => x.status === '在线').length };
};
const snOf = t => t.uav_sn || t.uavSN || null;
const ppOf = t => t.pilot_position || t.pilotPosition || null;

function idEvidence(t) {
  const sn = snOf(t);
  const pp = ppOf(t);
  const dev = pp && pp.device || null;
  const rows = ID_SOURCES.map(s => {
    const d = dep(s.abbr, t.district);
    let got, ok;
    if (s.kind === 'sn') {
      ok = !!sn && dev === s.type;
      got = ok ? ('已取得 uavSN ' + esc(sn))
        : (d.online
          ? (s.abbr === 'rid'
            ? '未取得（本区已部署，但当前数据源未提供 rid 上报，Q13 待确认）'
            : '未取得（该架次未被该类设备覆盖或未上报）')
          : '本区无在线设备，取不到');
    } else if (s.kind === 'model') {
      ok = dev === s.type;
      got = ok ? ('机型 ' + (t.uav_model || t.model) + ' + 遥控器' + (s.abbr === 'aoa' ? '方位' : '位置') + '（非实名）')
        : '本次未提供';
    } else { ok = false; got = '不提供身份信息'; }
    return { s, d, got, ok };
  });
  return {
    sn, rows, dev,
    full: !!sn,
    modelSrc: dev === 'TDOA' || dev === 'AOA' ? dev + ' 无线电特征比对' : '光电分类 A06 推断',
    hasPilot: !!pp,
    basis: sn ? 'uavSN 实名核验 + 时间窗 + 空间范围' : '时间窗 + 空间范围（降级）'
  };
}

const engOf = t => {
  const s = t.legalOriginal || t.legal;
  return s === '异常' ? '待确认' : s;
};
const needGate = t => t.type === '无人机' && t.legal === '非法'
  && hasV(t, '身份不匹配') && !snOf(t);
const gatedList = () => M.allTargets.filter(needGate);
const changed = r => r.from !== r.to;
const manualRevised = t => !!(t.reviewLog && t.reviewLog.some(r => changed(r) && r.account !== 'rule-engine'));
const engineDegraded = t => !!(t.reviewLog && t.reviewLog.some(r => changed(r) && r.account === 'rule-engine'));
const revised = t => manualRevised(t) || engineDegraded(t);

function judge(t) {
  const hitOf = reason => {
    const h = ((t.facts && t.facts.zoneHits) || []).find(x => x.reason === reason);
    return h ? (M.airspaces.find(a => a.id === h.id) || null) : null;
  };
  const nfzZone = hitOf('进入');
  const limZone = hitOf('超限高');
  const tgZone = hitOf('管制时段');
  const zone = limZone || nfzZone || tgZone || M.airspaces.find(a => a.region === t.district);
  const zoneBasis = z => z ? `<div style="margin-top:4px;font-size:11.5px;color:var(--txt-3)">`
    + `依据：<b style="color:var(--txt-2)">${esc(z.source)}</b>空域规则 <span class="mono">${esc(z.id)}</span>`
    + `${z.limit > 0 ? ` · 限高 ${z.limit} m（${String(z.limitDatum || 'agl').toUpperCase()}）` : ''}`
    + ` · 发布单位 ${esc(z.unit || '—')} · 更新 ${esc(z.updated || '—')}`
    + `<br>本平台<b style="color:#ffd07a">不可修改</b>，调整须走上级渠道`
    + `</div>` : '';
  const ev = idEvidence(t);
  const eng = engOf(t);

  let c01, c01msg, c01badge;
  const idClaim = hasV(t, '身份不匹配');
  const pm = (t.facts && t.facts.planMatch) || t.plan_match || null;
  const dims = (t.facts && t.facts.planMatchDims) || t.plan_match_dims || null;
  const dimLine = () => {
    if (!dims) return '';
    const mark = v => v === true ? U.stateIcon('pass', false)
      : v === false ? U.stateIcon('fail', false)
        : `<span title="无判据可依">${U.stateIcon('na', false)}</span>`;
    return '<div style="margin-top:3px;font-size:11.5px">'
      + (M.C01_DIMS || Object.keys(dims)).map(d => `${mark(dims[d])} ${d}`).join('　') + '</div>';
  };
  if (pm === '未命中') {
    c01 = 'fail';
    c01msg = '五维度均未匹配到可关联计划 —— 时空范围内无有效报备'
      + (ev.full ? `，且 uavSN <span class="mono">${esc(ev.sn)}</span> 未在报备名单内` : '') + dimLine();
  } else if (pm === '部分命中') {
    c01 = 'warn';
    const bad = dims ? (M.C01_DIMS || Object.keys(dims)).filter(d => dims[d] === false) : [];
    const unk = dims ? (M.C01_DIMS || Object.keys(dims)).filter(d => dims[d] === null) : [];
    c01msg = `<b>部分命中</b>（表10-2）：已关联到计划（${t.partner}），但`
      + (bad.length ? `<span style="color:#ff8b95">${bad.join('、')} 偏离</span>` : '')
      + (bad.length && unk.length ? '；' : '')
      + (unk.length ? `<span style="color:#ffd07a">${unk.join('、')} 不可判定</span>` : '')
      + `<br><span style="color:var(--txt-3)">部分命中<b>不直接定性</b>，偏离维度交由 C02 / C03 分别判定</span>`
      + dimLine();
  } else if (pm === '完全命中') {
    c01 = 'pass';
    c01msg = `五维度均在容差内（${t.partner}）· 依据：${ev.basis}` + dimLine();
  } else {
    c01 = 'pass';
    c01msg = `匹配到报备计划（${t.partner}）· 依据：${ev.basis}`;
  }
  c01badge = ev.full
    ? '<span class="tag t-green" title="具备 uavSN 实名核验依据">完整判定</span>'
    : '<span class="tag t-amber" title="缺 uavSN 数据源，仅时间窗 + 空间范围匹配">降级判定</span>';

  const c02a = hasV(t, '侵入禁飞区') ? 'fail' : 'pass';
  const datum = zone ? (zone.limitDatum || 'agl') : 'agl';
  const hUsed = datum === 'agl' ? t.heightAgl : t.alt;
  const hMissing = hUsed == null;
  const overH = anyV(t, ['超出空域限高', '超出计划批准高度']);
  const c02b = overH ? 'fail'
    : hMissing ? 'warn'
      : (zone && hUsed > zone.limit && zone.limit > 0 ? 'warn' : 'pass');
  const offRouteUndet = undet(t).indexOf('偏离报备航线') >= 0;
  const offRouteLabel = hasV(t, '偏离报备航线');
  const c02c = offRouteUndet ? 'warn' : (offRouteLabel ? 'fail' : 'pass');
  const overT = anyV(t, ['超出空域管制时段', '超出计划批准时段']);
  const c02d = overT ? 'fail' : 'pass';

  const hh = parseInt(t.time.slice(11, 13), 10);
  const isNight = hh >= C02P.nightFrom || hh < C02P.nightTo;
  const c02e = hasV(t, '夜间飞行') ? 'fail' : 'pass';
  const c02eMsg = hasV(t, '夜间飞行')
    ? `发现时间 ${t.time.slice(11, 19)}，判为夜间飞行`
    + (isNight ? `（夜间管制时段 ${C02P.nightFrom}:00–0${C02P.nightTo}:00，阈值待业务方确认）`
      : `<br><span style="color:#ff9aa4">注意：但该时间不在夜间管制时段内 —— 数据层结论与观测时间不一致，需核对</span>`)
    : `发现时间 ${t.time.slice(11, 19)}，`
    + (isNight ? `<span style="color:#ffd07a">处于夜间管制时段（${C02P.nightFrom}:00–0${C02P.nightTo}:00），但本次未标注夜间违规 —— 夜间是否一律受限【待确认：业务方】</span>`
      : `不在夜间管制时段（${C02P.nightFrom}:00–0${C02P.nightTo}:00，阈值待业务方确认）`);

  const pp = ppOf(t);
  const vlosM = pp ? Math.round(M.util.distKm({ lon: t.lon, lat: t.lat }, { lon: pp.lon, lat: pp.lat }) * 1000) : null;
  const c02f = hasV(t, '超视距飞行') ? 'fail' : (pp ? 'pass' : 'warn');
  const c02fMsg = hasV(t, '超视距飞行')
    ? (pp ? `目标与遥控源相距 ${vlosM} m，超出目视视距 ${C02P.vlosM} m（阈值待业务方确认）`
      : `<span style="color:#ffd07a">判为超视距，但无遥控器定位（需 TDOA / AOA / dcd）—— 该结论缺少可核验的距离依据</span>`)
    : (pp ? `目标与遥控源相距 ${vlosM} m，${vlosM > C02P.vlosM
      ? `<span style="color:#ffd07a">超出目视视距 ${C02P.vlosM} m 但未标注违规（阈值待业务方确认）</span>`
      : `未超出目视视距 ${C02P.vlosM} m（阈值待业务方确认）`}`
      : `<span style="color:#ffd07a">无遥控器定位（需 TDOA / AOA / dcd 提供 pilot_position）→ 本项不可判定，不以「未发现」当作合规</span>`);

  const rules = [c01, c02a, c02b, c02c, c02d, c02e, c02f];
  const warns = rules.filter(x => x === 'warn').length;

  const zoneType = zone ? zone.type : null;
  const sevRaw = vlist(t).reduce((m, v) => Math.max(m, C03.severity[v] || 0), 0);
  const unverifiable = vlist(t).filter(v =>
    (v === '身份不匹配' && !ev.full) || undet(t).indexOf(v) >= 0);
  const proven = unverifiable.length === 0;
  const F = {
    violation: Math.min(1, Math.max(proven ? sevRaw : sevRaw * C03.unproven, warns ? 0.30 : 0)),
    category: C03.category[t.type] != null ? C03.category[t.type] : 0.50,
    region: C03.zone[zoneType] != null ? C03.zone[zoneType] : 0.40,
    track: C03.track[t.track_status] != null ? C03.track[t.track_status] : 0.40,
    source: Math.min(1, (1 - (t.source_confidence != null ? t.source_confidence : 0.80))
      + (ev.full ? 0 : C03.idMissing))
  };
  const riskVal = Object.keys(C03.w).reduce((a, k) => a + C03.w[k] * F[k], 0);
  const score = Math.max(0, Math.min(100, Math.round(riskVal * 100)));
  const grade = c03Grade(score);

  const zoneForbidden = zone && FORBIDDEN_SPACE.indexOf(zone.type) >= 0 && zone.status === '生效中';
  const noAuth = pm ? pm === '未命中' : hasV(t, '未经批准飞行');
  const idMismatch = idClaim;
  const forbiddenHits = vlist(t).filter(v => FORBIDDEN_VIOLATIONS.indexOf(v) >= 0);
  const planHits = vlist(t).filter(v => PLAN_PARAM_VIOLATIONS.indexOf(v) >= 0);
  const basisA = (noAuth || (idMismatch && ev.full));
  const basisB = forbiddenHits.length > 0 || (zoneForbidden && c02a === 'fail');

  const reqs = [
    {
      g: '定性依据', n: '本次飞行无合法授权（典型黑飞）', ok: basisA,
      why: noAuth
        ? '该时空范围内不存在任何报备计划 —— 无论这架是谁，都没有可依据的授权，故不依赖 uav_sn'
        : idMismatch
          ? (ev.full ? '已实名核验：uavSN 不在报备名单内，本次飞行无合法授权'
            : '存在候选计划但缺 uav_sn，分不清「确实不是计划中那架」与「核验不了所以没匹配上」——依据不可靠')
          : '本次飞行已命中报备计划'
    },
    {
      g: '定性依据', n: '进入任何计划都无权批准的空间 / 高度层 / 时段', ok: basisB,
      why: basisB
        ? `命中<b>${forbiddenHits.join('、') || '禁飞区进入'}</b>` +
        `${zone && zoneForbidden ? `（${zone.type}「${zone.name}」）` : ''} —— ` +
        '该空间 / 高度层 / 时段内任何飞行计划都无权批准；该事实由感知与空域规则直接比对得出，不依赖身份数据源'
        : planHits.length
          ? `${planHits.join('、')} 属<b>计划侧</b>偏离（超出的是自身计划批准的参数，非空域规则）→ 指向异常，不构成非法依据`
          : '未进入禁止空间 / 高度层 / 时段'
    },
    {
      g: '质量门槛', n: `较高置信度（source_confidence ≥ ${C03.confMin}）`,
      ok: (t.source_confidence != null ? t.source_confidence : 0) >= C03.confMin,
      why: `source_confidence = ${t.source_confidence != null ? t.source_confidence : '—'}`
    },
    {
      g: '质量门槛', n: '轨迹稳定（非弥合 / 丢失段）', ok: t.track_status === '稳定',
      why: `track_status = ${t.track_status || '—'}`
    }
  ];
  const basisOk = basisA || basisB;
  const qualityMiss = reqs.filter(r => r.g === '质量门槛' && !r.ok);
  const reqMiss = (basisOk ? [] : [{ g: '定性依据', n: '定性依据不成立（无合法授权 / 绝对禁止空间 二者皆否）' }])
    .concat(qualityMiss);
  const sevHits = vlist(t).filter(v => SEVERE_C02.indexOf(v) >= 0 && unverifiable.indexOf(v) < 0);
  const aggravating = {
    hit: sevHits.length > 0,
    why: sevHits.length
      ? `${sevHits.join('、')} 属 C02 严重违规 → 提升风险等级与可用处置手段`
      : (unverifiable.length
        ? `无<b>已证实</b>的 C02 严重违规（${unverifiable.join('、')} 缺计算支撑，不计入加重）`
        : '无 C02 严重违规（不影响结论落点）')
  };

  const gated = eng === '非法' && (GATE_MODE === 'full'
    ? reqMiss.length > 0
    : (idClaim && !ev.full && !basisB));
  const engVerdict = gated ? '待确认' : eng;

  return {
    ev, eng, gated, engVerdict, score, grade, F, riskVal, reqs, reqMiss, aggravating, basisOk,
    items: [
      { r: R('C01'), s: c01, msg: c01msg, badge: c01badge },
      { r: R('C02-1'), s: c02a, msg: c02a === 'pass' ? '未进入禁飞空域'
          : `进入禁飞空域：${nfzZone
              ? (String(nfzZone.name).indexOf(nfzZone.type) >= 0 ? '' : nfzZone.type) + '「' + esc(nfzZone.name) + '」'
              : '禁飞区'}` + zoneBasis(nfzZone) },
      {
        r: R('C02-2'), s: c02b, msg: (function () {
          const dn = datum === 'agl' ? '距地高' : '海拔高';
          if (hMissing) return `<span style="color:#ffd07a">设备未上报距地高（协议 height 为选填）→ 降级为待确认，不以海拔高替代</span>`;
          if (c02b === 'fail') return hasV(t, '超出空域限高')
            ? `${dn} ${hUsed}m，超出<b>空域规则</b>限高 ${limZone ? limZone.limit : (zone ? zone.limit : 120)}m（基准 ${datum.toUpperCase()}）—— 该空域内任何计划都无权批准此高度层`
              + zoneBasis(limZone)
            : `${dn} ${hUsed}m，超出<b>自身计划</b>批准高度（未超空域规则限高）—— 属偏离批准参数`;
          if (c02b === 'warn') return `接近限高：${dn} ${hUsed}m / 限 ${zone.limit}m（基准 ${datum.toUpperCase()}）`;
          return `${dn} ${hUsed}m，未超限（基准 ${datum.toUpperCase()}）`;
        })()
      },
      {
        r: R('C02-3'), s: c02c, msg: offRouteUndet
          ? `<span style="color:#ffd07a">无报备航线几何数据（管服平台 routes 未接入），无法比对轨迹与批准走廊 —— 本项不可判定</span>`
          + '<br><span style="color:var(--txt-3)">不以「未测到」当作合规，也不据此给出偏离距离</span>'
          : (function () {
            const f = t.facts || {};
            const r = t.routeId && M.routeById ? M.routeById(t.routeId) : null;
            const dev2 = f.routeMaxDevM, half = f.routeHalfWidthM;
            const geom = dev2 != null && half != null
              ? `最大横向偏差 <b>${dev2} m</b>，走廊半宽阈值 ${half} m`
              + (r ? `（${r.name}：宽 ${r.widthM} m / 容差 ${r.widthTolM} m）` : '')
              : '';
            return offRouteLabel
              ? `轨迹越出批准走廊：${geom}，且连续 ${(M.TRACK_MODEL || {}).holdSamples || 2} 个采样点超限`
              : `轨迹全程位于批准走廊内：${geom || '—'}`;
          })()
      },
      {
        r: R('C02-4'), s: c02d, msg: c02d === 'pass' ? '在报备时段内'
          : hasV(t, '超出空域管制时段')
            ? `飞行时刻落在<b>空域规则</b>管制时段内${zone && zone.type === '临时管制区' ? `（${zone.name}　${zone.from} ~ ${zone.to}）` : ''} —— 该时段内任何计划都无权批准`
            : '超出<b>自身计划</b>批准时段（未触及空域管制时段）—— 属偏离批准参数'
      },
      { r: R('C02-5'), s: c02e, msg: c02eMsg },
      { r: R('C02-6'), s: c02f, msg: c02fMsg },
      {
        r: R('C03'), s: engVerdict === '非法' ? 'fail' : (engVerdict === '合法' ? 'pass' : 'warn'),
        msg: `风险评分 <b>${score}</b> / 100（${grade}，高=风险高）· 五因子加权 <span class="mono" style="font-size:11px">${C03.ver}</span>`
          + (gated
            ? `<br><span style="color:#ff9aa4">规则引擎原始输出「${eng}」；表10-4 结论依据缺 ${reqMiss.length} 项，`
            + `按 §10.4「结论一律向待确认收敛」取「待确认」，不得定性为「非法」</span>`
            : `<br>规则引擎判定「${eng}」`)
      }
    ]
  };
}

const ENGINE = { name: '规则引擎 · C01 证据充分性门禁', account: 'rule-engine', role: '系统自动' };
const GATE_REASON = '证据不足自动降级（B9）：判定时刻无 uav_sn 数据源（仅协议破解 dcd / RemoteID rid 可提供），'
  + '身份匹配只能依据时间窗 + 空间范围，不足以支撑「身份不匹配」定性，按 §8.6 验收要点结论取「待确认」';

function audit(actor, action, target) {
  const n = M.auditLogs.reduce((m, a) => Math.max(m, parseInt(String(a.id).replace(/\D/g, '')) || 0), 0) + 1;
  M.auditLogs.push({
    id: 'AU' + M.util.p3(n), time: nowStr(), user: actor.name, role: actor.role,
    module: '合法性判定', action: action, target: target, result: '成功',
    ip: actor.account === 'rule-engine' ? '127.0.0.1' : '10.20.1.15',
    term: actor.account === 'rule-engine' ? '判定引擎' : '终端-01'
  });
}

function applyReview(t, to, reason, act, actor) {
  actor = actor || OPER;
  if (t.legalOriginal == null) t.legalOriginal = t.legal;
  const from = t.legal;
  t.reviewLog = t.reviewLog || [];
  t.reviewLog.push({
    at: nowStr(), operator: actor.name, account: actor.account, role: actor.role,
    from: from, to: to, reason: reason, act: act
  });
  if (to && to !== t.legal) {
    t.legal = to;
    t.legal_status = to;
    t.legalSource = actor === ENGINE ? '规则引擎降级' : '人工改判';
  }
  audit(actor, act + (from === to ? '（判定未变更：' + from + '）' : '：' + from + ' → ' + to), t.id);
  return from;
}

const linkedAlarm = t => M.alarms.find(a => a.targetId === t.id) || null;
const linkedCase = t => M.cases.find(c => c.targetId === t.id) || null;
const alarmTargetStatus = to => (to === '合法' ? '误报' : '已确认');
function syncLinked(t, to, actor, doAlarm, doCase) {
  const out = [];
  const a = linkedAlarm(t);
  if (a && doAlarm) {
    const ns = alarmTargetStatus(to);
    if (a.status !== ns) {
      out.push(`告警 ${a.id} ${a.status} → ${ns}`);
      audit(actor, `联动更新告警状态：${a.status} → ${ns}`, a.id);
      a.status = ns;
    }
  }
  const c = linkedCase(t);
  if (c && doCase && to === '合法') {
    const req = raiseReviewRequest(t, c, t.legalOriginal || t.legal, to,
      '人工复核改判为合法，案件定性依据需按 §11 流程复核', actor);
    if (req) out.push(`案件 ${c.id} 已发起定性复核请求 ${req.id}`);
  }
  return out;
}

function raiseReviewRequest(t, c, from, to, reason, actor) {
  M.reviewRequests = M.reviewRequests || [];
  if (M.reviewRequests.some(r => r.caseId === c.id && r.targetId === t.id && r.status === '待处理')) return null;
  const req = {
    id: 'RR' + M.util.p3(M.reviewRequests.length + 1),
    at: nowStr(), targetId: t.id, caseId: c.id, caseStatus: c.status,
    from: from, to: to, reason: reason,
    raisedBy: actor.name, status: '待处理',
    note: '案件定性依据不足，请按 §11 案件复核流程核实后决定是否撤案 / 补证 / 维持'
  };
  M.reviewRequests.push(req);
  audit(actor, `发起案件定性依据复核请求 ${req.id}（判定 ${from} → ${to}）`, c.id);
  return req;
}

function applyEvidenceGate() {
  if (S.gateDone) return;
  S.gateDone = true;
  M.allTargets.filter(needGate).forEach(t => {
    const from = applyReview(t, '待确认', GATE_REASON, '证据不足自动降级', ENGINE);
    const c = linkedCase(t);
    if (c) raiseReviewRequest(t, c, from, '待确认', GATE_REASON, ENGINE);
  });
}
function collapseAbnormal() {
  M.allTargets.filter(t => t.type === '无人机' && t.legal === '异常').forEach(t => {
    if (t.legalOriginal == null) t.legalOriginal = '异常';
    t.legal = '待确认';
    t.legal_status = '待确认';
    t.legalSource = '规则状态归并';
  });
}

const gateEntry = t => (t.reviewLog || []).find(r => r.account === 'rule-engine' && r.from !== r.to) || null;
const autoDegraded = () => M.allTargets.filter(t => t.type === '无人机' && gateEntry(t));

function decisionConfirmModal() {
  const t = st.sel;
  if (!t || t.legal !== '待确认') return;
  U.modal({
    title: '人工确认 · ' + t.id, width: '560px',
    body: `${U.kv([
      ['目标编号', '<span class="mono">' + t.id + '</span>'],
      ['当前状态', U.legal(t.legal)],
      ['确认人', OPER.name + '（' + OPER.role + '）']
    ])}
    ${U.field('确认结果', `<select class="sel" data-cfresult style="flex:1">
      <option value="合法">合法</option>
      <option value="非法">非法</option>
    </select>`)}
    <div style="margin-top:12px">
      <div style="font-size:12.5px;color:var(--txt-2);margin-bottom:6px">确认说明（选填）</div>
      <textarea class="ip" data-cfre style="width:100%;height:64px;padding:8px"
        placeholder="填写核实依据或误报原因"></textarea>
    </div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn pri" data-act="ok">提交</button>',
    on: {
      ok: el => {
        const result = el.querySelector('[data-cfresult]').value;
        const reason = (el.querySelector('[data-cfre]').value || '').trim();
        applyReview(t, result, reason || '人工研判确认结果为' + result, '人工确认');
        syncLinked(t, result, OPER, true, true);
        U.closeModal(); refresh();
        U.toast('人工确认完成，判定状态已更新为「' + result + '」', 'ok');
      }
    }
  });
}

function manualReviseModal() {
  const t = st.sel;
  if (!t || !['合法', '非法'].includes(t.legal)) return;
  const cur = t.legal;
  const target = cur === '合法' ? '非法' : '合法';
  U.modal({
    title: '人工改判 · ' + t.id, width: '600px',
    body: `<div class="warnbox">人工改判会保留原判定，并记录操作者、时间、新判定和改判理由。</div>
      ${U.kv([
        ['目标编号', '<span class="mono">' + t.id + '</span>'],
        ['当前判定', U.legal(cur)]
      ])}
      ${U.field('改判为', '<input class="ip" style="flex:1" value="' + target + '" readonly>')}
      <div style="margin-top:12px">
        <div style="font-size:12.5px;color:var(--txt-2);margin-bottom:6px">改判理由 <span style="color:#ff8b95">*</span></div>
        <textarea class="ip" data-rvre style="width:100%;height:76px;padding:8px"
          placeholder="请填写人工核实依据，不少于5个字"></textarea>
      </div>
      <div id="rvSimpleErr" style="color:#ff8b95;font-size:12px;margin-top:8px"></div>`,
    footer: '<button class="btn" data-close>取消</button><button class="btn pri" data-act="ok">提交改判</button>',
    on: {
      ok: el => {
        const reason = (el.querySelector('[data-rvre]').value || '').trim();
        const err = el.querySelector('#rvSimpleErr');
        if (reason.length < 5) { err.textContent = '改判理由不少于5个字'; return; }
        applyReview(t, target, reason, '人工改判');
        syncLinked(t, target, OPER, true, true);
        U.closeModal(); refresh();
        U.toast('已人工改判：' + cur + ' → ' + target, 'ok');
      }
    }
  });
}

function buildAlarmFrom(t) {
  const lv = t.risk === '超高风险' || t.risk === '高风险' ? '高' : t.risk === '中风险' ? '中' : '低';
  let n = 1, id;
  do { id = 'ALM' + t.date.replace(/-/g, '') + 'M' + String(n).padStart(2, '0'); n++; }
  while (M.alarms.some(a => a.id === id));
  return {
    id, targetId: t.id, ymd: t.ymd, date: t.date,
    time: M.util.fmtDT(M.CONF.demoTime), ts: M.CONF.demoTime.getTime(),
    type: t.legal === '待确认' ? '待确认目标核实' : ((M.ALARM_TYPE || {})[t.violation] || '飞行违规告警'),
    kind: '飞行违规', level: lv, risk: t.risk, district: t.district,
    status: '新建', flowStatus: '待核实', verified: false, notifyLog: [], verifyLog: [],
    detail: `合法性研判转办：目标 ${t.id} 当前判定「${t.legal}」`
      + (vlist(t).length ? `，违规事由 ${vlist(t).join('、')}` : '，待人工核实定性'),
    source: t.source, source_confidence: t.facts && t.facts.sourceConfidence
  };
}

function toAlarmFlow() {
  const t = st.sel; if (!t) return;
  const exist = linkedAlarm(t);
  U.modal({
    title: '转告警工单 · ' + t.id, width: '560px',
    body: exist
      ? `<div class="warnbox">该目标已有关联告警 <b class="mono">${exist.id}</b>（${exist.status}）。
          确认后跳转告警中心并选中该工单，<b>不重复生成</b>。转办动作记入操作审计。</div>`
      : `<div class="warnbox">将为该目标生成一条<b>待核实</b>告警工单并转告警中心处理；生成与转办动作记入操作审计。</div>
        ${U.kv([
        ['目标编号', '<span class="mono">' + t.id + '</span>'],
        ['当前判定', U.legal(t.legal)],
        ['事由', vlist(t).length ? vlist(t).join('、') : '待人工核实定性'],
        ['风险等级', U.risk(t.risk)],
        ['经办人', OPER.name + '（' + OPER.role + '）']
      ])}`,
    footer: `<button class="btn" data-close>取消</button><button class="btn pri" data-act="ok">确认转办</button>`,
    on: {
      ok: () => {
        let a = linkedAlarm(t);
        if (a) audit(OPER, '转告警工单（关联既有告警 ' + a.id + '）', t.id);
        else {
          a = buildAlarmFrom(t);
          M.alarms.unshift(a);
          M.todayAlarms.unshift(a);
          audit(OPER, '转告警工单（生成 ' + a.id + '）', t.id);
        }
        U.closeModal();
        sessionStorage.setItem('alarm.sel', a.id);
        location.hash = '#/alarms';
      }
    }
  });
}

function toCaseFlow() {
  const t = st.sel;
  if (!t || t.legal !== '非法') return;
  const c0 = linkedCase(t);
  if (c0) {
    audit(OPER, '转处置处罚（既有案件 ' + c0.id + '）', t.id);
    U.goto('punish', { caseId: c0.id });
    return;
  }
  if (!EVT) { U.toast('事件层未加载，无法立案', 'err'); return; }
  U.modal({
    title: '转处置立案 · ' + t.id, width: '600px',
    body: `<div class="warnbox">立案将固化<b>当前判定快照</b>（判定结果 / 违规事由 / 风险等级 / 来源与置信度），
        后续复核推翻判定时可查「当初凭什么立案」。<br>
        立案后转<b>处置处罚模块</b>；反制等处置手段在该模块内经授权流程执行，本页不提供反制入口。</div>
      ${U.kv([
      ['目标编号', '<span class="mono">' + t.id + '</span>'],
      ['判定结果', U.legal(t.legal)],
      ['违规事由', vlist(t).join('、') || '—'],
      ['风险等级', U.risk(t.risk)],
      ['数据来源', t.source + '（置信度 ' + U.confPct(t.source_confidence) + '）'],
      ['经办人', OPER.name + '（' + OPER.role + '）']
    ])}`,
    footer: '<button class="btn" data-close>取消</button><button class="btn warn" data-act="ok">确认立案并转处置</button>',
    on: {
      ok: () => {
        const r = EVT.fileCase(EVT.of(t.id));
        if (!r.ok) { U.toast(r.msg, 'err'); return; }
        audit(OPER, '转处置立案：' + r.case.id, t.id);
        const bp = ((M.stats || {}).byPenalty || []).find(x => x.name === r.case.penalty);
        if (bp) bp.value++;
        U.closeModal();
        U.goto('punish', { caseId: r.case.id });
      }
    }
  });
}

/* ---------------- 渲染 ---------------- */
function targets() {
  const rank = t => t.legal === '非法' ? (/高/.test(t.risk) ? 0 : 1) : t.legal === '待确认' ? 2 : 3;
  return M.todayTargets.filter(t => t.type === '无人机')
    .filter(t => (st.legal === '全部' ? true
      : st.legal === '待处理' ? (t.legal === '非法' || t.legal === '待确认')
        : t.legal === st.legal)
      && (st.region === '全部' || t.district === st.region))
    .sort((a, b) => rank(a) - rank(b) || b.ts - a.ts);
}

function kpiHtml() {
  const T = M.todayTargets.filter(t => t.type === '无人机');
  const c = s => T.filter(t => t.legal === s).length;
  const card = (o, key) => Object.assign(o, { attr: `data-kpi="${key}"`, active: st.legal === key });
  return U.kpis([
    card({ label: '今日判定目标', value: U.num(T.length), color: 'blue', icon: 'check', desc: '仅无人机参与合法性判定 · 点击查看全部' }, '全部'),
    card({ label: '合法', value: U.num(c('合法')), color: 'green', icon: 'check', desc: '计划·时间·空域·航线均符合' }, '合法'),
    card({ label: '非法', value: U.num(c('非法')), color: 'red', icon: 'alert', desc: '无有效计划，或进入任何计划都无权批准的空域/时段' }, '非法'),
    card({ label: '待确认', value: U.num(c('待确认')), color: 'amber', icon: 'alert', desc: '关键数据缺失或存在偏差，需人工核实后定性' }, '待确认')
  ]);
}

function chipsHtml() {
  const opts = [['待处理', '待处理（非法 + 待确认）', '默认视图：非法与待确认目标，按处理优先级排序'],
    ['全部', '全部', '查看今日全部判定目标'], ['合法', '合法', '仅看判定为合法的目标'],
    ['非法', '非法', '仅看判定为非法的目标'], ['待确认', '待确认', '仅看需人工核实的目标']];
  const out = opts.map(([k, label, tip]) =>
    `<span class="filter-chip ${st.legal === k ? 'on' : ''}" data-chip-set="${k}" role="button" tabindex="0" title="${tip}">${label}</span>`);
  if (st.region !== '全部') out.push(`<span class="filter-chip">区域：${st.region}<span class="fx" data-chip-clear="region" title="清除区域筛选" role="button">×</span></span>`);
  return out.join('');
}

/* 首屏（与 legacy render() 同构：归并/门禁 + 深链消费 + 默认选中） */
collapseAbnormal();
applyEvidenceGate();
{
  const T = M.todayTargets.filter(t => t.type === '无人机');
  const ctx = U.consume('legality');
  if (ctx && ctx.target) {
    const hit = M.todayTargets.find(t => t.id === ctx.target) || M.allTargets.find(t => t.id === ctx.target);
    if (hit) {
      st.sel = hit; st.legal = '全部'; st.region = '全部';
      const idx = targets().findIndex(x => x.id === hit.id);
      if (idx >= 0) st.page = Math.max(1, Math.ceil((idx + 1) / st.size));
    }
  }
  st.sel = st.sel || targets()[0] || T[0];
}
const listPanelBody = `<div class="toolbar">
    <span id="lgChips" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap"></span>
    ${U.field('区域', U.select('region', ['全部', ...M.DISTRICTS.map(d => d.name)], st.region))}
    <span style="flex:1"></span>
    <button class="btn" id="lgRule">${U.icon('settings')} 判定规则说明</button>
    <button class="btn" id="lgRecalc">${U.icon('refresh')} 重新判定</button>
  </div>
  <div id="lgList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

function list() {
  const rows = targets(), page = rows.slice((st.page - 1) * st.size, st.page * st.size);
  return U.table([
    {
      t: '目标 / 时间', w: '118px', render: t => U.cell(t.id, t.time.slice(11), { mono: true })
    },
    {
      t: '判定 / 风险', w: '96px', render: t => U.legal(t.legal)
        + `<div style="margin-top:2px">${U.risk(t.risk)}</div>`
        + (needGate(t) ? ` <span title="身份依据缺失，证据不足" style="color:#ff8b95">${U.icon('warning')}</span>` : '')
        + (manualRevised(t) ? `<div style="font-size:10.5px;color:#c8adff;margin-top:2px" title="原判定 ${engOf(t)}，已人工改判">人工改判</div>`
          : engineDegraded(t) ? `<div style="font-size:10.5px;color:#ffd07a;margin-top:2px" title="原判定 ${engOf(t)}，因身份依据缺失由引擎证据门禁降级">证据降级</div>` : '')
    },
    { t: '区域', w: '72px', render: t => t.district },
    {
      t: '违规原因', render: t => {
        const vs = vlist(t);
        if (!vs.length) return '—';
        const show = vs.slice(0, 2).map(v =>
          `<div style="margin:1px 0">${U.tag(v, FORBIDDEN_VIOLATIONS.indexOf(v) >= 0 ? 't-red' : 't-orange')}</div>`).join('');
        const overH = anyV(t, ['超出空域限高', '超出计划批准高度'])
          ? `<div class="mono" style="font-size:10.5px;color:#ff8b95">实测 ${t.heightAgl != null ? t.heightAgl + ' m（距地）' : t.alt + ' m（海拔）'}</div>` : '';
        return show + (vs.length > 2
          ? `<div style="font-size:10.5px;color:var(--txt-3)" title="${vs.join('、')}">+${vs.length - 2} 项</div>` : '') + overH;
      }
    }
  ], page, { rowId: t => t.id, activeId: st.sel && st.sel.id }) + U.pager({ total: rows.length, page: st.page, size: st.size });
}

function spaceHits(t) {
  const zone = M.airspaces.find(a => a.region === t.district);
  const hits = [];
  if (hasV(t, '侵入禁飞区')) hits.push({ v: '侵入禁飞区', zone, how: '轨迹穿越该空域边界' });
  if (hasV(t, '超出空域限高')) hits.push({ v: '超出空域限高', zone, how: `轨迹高度超出该空域限高 ${zone ? zone.limitTx : ''}` });
  if (hasV(t, '超出空域管制时段')) hits.push({ v: '超出空域管制时段', zone, how: '飞行时刻落在该空域管制时段内' });
  if (hasV(t, '偏离报备航线')) {
    const r = t.routeId && M.routeById ? M.routeById(t.routeId) : null;
    hits.push({ v: '偏离报备航线', route: r, how: `轨迹越出批准走廊（最大横向偏差 ${t.facts.routeMaxDevM} m / 半宽阈值 ${t.facts.routeHalfWidthM} m）` });
  }
  return hits;
}
function spaceSect(t, j) {
  const hits = spaceHits(t);
  const pts = t.track_points || [];
  const bridged = pts.filter(p => p.kind === 'bridge').length;
  return U.sect('空间证据（违规位置示意）'
    + (hits.length ? ` <span class="tag t-red">${hits.length} 项命中</span>` : ' <span class="tag t-green">无空间类命中</span>'),
    `<div id="lgMap" style="height:210px;border:1px solid var(--line);border-radius:6px;overflow:hidden"></div>
    <div style="font-size:11.5px;color:var(--txt-3);margin-top:6px;line-height:1.7">
      ${pts.length ? `轨迹 ${pts.length} 点`
      + (bridged ? `，其中 <b style="color:#ff8b3d" title="弥合段（A03）">${bridged} 点为推算补全段</b> —— 该段无实测值，位置由算法推算，<b>不得等同实测参与判定</b>（§6.8）`
        : '，全部为实测点') : '<span style="color:#ffd07a">该目标无轨迹数据，图上只能显示空域范围</span>'}
    </div>
    ${hits.length ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
      ${hits.map(h => `<div style="font-size:12.5px;border-left:2px solid #ff4d5e;padding-left:8px">
        <div><b>${h.v}</b>${h.zone ? ` · ${h.zone.type}「${h.zone.name}」` : h.route ? ` · 航线「${h.route.name}」` : ''}</div>
        <div style="color:var(--txt-3)">${h.how}</div></div>`).join('')}
    </div>` : `<div style="font-size:12px;color:var(--txt-3);margin-top:7px">
      本次判定无空间类命中；图上仅供核对轨迹与所在空域的位置关系。</div>`}`,
    { collapsible: true, open: false, icon: 'zone', className: 'lg-space' });
}
let detMap = null;
function resetDetMap() { if (detMap) { try { detMap.destroy(); } catch (e) { } detMap = null; } }
function bindSpaceMap() {
  resetDetMap();
  const d = document.querySelector('#lgDetail details.lg-space');
  if (!d) return;
  d.addEventListener('toggle', () => { if (d.open) drawDetailMap(); });
  if (d.open) drawDetailMap();
}
function drawDetailMap() {
  const box = document.getElementById('lgMap');
  if (!box) return;
  if (detMap) { try { detMap.destroy(); } catch (e) { } detMap = null; }
  const t = st.sel; if (!t) return;
  detMap = new window.MapView(box, { zoom: 3.2, maxDev: 0, maxAlarm: 0, legend: false, layers: { device: false, alarm: false } });
  detMap.setData({ airspaces: M.airspaces, devices: [], alarms: [], targets: [t] });
  detMap.sel = t;
  const pts = t.track_points || [];
  const c = pts.length ? pts[Math.floor(pts.length / 2)] : t;
  const center = () => {
    if (!detMap || !detMap.w) return;
    detMap.centerAt(c.lon, c.lat);
  };
  center();
  requestAnimationFrame(center);
}

function reqSect(t, j) {
  if (j.eng !== '非法') return '';
  const row = r => `<div style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;
      border-left:2px solid ${r.ok ? '#2dcfd0' : 'var(--line)'};padding-left:8px">
    <span style="flex:none">${r.ok ? U.tag('成立', 't-cyan') : U.tag('不成立', 't-gray')}</span>
    <div style="flex:1"><div>${r.n}</div><div style="color:var(--txt-3)">${r.why}</div></div></div>`;
  const basis = j.reqs.filter(r => r.g === '定性依据'), qual = j.reqs.filter(r => r.g === '质量门槛');
  return U.sect(`「非法」结论依据校验 <span class="tag ${j.reqMiss.length ? 't-amber' : 't-green'}">${j.reqMiss.length ? '缺 ' + j.reqMiss.length + ' 项' : '成立'}</span>`,
    `<div style="font-size:11.5px;color:var(--txt-3);margin-bottom:7px">
      表10-4：分界由<b>有没有授权覆盖</b> + <b>偏离的性质</b>共同决定。
      定性依据<b>二选一即可</b>；证据质量门槛须同时满足；C02 严重违规是加重情形，<b>不是必要条件</b>。</div>
    <div style="font-size:11.5px;color:#9ec6ff;margin:8px 0 5px">定性依据（满足其一即可）</div>
    <div style="display:flex;flex-direction:column;gap:6px">${basis.map(row).join('')}</div>
    <div style="font-size:11.5px;color:#9ec6ff;margin:9px 0 5px">证据质量门槛（须同时满足）</div>
    <div style="display:flex;flex-direction:column;gap:6px">${qual.map(row).join('')}</div>
    <div style="font-size:11.5px;color:#9ec6ff;margin:9px 0 5px">加重情形（不决定结论落点）</div>
    <div style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;
        border-left:2px solid ${j.aggravating.hit ? '#ff8b3d' : 'var(--line)'};padding-left:8px">
      <span style="width:14px">${j.aggravating.hit ? '<span style="color:#ff8b3d">▲</span>' : '<span style="color:var(--txt-3)">—</span>'}</span>
      <div style="flex:1"><div>C02 严重违规</div>
        <div style="color:var(--txt-3)">${j.aggravating.why}</div></div></div>`,
    { collapsible: true, open: false, icon: 'shield' });
}

function reviewSect(t) {
  const log = t.reviewLog || [];
  if (!log.length) return '';
  return U.sect(`判定变更记录 <span class="tag t-purple">${log.length} 条</span>`,
    `<div style="font-size:11.5px;color:var(--txt-3);margin-bottom:8px">
      规则引擎原始判定：<b>${U.legal(engOf(t))}</b> —— <b>原判定不被覆盖，全程可查</b>（设计 8.6 审计要求）</div>
    ${log.map((r, i) => `<div style="border-left:2px solid ${r.from === r.to ? '#3d8bff' : '#a97bff'};
        padding-left:9px;margin-bottom:9px;font-size:12.5px;line-height:1.75">
      <div><b>${i + 1}. ${r.act}</b> <span class="mono" style="color:var(--txt-3);font-size:11.5px">${r.at}</span></div>
      <div>${U.legal(r.from)} <span style="color:var(--txt-3)">→</span> ${U.legal(r.to)}
        ${r.from === r.to ? '<span style="color:var(--txt-3);font-size:11.5px">（判定结果未变更）</span>' : ''}</div>
      <div style="color:var(--txt-3)">操作者：${esc(r.operator)}（${esc(r.account)} · ${esc(r.role)}）</div>
      <div style="color:var(--txt-2)">理由：${esc(r.reason)}</div>
    </div>`).join('')}`, { collapsible: true, open: false, icon: 'archive' });
}

function integrityStrip(t, j) {
  const miss = [];
  if (!j.ev.full) miss.push('无人机实名编号（uav_sn）未取得 —— 仅协议破解 / RemoteID 设备可提供，身份维度降级为「时间窗 + 空间范围」，不足以支撑身份定性');
  if (t.heightAgl == null) miss.push('距地高度未上报（协议 height 为选填）—— 限高判定不以海拔高替代');
  if (!j.ev.hasPilot) miss.push('遥控器定位缺失（需 TDOA / AOA / 协议破解提供 pilot_position）—— 超视距维度不可判定');
  undet(t).forEach(u => miss.push(`「${u}」无判据可依 —— 未计入违规，也不作合规`));
  let grade, color, desc;
  if (j.gated || needGate(t)) { grade = '判定依据不足'; color = '#ff4d5e'; desc = '结论已按规则向「待确认」收敛，不得定性为非法'; }
  else if (engineDegraded(t) || !j.ev.full) { grade = '降级判定'; color = '#ff8b3d'; desc = '部分维度缺数据源，按降级口径判定'; }
  else if (miss.length) { grade = '部分数据缺失'; color = '#ffb020'; desc = '缺失维度按「不可判定」处理，未参与结论'; }
  else { grade = '数据完整'; color = '#2fd06e'; desc = '各判定维度均有数据支撑'; }
  return `<details class="integrity-strip" style="border-color:${color}66;background:${color}0f">
    <summary>${U.icon('shield')}<b style="color:${color};flex:none">${grade}</b>
      <span style="color:var(--txt-3);font-size:11.5px;flex:1">${desc}${miss.length ? ` · ${miss.length} 项缺失，点击展开` : ''}</span></summary>
    <div class="ig-body">${miss.length ? miss.map(m => `<div>· ${m}</div>`).join('') : '本次判定各维度均有数据支撑，无缺失项。'}</div>
  </details>`;
}

function planCompareSect(t) {
  const f = t.facts || {};
  const p = t.matched_plan_id ? M.flightPlans.find(x => x.id === t.matched_plan_id) : null;
  if (!p) return `<div class="warnbox" style="margin-top:8px">
    <b style="color:#ff8b95">无有效飞行计划</b> —— 该时空范围内不存在任何可关联的报备计划，无从对比航线与批准参数。</div>`;
  const row = (name, state, txt) => `<div style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;padding:5px 0;border-bottom:1px dashed rgba(130,174,218,.12)">
    <span style="width:64px;flex:none;color:var(--txt-2)">${name}</span>
    <span style="flex:none">${U.stateIcon(state, false)}</span>
    <span style="flex:1;${state === 'na' ? 'color:var(--txt-3)' : state === 'fail' ? 'color:#ff8b95' : ''}">${txt}</span>
  </div>`;
  const latNa = f.routeMaxDevM == null;
  const lat = latNa
    ? row('航线偏航', 'na', '无报备航线几何数据（管服平台 routes 未接入）—— 不可判定，不以「未测到」当作合规')
    : row('航线偏航', hasV(t, '偏离报备航线') ? 'fail' : 'pass',
      `最大横向偏差 <b class="mono">${f.routeMaxDevM} m</b>（走廊半宽阈值 ${f.routeHalfWidthM} m）`);
  const timeBad = anyV(t, ['超出计划批准时段', '超出空域管制时段']);
  const time = row('时间', timeBad ? 'fail' : 'pass',
    `批准时段 <span class="mono">${String(p.start || '—').slice(11, 16)} ~ ${String(p.end || '—').slice(11, 16)}</span>，实际发现 <span class="mono">${t.time.slice(11, 16)}</span>`);
  const hBad = anyV(t, ['超出计划批准高度', '超出空域限高']);
  const hgt = hBad
    ? row('高度', 'fail', `实测 <b class="mono">${t.heightAgl != null ? t.heightAgl + ' m（距地）' : t.alt + ' m（海拔）'}</b>，计划批准 ≤ <span class="mono">${p.maxAlt} m</span>`
      + (t.heightAgl != null && t.heightAgl > p.maxAlt ? `，偏差 <b class="mono">+${t.heightAgl - p.maxAlt} m</b>` : ''))
    : t.heightAgl == null
      ? row('高度', 'na', '距地高未上报（协议 height 选填）—— 高度对比不可判定，不以海拔高替代')
      : row('高度', 'pass', `实测 <b class="mono">${t.heightAgl} m（距地）</b>，计划批准 ≤ <span class="mono">${p.maxAlt} m</span>`);
  return `<div class="detail-sect" style="margin-top:8px">
    <span class="sect-head"><span class="sect-icon">${U.icon('plan')}</span><span class="sect-title">与批准计划对比
      <span class="mono" style="color:var(--txt-3);font-size:11px">${p.id}</span></span></span>
    <div class="sect-body">${lat}${time}${hgt}</div></div>`;
}

function actionBar(t) {
  if (t.type !== '无人机') return '';
  const a = linkedAlarm(t), c = linkedCase(t);
  const btn = (k, label, cls, dis, tip) =>
    `<button class="btn ${cls || ''}" data-lg="${k}" ${dis ? 'disabled' : ''} title="${tip || ''}"
      style="flex:1;height:36px;justify-content:center">${label}</button>`;
  if (t.legal === '合法') return U.detailActions(
    btn('revise', '人工复核（改判）', 'warn', false, '合法目标可查看可复核，不提供转办入口'));
  if (t.legal === '待确认') return U.detailActions(
    btn('confirm', '人工复核', 'pri', false, '补充核验并定性（合法 / 非法）'));
  /* 「转告警工单」已按用户裁定整体删除（2026-08-30）：非法目标绝大多数本就带关联告警
     （按钮常年置灰），演示上有意义的流转只有复核与立案。toAlarmFlow 逻辑保留不再有入口。 */
  if (t.legal === '非法') return U.detailActions(
    btn('revise', '人工复核', 'pri', false, '复核判定依据，可改判')
    + btn('tocase', '转处置立案', 'warn', false, c ? `已立案 ${c.id}，点击转到处置处罚` : '立案并转处置处罚模块'));
  return '';
}

function detail() {
  const t = st.sel;
  if (!t) return '<div class="empty">请选择目标</div>';
  const stEl = document.getElementById('lgSt');
  if (stEl) stEl.innerHTML = U.legal(t.legal) + ' ' + U.risk(t.risk)
    + (manualRevised(t) ? ' <span class="tag t-purple">人工改判</span>' : '');
  const j = judge(t);
  const manual = manualRevised(t);
  const autoDeg = !manual && engineDegraded(t);
  const ic = s => U.stateIcon(s, false);
  const pts = t.track_points || [];
  const lastUpd = pts.length && pts[pts.length - 1].t
    ? new Date(pts[pts.length - 1].t).toTimeString().slice(0, 8)
    : t.time.slice(11);
  const inList = targets().some(x => x.id === t.id);
  return `${U.detailHero({
    icon: 'scale', subtitle: '合法性研判目标', title: t.subtype || t.type, id: t.id,
    tags: [U.legal(t.legal), U.risk(t.risk), manual ? U.tag('人工改判', 't-purple') : ''],
    meta: [['区域', t.district], ['发现', t.time.slice(11)], ['最后更新', lastUpd]]
  })}
    ${inList ? '' : `<div class="warnbox" style="margin-bottom:10px">原选中目标已不在当前筛选结果中，右侧仍显示其详情；点击列表任一行可切换。</div>`}
    ${integrityStrip(t, j)}
    ${U.metricStrip([
      { label: '合法性结论', value: t.legal, tone: t.legal === '合法' ? 'good' : t.legal === '非法' ? 'bad' : 'warn', icon: 'scale' },
      { label: '风险等级', value: t.risk, tone: /高/.test(t.risk) ? 'bad' : /中/.test(t.risk) ? 'warn' : 'info', icon: 'alert' },
      { label: '来源置信', value: U.confPct(t.source_confidence), tone: 'good', icon: 'radar' },
      { label: '判定方式', value: manual ? '人工改判' : autoDeg ? '自动收敛' : '规则引擎', icon: 'settings' }
    ], { compact: true })}
    ${U.verdictHtml(t)}
    ${planCompareSect(t)}
    <div style="font-size:13.5px;color:var(--txt-2);margin:14px 0 2px">技术详情
      <span style="font-size:11.5px;color:var(--txt-3)">（判定明细与原始数据，默认收起）</span></div>
    ${U.sect('判定明细（技术）' + (manual ? ' <span class="tag t-purple">当前结果已人工改判</span>'
      : autoDeg ? ' <span class="tag t-amber">当前结果已自动收敛</span>' : ''), `
      <div style="display:flex;flex-direction:column;gap:7px">
        ${j.items.map(i => `<div style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;
          border-left:2px solid ${i.s === 'pass' ? '#2fd06e' : i.s === 'warn' ? '#ffb020' : '#ff4d5e'};padding-left:8px">
          <span style="flex:none;width:16px">${ic(i.s)}</span>
          <div style="flex:1"><div><b>${i.r.n}</b> <span class="mono" style="color:var(--txt-3);font-size:11px">(${i.r.id})</span> ${i.badge || ''}</div>
            <div style="color:var(--txt-3)">${i.msg}</div></div>
        </div>`).join('')}
      </div>`, { icon: 'settings', collapsible: true, open: false })}
    ${U.sect('目标信息', U.kv([
      ['发现时间', t.time],
      ['机型', U.modelTag(t.uav_model, t.modelSource)],
      ['归属单位', t.partner],
      ['飞手', t.pilot],
      ['位置', `<span class="mono">${t.lon.toFixed(4)}°E, ${t.lat.toFixed(4)}°N</span>`],
      ['海拔高度', t.alt + ' m'],
      ['距地高度', t.heightAgl != null ? t.heightAgl + ' m'
        : '<span style="color:var(--txt-3)" title="协议 height 为选填，设备未上报">未上报（不以海拔替代）</span>'],
      ['速度', t.speed + ' m/s'],
      ['数据来源', t.source + '（置信度 ' + U.confPct(t.source_confidence) + '）']
    ], { surface: true, density: 'compact' }), { icon: 'plane', collapsible: true, open: false })}
    ${spaceSect(t, j)}
    ${reqSect(t, j)}
    ${reviewSect(t)}
    ${actionBar(t)}`;
}

function drawRing() {
  const el = document.getElementById('lgScore');
  if (!el || !st.sel) return;
  const j = judge(st.sel);
  CH.ring(el, { value: j.score, color: j.score >= 67 ? '#ff4d5e' : j.score >= 34 ? '#ffb020' : '#2fd06e', fs: 16, fmt: v => v });
}

function paint() {
  const k = document.getElementById('lgKpi'); if (k) k.innerHTML = kpiHtml();
  const ch = document.getElementById('lgChips'); if (ch) ch.innerHTML = chipsHtml();
  const n = document.getElementById('lgEvidN'); if (n) n.textContent = autoDegraded().length + gatedList().length;
  document.getElementById('lgList').innerHTML = list();
  document.getElementById('lgDetail').innerHTML = detail();
  drawRing();
  bindSpaceMap();
}
function refresh() { paint(); }

onUnmounted(() => { if (detMap) { try { detMap.destroy(); } catch (e) { } detMap = null; } });

onMounted(() => {
  const view = root.value;
  const drift = enumDrift();
  if (drift.stale.length || drift.missing.length) {
    console.warn('[legality] 违规原因枚举与 MOCK.VIOLATIONS 不一致 —— 本页已失效的键:',
      drift.stale, '；未覆盖的新枚举值:', drift.missing);
  }
  if (drift.truncated) {
    console.warn('[legality] Schema 契约字段 violation_reasons 被截断：' + drift.truncated
      + ' 个目标的 violation_reasons 条数少于 violations，样例 '
      + (drift.truncatedSample ? drift.truncatedSample.id : ''));
  }
  paint();

  U.on(view, '[data-row]', 'click', (e, el) => {
    st.sel = M.todayTargets.find(t => t.id === el.dataset.row) || st.sel;
    U.selectRow(document.getElementById('lgList'), el.dataset.row);
    document.getElementById('lgDetail').innerHTML = detail();
    drawRing();
    bindSpaceMap();
  });
  U.on(view, '[data-kpi]', 'click', (e, el) => {
    const v = el.dataset.kpi;
    st.legal = st.legal === v ? '待处理' : v;
    st.page = 1; paint();
  });
  U.on(view, '[data-kpi]', 'keydown', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
  U.on(view, '[data-chip-set]', 'click', (e, el) => {
    st.legal = el.dataset.chipSet; st.page = 1; paint();
  });
  U.on(view, '[data-chip-set]', 'keydown', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
  U.on(view, '[data-chip-clear]', 'click', (e, el) => {
    e.stopPropagation();
    if (el.dataset.chipClear === 'legal') st.legal = '待处理';
    else {
      st.region = '全部';
      const s = view.querySelector('select[data-f="region"]');
      if (s) s.value = '全部';
    }
    st.page = 1; paint();
  });
  U.on(view, '[data-pg]', 'click', (e, el) => { if (el.dataset.pg) { st.page = +el.dataset.pg; paint(); } });
  U.on(view, '[data-size]', 'change', (e, el) => { st.size = parseInt(el.value); st.page = 1; paint(); });
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; paint(); });
  U.on(view, '[data-lg]', 'click', (e, el) => {
    const k = el.dataset.lg;
    if (!st.sel) return;
    if (k === 'confirm') decisionConfirmModal();
    else if (k === 'revise') manualReviseModal();
    else if (k === 'toalarm') toAlarmFlow();
    else if (k === 'tocase') toCaseFlow();
    else if (k === 'degrade') {
      const t = st.sel;
      if (t.legal !== '非法') { U.toast('该目标当前判定已非「非法」，无需重复降级', 'ok'); return; }
      const c = M.cases.find(x => x.targetId === t.id);
      const rsn = '证据不足降级：判定时刻无 uavSN 数据源（需协议破解 dcd / RemoteID rid 设备），身份匹配仅能依据时间窗 + 空间范围，不足以定性为非法'
        + (c ? '。该目标已立案 ' + c.id + '，须在处置处罚管理同步复核案件' : '');
      const from = applyReview(t, '待确认', rsn, '证据不足降级');
      const req = c ? raiseReviewRequest(t, c, from, '待确认', rsn, OPER) : null;
      refresh();
      U.toast('已按证据不足降级为「待确认」，原判定「非法」保留可查'
        + (req ? `；已对案件 ${c.id} 发起复核请求 <b>${req.id}</b>` : ''), 'ok');
    }
  });
  document.getElementById('lgRecalc').onclick = () => {
    const all = targets();
    const kept = all.filter(revised).length;
    refresh();
    U.toast(`已按当前规则重新判定今日 ${all.length} 个目标`
      + (kept ? `；其中 ${kept} 个已人工改判的结果<b>不被引擎覆盖</b>（设计 8.6）` : ''), 'ok');
  };
  document.getElementById('lgRule').onclick = () => U.modal({
    title: '判定规则说明', width: '760px',
    body: `${(function () {
      const d = enumDrift();
      return (d.stale.length || d.missing.length)
        ? `<div class="warnbox" style="border-color:rgba(255,77,94,.5);background:rgba(255,77,94,.10)">
            注意：<b>枚举漂移</b>：本页的违规原因常量与 <span class="mono">MOCK.VIOLATIONS</span> 不一致，判定结果可能失真。
            ${d.stale.length ? `<br>本页已失效的键：<span class="mono">${d.stale.join('、')}</span>` : ''}
            ${d.missing.length ? `<br>数据层新增、本页严重度表未覆盖：<span class="mono">${d.missing.join('、')}</span>（严重度按 0 计）` : ''}
          </div>` : '';
    })()}
    ${(function () {
      const d = enumDrift();
      return d.truncated
        ? `<div class="warnbox">注意：<b>数据层重新出现内部违规副本</b>：<b>${d.truncated}</b> 个目标带有
            <span class="mono">violations</span> 字段${d.truncatedSample ? `（样例 <span class="mono">${d.truncatedSample.id}</span>）` : ''}。
            Schema 契约字段是 <span class="mono">violation_reasons</span>，一旦两者并存就会重现「页面读内部字段显示正确、
            正式 Adapter 读契约字段拿到截断值」的问题。请收敛回单一字段。</div>` : '';
    })()}
      <div class="warnbox">规则为 Demo 缺省参数，<b>正式阈值由业务方确认</b>（纪要 §10 C01–C03）。修改后立即生效并记录版本。<br>
      C01 的身份核验依赖 <span class="mono">uav_sn</span> 数据源（协议破解 dcd / RemoteID rid）；
      <b>数据源缺失时自动降级为时间窗 + 空间范围匹配，且不得输出「身份不匹配」定性</b>（B9）。</div>
      ${U.table([
      { t: '规则编号', k: 'id', w: '86px' }, { t: '规则名称', k: 'n', w: '170px' }, { t: '说明', k: 'd' },
      { t: '关键参数', w: '250px', render: r => `<span class="mono" style="font-size:11.5px">${{
        'C01': '时间窗±10min / 空间500m / uavSN 实名核验（需 dcd·rid）',
        'C02-1': '禁飞空域缓冲 0m',
        'C02-2': '限高容差 +10m',
        'C02-3': '走廊宽度与容差【待确认：业务方】· 需管服平台 routes 几何数据，未接入前本项不可判定',
        'C02-4': '超时容差 5min',
        'C02-5': '夜间管制时段 ' + C02P.nightFrom + ':00–0' + C02P.nightTo + ':00【待确认：业务方】',
        'C02-6': '目视视距 ' + C02P.vlosM + 'm，依赖 pilot_position【待确认：业务方】',
        'C03': C03.ver + ' 五因子加权：违规' + C03.w.violation + ' / 类别' + C03.w.category
          + ' / 区域' + C03.w.region + ' / 轨迹' + C03.w.track + ' / 来源' + C03.w.source
          + '；未证实违规按 ' + C03.unproven + ' 半权【Demo 假设】'
          + '；证据质量门槛 source_confidence ≥ ' + C03.confMin + '【待确认：业务方】'
          + '；非法需表10-4 四要件齐备，否则收敛至待确认'
      }[r.id]}</span>` },
      { t: '状态', w: '76px', render: () => U.tag('启用', 't-green') }
    ], RULES)}`,
    footer: `<span style="flex:1;font-size:11.5px;color:var(--txt-3)">本弹窗为规则与阈值的<b>只读说明</b>；阈值调整在各参数所属页面就地进行并留痕</span>
      <button class="btn" data-close>关闭</button>`
  });
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <div id="lgKpi"></div>

      <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导） -->
      <div class="warnbox" style="margin:12px 0 0;padding:8px 11px;font-size:12px;flex:none">
        演示动线：点上方<b>统计卡</b>或列表左上<b>状态标签</b>切换「待处理 / 合法 / 非法 / 待确认」视图 →
        点列表任一行，右侧显示判定详情 → 底部点「<b>人工复核</b>」演示；非法目标另有「<b>转处置立案</b>」。</div>

      <div class="row" style="margin-top:12px;flex:1;min-height:0;padding-bottom:6px">
        <UPanel title="判定结果列表" panel-style="flex:1.4" nopad :body-html="listPanelBody" />
        <UPanel title="判定详情" panel-style="width:40%;min-width:380px;flex:none" nopad
          extra='<span id="lgSt"></span>' body-html='<div id="lgDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
      </div>
    </div>
  </div>
</template>
