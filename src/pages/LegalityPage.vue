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
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { NPagination, NSelect } from 'naive-ui';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { toast } from '@/ui/nv.js';
import { openModal, closeModal } from '@/ui/modal.js';

const M = window.MOCK, U = window.UI, CH = window.CH, EVT = window.EVT;
usePageChrome('legality');
const root = ref(null);
/* reactive 代理同一份模块级状态：n-pagination 需要响应式，底层仍是 S.st */
const st = reactive(S.st);
const totalCount = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(totalCount.value / st.size)));
const regionOptions = computed(() => [{ label: '全部', value: '全部' }, ...M.DISTRICTS.map(d => ({ label: d.name, value: d.name }))]);
const evidenceTab = ref('space');
const basisSel = ref(0);

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
  openModal({
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
        closeModal(); refresh();
        toast('人工确认完成，判定状态已更新为「' + result + '」', 'ok');
      }
    }
  });
}

function manualReviseModal() {
  const t = st.sel;
  if (!t || !['合法', '非法'].includes(t.legal)) return;
  const cur = t.legal;
  const target = cur === '合法' ? '非法' : '合法';
  openModal({
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
        closeModal(); refresh();
        toast('已人工改判：' + cur + ' → ' + target, 'ok');
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
  openModal({
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
        closeModal();
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
  if (!EVT) { toast('事件层未加载，无法转入处置', 'err'); return; }
  openModal({
    title: '转入处置 · ' + t.id, width: '600px',
    body: `<div class="warnbox">转入处置会自动保存<b>当前判定快照</b>（判定结果 / 违规事由 / 风险等级 / 来源与置信度），
        供后续复核追溯当时依据。<br>
        确认后进入<b>处置处罚模块</b>；反制等处置手段在相应模块内经授权执行，本页不提供反制入口。</div>
      ${U.kv([
      ['目标编号', '<span class="mono">' + t.id + '</span>'],
      ['判定结果', U.legal(t.legal)],
      ['违规事由', vlist(t).join('、') || '—'],
      ['风险等级', U.risk(t.risk)],
      ['数据来源', t.source + '（置信度 ' + U.confPct(t.source_confidence) + '）'],
      ['经办人', OPER.name + '（' + OPER.role + '）']
    ])}`,
    footer: '<button class="btn" data-close>取消</button><button class="btn warn" data-act="ok">确认转入处置</button>',
    on: {
      ok: () => {
        const r = EVT.ensureCaseRecord(EVT.of(t.id));
        if (!r.ok) { toast(r.msg, 'err'); return; }
        audit(OPER, '转入处置：' + r.case.id, t.id);
        const bp = ((M.stats || {}).byPenalty || []).find(x => x.name === r.case.penalty);
        if (bp) bp.value++;
        closeModal();
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
  const card = (o, key) => Object.assign(o, {
    attr: `data-kpi="${key}"`,
    active: st.legal === key || (key === '全部' && st.legal === '待处理')
  });
  return U.kpis([
    card({ label: '今日判定目标', value: U.num(T.length), color: 'blue', icon: 'check',
      desc: '仅无人机参与合法性判定 · 点击查看全部' }, '全部'),
    card({ label: '合法', value: U.num(c('合法')), color: 'green', icon: 'check',
      desc: '计划·时间·空域·航线均符合' }, '合法'),
    card({ label: '非法', value: U.num(c('非法')), color: 'red', icon: 'alert',
      desc: '无有效计划，或进入任何计划都无权批准的空域/时段' }, '非法'),
    card({ label: '待确认', value: U.num(c('待确认')), color: 'amber', icon: 'alert',
      desc: '关键数据缺失或存在偏差，需人工核实后定性' }, '待确认')
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
function orderedTargets() {
  const rows = targets();
  if (st.legal !== '待处理') return rows;
  const illegal = rows.filter(t => t.legal === '非法');
  const pending = rows.filter(t => t.legal === '待确认');
  const chunk = Math.max(1, Math.ceil(st.size / 2));
  return illegal.slice(0, chunk).concat(pending.slice(0, chunk), illegal.slice(chunk), pending.slice(chunk));
}

function queueRow(t) {
  const reasons = vlist(t);
  const revisedTx = manualRevised(t) ? '<span class="lg-row-note is-purple">人工改判</span>'
    : engineDegraded(t) ? '<span class="lg-row-note is-amber">证据降级</span>' : '';
  return `<button class="lg-queue-row${st.sel && st.sel.id === t.id ? ' is-selected' : ''}" data-row="${t.id}"
    aria-current="${st.sel && st.sel.id === t.id ? 'true' : 'false'}">
    <span class="lg-row-target"><b class="mono">${t.id}</b><small>${t.time.slice(11)}</small></span>
    <span class="lg-row-verdict">${U.legal(t.legal)}${revisedTx}</span>
    <span class="lg-row-risk">${U.risk(t.risk)}</span>
    <span class="lg-row-region">${t.district}</span>
    <span class="lg-row-reason" title="${esc(reasons.join('、') || '无违规原因')}">${esc(reasons[0] || '系统自动通过')}</span>
  </button>`;
}

function queueGroup(status, pageRows, forceSummary) {
  const all = M.todayTargets.filter(t => t.type === '无人机' && t.legal === status
    && (st.region === '全部' || t.district === st.region));
  const rows = pageRows.filter(t => t.legal === status);
  if (!rows.length && !forceSummary) return '';
  const tone = status === '非法' ? 'red' : status === '待确认' ? 'amber' : 'green';
  const label = status === '非法' ? '系统判定非法' : status === '待确认' ? '系统待确认' : '系统自动通过';
  return `<section class="lg-queue-group is-${tone}">
    <button class="lg-group-head" data-chip-set="${status}" aria-label="筛选${label}">
      <span class="lg-group-caret">${U.icon('play')}</span><b>${label}（${all.length}）</b>
      <span>查看${label}目标</span></button>
    ${rows.length ? `<div class="lg-group-rows">${rows.map(queueRow).join('')}</div>` : ''}
  </section>`;
}

function list() {
  const rows = orderedTargets();
  const page = rows.slice((st.page - 1) * st.size, st.page * st.size);
  totalCount.value = rows.length;
  const order = ['非法', '待确认', '合法'];
  const groups = order.map(s => queueGroup(s, page, st.legal === '待处理' && s === '合法')).join('');
  return `<div class="lg-queue-columns" aria-hidden="true">
      <span>目标 / 时间</span><span>系统判定</span><span>风险等级</span><span>区域</span><span>主要原因</span>
    </div>
    <div class="lg-queue-scroll">${groups || '<div class="empty">当前筛选条件下没有研判目标</div>'}</div>`;
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
  if (evidenceTab.value !== 'space' || !document.getElementById('lgMap')) return;
  drawDetailMap();
}
function drawDetailMap() {
  const box = document.getElementById('lgMap');
  if (!box) return;
  if (detMap) { try { detMap.destroy(); } catch (e) { } detMap = null; }
  const t = st.sel; if (!t) return;
  detMap = new window.MapView(box, { zoom: 3.2, maxDev: 0, maxAlarm: 0, legend: false,
    showAirspaceLabels: true, showTargetLabels: false, layers: { device: false, alarm: false } });
  const plan = t.matched_plan_id ? M.flightPlans.find(p => p.id === t.matched_plan_id) : null;
  const route = M.routeById && M.routeById(t.routeId || (plan && plan.routeId));
  const draw0 = detMap.draw.bind(detMap);
  detMap.draw = function () {
    draw0();
    if (!route || !route.waypoints || route.waypoints.length < 2) return;
    const c2 = this.ctx;
    c2.save();
    c2.beginPath();
    route.waypoints.forEach((w, i) => {
      const q = this.px(w.lon, w.lat);
      i ? c2.lineTo(q[0], q[1]) : c2.moveTo(q[0], q[1]);
    });
    c2.setLineDash([7, 4]); c2.strokeStyle = '#256dff'; c2.lineWidth = 1.8; c2.stroke(); c2.setLineDash([]);
    route.waypoints.forEach(w => {
      const q = this.px(w.lon, w.lat);
      c2.beginPath(); c2.arc(q[0], q[1], 2.3, 0, Math.PI * 2); c2.fillStyle = '#4b9cff'; c2.fill();
    });
    c2.restore();
  };
  const mapTarget = Object.assign({}, t, { track: t.track_points || t.track || [] });
  detMap.setData({ airspaces: M.airspaces, devices: [], alarms: [], targets: [mapTarget] });
  detMap.sel = mapTarget.id;
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
  const noOp = !M.can('合法性判定', 'op');
  const btn = (k, label, cls, dis, tip) =>
    `<button class="btn ${cls || ''}" data-lg="${k}" ${dis || noOp ? 'disabled' : ''} title="${noOp ? '当前角色仅可查看，不能修改判定' : (tip || '')}"
      style="flex:1;height:36px;justify-content:center">${label}</button>`;
  if (t.legal === '合法') return U.detailActions(
    btn('revise', '人工复核（改判）', 'warn', false, '合法目标可查看可复核，不提供转办入口'));
  if (t.legal === '待确认') return U.detailActions(
    btn('confirm', '人工复核', 'pri', false, '补充核验并定性（合法 / 非法）'));
  /* 「转告警工单」已按用户裁定整体删除（2026-08-30）：非法目标绝大多数本就带关联告警
     （按钮常年置灰），演示上有意义的流转只有复核与转入处置。toAlarmFlow 逻辑保留不再有入口。 */
  if (t.legal === '非法') return U.detailActions(
    btn('revise', '人工复核', 'pri', false, '复核判定依据，可改判')
    + btn('tocase', '转入处置', 'warn', false, c ? `已有处置记录 ${c.id}，点击转到处置处罚` : '生成处置记录并进入处置处罚模块'));
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
  const log = t.reviewLog || [];
  const lastReview = log.length ? log[log.length - 1] : null;
  const primary = vlist(t)[0] || (t.legal === '合法' ? '各项规则校验通过' : '关键判据需要补充核验');
  const plan = t.matched_plan_id ? M.flightPlans.find(p => p.id === t.matched_plan_id) : null;
  const alarm = linkedAlarm(t), kase = linkedCase(t);
  const tone = t.legal === '合法' ? 'green' : t.legal === '非法' ? 'red' : 'amber';
  const resultTx = i => i.s === 'pass' ? '通过' : i.s === 'fail' ? '不通过'
    : i.r.id === 'C01' ? '部分匹配' : '无法判定';
  const influenceTx = i => {
    if (i.s === 'fail' && ['C02-1', 'C02-2', 'C02-4'].includes(i.r.id)) return '一票否决';
    if (i.s === 'warn' && i.r.id === 'C01') return '降低置信度';
    if (i.s === 'warn') return '不可视为通过';
    return '—';
  };
  const basisItems = j.items.filter(i => i.r.id !== 'C03');
  const compactMsg = s => esc(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const basisRows = basisItems.map((i, idx) => `<button class="lg-basis-row${basisSel.value === idx ? ' is-selected' : ''}"
      data-basis="${idx}" aria-pressed="${basisSel.value === idx}">
      <span>${idx + 1}</span><span><b>${i.r.n}</b><small>${i.r.id}</small></span>
      <span class="is-${i.s}">${U.stateIcon(i.s, false)} ${resultTx(i)}</span>
      <span class="lg-impact is-${i.s}">${influenceTx(i)}</span><span title="${compactMsg(i.msg)}">${compactMsg(i.msg)}</span>
    </button>`).join('');
  const selectedBasis = basisItems[Math.min(basisSel.value, basisItems.length - 1)] || basisItems[0];
  const hits = spaceHits(t);
  const pts = t.track_points || t.track || [];
  const firstHit = hits[0];
  const evidenceTabs = [
    ['space', 'zone', '空间位置证据'], ['rules', 'settings', '规则依据'],
    ['raw', 'database', '原始数据'], ['related', 'link', '相关资源']
  ].map(([k, icon, label]) => `<button class="lg-evidence-tab${evidenceTab.value === k ? ' is-active' : ''}"
      data-evidence-tab="${k}" aria-selected="${evidenceTab.value === k}">${U.icon(icon)} ${label}</button>`).join('');
  let evidenceBody = '';
  if (evidenceTab.value === 'space') {
    evidenceBody = `<div class="lg-evidence-copy"><h4>证据说明</h4>
      <p>目标轨迹${firstHit ? `命中“${esc(firstHit.v)}”` : '未发现空间类违规'}，轨迹共持续 ${Math.max(1, Math.round(t.durMin || 1))} 分钟。</p>
      <dl><dt>进入时间</dt><dd>${t.time}</dd><dt>轨迹时长</dt><dd>${Math.max(1, Math.round(t.durMin || 1))} 分钟</dd>
        <dt>轨迹位置</dt><dd class="mono">${t.lat.toFixed(4)}°N, ${t.lon.toFixed(4)}°E</dd>
        <dt>轨迹点数</dt><dd>${pts.length || '—'}</dd></dl>
      ${firstHit ? `<p class="lg-evidence-alert">${esc(firstHit.how)}</p>` : ''}
      <button class="lg-link-btn" data-lg-nav="center">重新定位地图</button></div>
      <div class="lg-map-wrap"><div id="lgMap" aria-label="目标轨迹与空域关系地图"></div>
        <div class="lg-map-legend"><span class="is-zone">禁飞区</span><span class="is-plan">批准航线</span><span class="is-track">实际轨迹</span></div></div>`;
  } else if (evidenceTab.value === 'rules') {
    evidenceBody = `<div class="lg-evidence-wide"><h4>${selectedBasis.r.n} <span>${selectedBasis.r.id}</span></h4>
      <div class="lg-rule-focus is-${selectedBasis.s}">${U.stateIcon(selectedBasis.s, false)} ${resultTx(selectedBasis)}</div>
      <p>${selectedBasis.msg}</p><p class="lg-muted">规则说明：${selectedBasis.r.d}</p></div>`;
  } else if (evidenceTab.value === 'raw') {
    evidenceBody = `<div class="lg-evidence-wide">${U.kv([
      ['目标编号', `<span class="mono">${t.id}</span>`], ['发现时间', t.time], ['目标类型', t.subtype || t.type],
      ['归属单位', t.partner || '—'], ['飞手', t.pilot || '—'], ['距地高度', t.heightAgl != null ? t.heightAgl + ' m' : '未上报'],
      ['海拔高度', t.alt + ' m'], ['速度', t.speed + ' m/s'], ['数据来源', `${t.source}（${U.confPct(t.source_confidence)}）`]
    ], { surface: true, density: 'compact' })}</div>`;
  } else {
    evidenceBody = `<div class="lg-evidence-wide">${U.kv([
      ['批准计划', plan ? `<span class="mono">${plan.id}</span>` : '无有效计划'],
      ['关联告警', alarm ? `<span class="mono">${alarm.id}</span> · ${alarm.status}` : '无关联告警'],
      ['处置记录', kase ? `<span class="mono">${kase.id}</span> · ${kase.status}` : '尚未生成'],
      ['空域规则', firstHit && firstHit.zone ? `${firstHit.zone.name} · ${firstHit.zone.id}` : '未命中空间类规则'],
      ['复核记录', log.length ? `${log.length} 条，最近由 ${esc(lastReview.operator)}` : '暂无人工复核记录']
    ], { surface: true, density: 'compact' })}</div>`;
  }
  return `<div class="lg-review-head"><span>当前目标：<b class="mono">${t.id}</b></span>${U.risk(t.risk)}
      <span class="lg-head-spacer"></span><button class="btn" data-lg-nav="next">切换目标</button>
      <button class="lg-icon-btn" data-lg-nav="prev" aria-label="上一个目标">${U.icon('play')}</button>
      <button class="lg-icon-btn is-next" data-lg-nav="next" aria-label="下一个目标">${U.icon('play')}</button></div>
    <div class="lg-detail-scroll">
      <section class="lg-verdict-card is-${tone}">
        <div class="lg-verdict-block"><span class="lg-verdict-icon">${U.icon(t.legal === '合法' ? 'shield' : 'alert')}</span>
          <div><small>系统判定</small><strong>${t.legal}</strong><span>${j.gated ? '证据不足，结论已自动收敛' : '依据规则引擎判定'}</span></div></div>
        <div class="lg-core-reason"><small>核心原因</small><b>${esc(primary)}</b><span>依据规则：${basisItems.filter(i => i.s === 'fail').map(i => i.r.id).join('、') || 'C01–C02 综合判定'}</span></div>
        <div class="lg-target-facts"><dl><dt>发现时间</dt><dd>${t.time}</dd><dt>实测高度</dt><dd>${t.heightAgl != null ? t.heightAgl + ' m（距地）' : t.alt + ' m（海拔）'}</dd>
          <dt>归属单位</dt><dd>${t.partner || '—'}</dd><dt>飞手</dt><dd>${t.pilot || '—'}</dd></dl></div>
        <div class="lg-review-state"><small>人工复核状态</small>${manual ? U.tag('已复核', 't-green') : U.tag(t.legal === '合法' ? '无需复核' : '待复核', t.legal === '合法' ? 't-green' : 't-blue')}
          <dl><dt>人工结论</dt><dd>${manual ? t.legal : '未出'}</dd><dt>复核人</dt><dd>${lastReview ? esc(lastReview.operator) : '—'}</dd><dt>复核时间</dt><dd>${lastReview ? lastReview.at : '—'}</dd></dl></div>
      </section>
      <section class="lg-basis-card"><header><b>判定依据总表</b><span>（点击行查看证据详情）</span></header>
        <div class="lg-basis-columns" aria-hidden="true"><span>序号</span><span>判定项</span><span>结果</span><span>影响</span><span>说明</span></div>
        <div class="lg-basis-table">${basisRows}</div></section>
      <section class="lg-evidence-card"><header><b>证据详情</b><span>${evidenceTab.value === 'space' ? '（空间位置校验）' : ''}</span></header>
        <div class="lg-evidence-tabs" role="tablist">${evidenceTabs}</div><div class="lg-evidence-body">${evidenceBody}</div></section>
      ${reviewSect(t)}
    </div>
    <div class="lg-action-dock">${actionBar(t)}</div>`;
}

function drawRing() {
  const el = document.getElementById('lgScore');
  if (!el || !st.sel) return;
  const j = judge(st.sel);
  CH.ring(el, { value: j.score, color: j.score >= 67 ? '#ff4d5e' : j.score >= 34 ? '#ffb020' : '#2fd06e', fs: 16, fmt: v => v });
}

function paint() {
  CH.disposeAll();
  const k = document.getElementById('lgKpi'); if (k) k.innerHTML = kpiHtml();
  const qn = document.getElementById('lgQueueN');
  if (qn) qn.textContent = `（${M.todayTargets.filter(t => t.type === '无人机'
    && (t.legal === '非法' || t.legal === '待确认')
    && (st.region === '全部' || t.district === st.region)).length}）`;
  document.getElementById('lgList').innerHTML = list();
  document.getElementById('lgDetail').innerHTML = detail();
  drawRing();
  bindSpaceMap();
}
function refresh() { paint(); }

onUnmounted(() => { if (detMap) { try { detMap.destroy(); } catch (e) { } detMap = null; } });

function onPage(p2) { st.page = p2; paint(); }
function onPageSize(s2) { st.size = s2; st.page = 1; paint(); }

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
    basisSel.value = 0; evidenceTab.value = 'space'; paint();
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
  /* 分页交互已由模板层 <n-pagination> 受控接管（P2），[data-pg]/[data-size] 委托删除 */
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; paint(); });
  U.on(view, '[data-basis]', 'click', (e, el) => {
    basisSel.value = Number(el.dataset.basis) || 0;
    evidenceTab.value = 'rules';
    document.getElementById('lgDetail').innerHTML = detail();
    bindSpaceMap();
  });
  U.on(view, '[data-evidence-tab]', 'click', (e, el) => {
    evidenceTab.value = el.dataset.evidenceTab;
    document.getElementById('lgDetail').innerHTML = detail();
    bindSpaceMap();
  });
  U.on(view, '[data-lg-nav]', 'click', (e, el) => {
    const k = el.dataset.lgNav;
    if (k === 'center') {
      if (detMap && st.sel) detMap.centerAt(st.sel.lon, st.sel.lat);
      return;
    }
    const rows = orderedTargets();
    if (!rows.length) return;
    const at = Math.max(0, rows.findIndex(t => st.sel && t.id === st.sel.id));
    const next = k === 'prev' ? (at - 1 + rows.length) % rows.length : (at + 1) % rows.length;
    st.sel = rows[next];
    st.page = Math.floor(next / st.size) + 1;
    basisSel.value = 0; evidenceTab.value = 'space'; paint();
  });
  U.on(view, '[data-lg]', 'click', (e, el) => {
    const k = el.dataset.lg;
    if (!st.sel) return;
    if (!M.can('合法性判定', 'op')) {
      M.pushAudit('合法性判定', '判定操作被拒绝：无操作权限', st.sel.id, '失败');
      return toast('需要「合法性判定」操作权限', 'err');
    }
    if (k === 'confirm') decisionConfirmModal();
    else if (k === 'revise') manualReviseModal();
    else if (k === 'toalarm') toAlarmFlow();
    else if (k === 'tocase') toCaseFlow();
    else if (k === 'degrade') {
      const t = st.sel;
      if (t.legal !== '非法') { toast('该目标当前判定已非「非法」，无需重复降级', 'ok'); return; }
      const c = M.cases.find(x => x.targetId === t.id);
      const rsn = '证据不足降级：判定时刻无 uavSN 数据源（需协议破解 dcd / RemoteID rid 设备），身份匹配仅能依据时间窗 + 空间范围，不足以定性为非法'
        + (c ? '。该目标已有处置记录 ' + c.id + '，须在处置处罚管理同步复核案件' : '');
      const from = applyReview(t, '待确认', rsn, '证据不足降级');
      const req = c ? raiseReviewRequest(t, c, from, '待确认', rsn, OPER) : null;
      refresh();
      toast('已按证据不足降级为「待确认」，原判定「非法」保留可查'
        + (req ? `；已对案件 ${c.id} 发起复核请求 <b>${req.id}</b>` : ''), 'ok');
    }
  });
  document.getElementById('lgRecalc').onclick = () => {
    if (!M.can('合法性判定', 'op')) return toast('需要「合法性判定」操作权限', 'err');
    const all = targets();
    const kept = all.filter(revised).length;
    refresh();
    toast(`已按当前规则重新判定今日 ${all.length} 个目标`
      + (kept ? `；其中 ${kept} 个已人工改判的结果<b>不被引擎覆盖</b>（设计 8.6）` : ''), 'ok');
  };
  document.getElementById('lgRule').onclick = () => openModal({
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
  <div class="view legality-workbench" id="view" ref="root">
    <div class="lg-shell">
      <div id="lgKpi" class="lg-kpi-host" aria-label="今日合法性判定统计"></div>
      <div class="lg-workspace">
        <section class="lg-queue-panel" aria-label="待人工复核目标队列">
          <header class="lg-panel-head">
            <h2>待人工复核 <span id="lgQueueN"></span></h2>
            <span class="lg-head-spacer"></span>
            <label class="lg-region-filter"><span>区域</span>
              <n-select v-model:value="st.region" :options="regionOptions" :clearable="false" aria-label="区域" />
            </label>
            <button class="lg-icon-btn" id="lgRule" type="button" aria-label="查看判定规则" title="判定规则说明" v-html="U.icon('settings')"></button>
            <button class="lg-icon-btn" id="lgRecalc" type="button" aria-label="重新判定" title="重新判定" v-html="U.icon('refresh')"></button>
          </header>
          <div class="lg-queue-tabs" role="tablist" aria-label="判定状态筛选">
            <button :class="{ 'is-active': st.legal === '待处理' || st.legal === '非法' }" data-chip-set="待处理">系统判定非法</button>
            <button :class="{ 'is-active': st.legal === '待确认' }" data-chip-set="待确认">系统待确认</button>
            <button :class="{ 'is-active': st.legal === '合法' }" data-chip-set="合法">系统自动通过</button>
          </div>
          <div id="lgList" class="lg-list-host"></div>
          <footer class="lg-pager">
            <n-pagination :page="st.page" :page-size="st.size" :item-count="totalCount"
              show-size-picker :page-sizes="[10, 20, 50]"
              @update:page="onPage" @update:page-size="onPageSize">
              <template #prefix>共 {{ totalCount.toLocaleString() }} 条</template>
              <template #suffix>共 {{ pageCount }} 页</template>
            </n-pagination>
          </footer>
        </section>
        <section class="lg-review-panel" aria-label="合法性研判详情">
          <span id="lgSt" class="lg-hidden-status"></span>
          <div id="lgDetail" class="lg-detail-host"></div>
        </section>
      </div>
    </div>
  </div>
</template>

<style>
.legality-workbench{--lg-blue:#4b9cff;--lg-red:#ff5b61;--lg-green:#41d49a;--lg-amber:#f1a43a;overflow:hidden!important;padding:10px 12px 12px!important}
.legality-workbench *{box-sizing:border-box}
.legality-workbench button{font:inherit}
.legality-workbench button:focus-visible,.legality-workbench select:focus-visible{outline:2px solid var(--lg-blue);outline-offset:2px}
.legality-workbench .lg-shell{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px}
.legality-workbench .lg-kpi-host{flex:none}.legality-workbench .lg-kpi-host>.kpis{grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.legality-workbench .lg-kpi-host .kpi{min-width:0}
.legality-workbench .lg-workspace{min-height:0;flex:1;display:grid;grid-template-columns:minmax(430px,32%) minmax(0,1fr);gap:10px}
.legality-workbench .lg-queue-panel,.legality-workbench .lg-review-panel{min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid rgba(130,174,218,.17);border-radius:8px;background:#091827;overflow:hidden;box-shadow:0 10px 24px rgba(0,0,0,.14)}
.legality-workbench .lg-panel-head,.legality-workbench .lg-review-head{height:46px;min-height:46px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid rgba(130,174,218,.12);background:#0b1b2d}
.legality-workbench .lg-panel-head h2{margin:0;color:#dfe9f5;font-size:14px;font-weight:650}.legality-workbench .lg-panel-head h2 span{color:var(--lg-amber)}
.legality-workbench .lg-head-spacer{flex:1}
.legality-workbench .lg-region-filter{display:flex;align-items:center;gap:6px;color:#7f93aa;font-size:11px}.legality-workbench .lg-region-filter .n-select{width:112px}
.legality-workbench .lg-icon-btn{width:32px;height:30px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(130,174,218,.16);border-radius:5px;background:#0b1b2d;color:#91a6bd;cursor:pointer}.legality-workbench .lg-icon-btn:hover{color:#dce9f8;border-color:rgba(75,156,255,.5)}
.legality-workbench .lg-icon-btn .svg-icon{width:15px;height:15px;fill:none;stroke:currentColor}.legality-workbench .lg-review-head .lg-icon-btn .svg-icon{transform:rotate(180deg)}.legality-workbench .lg-review-head .lg-icon-btn.is-next .svg-icon{transform:none}
.legality-workbench .lg-queue-tabs{height:42px;min-height:42px;display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid rgba(130,174,218,.09)}
.legality-workbench .lg-queue-tabs button{height:28px;padding:0 12px;border:1px solid transparent;border-radius:5px;background:transparent;color:#8498af;font-size:11.5px;cursor:pointer}.legality-workbench .lg-queue-tabs button:hover{color:#dfeaf7}.legality-workbench .lg-queue-tabs button.is-active{border-color:rgba(255,91,97,.25);background:rgba(255,91,97,.1);color:#ff7a80}
.legality-workbench .lg-list-host{min-height:0;flex:1;display:flex;flex-direction:column}
.legality-workbench .lg-queue-columns,.legality-workbench .lg-queue-row{display:grid;grid-template-columns:minmax(112px,1.3fr) minmax(72px,.75fr) minmax(70px,.72fr) minmax(58px,.62fr) minmax(100px,1.1fr);align-items:center;column-gap:7px}
.legality-workbench .lg-queue-columns{height:34px;min-height:34px;padding:0 12px;color:#8195ad;font-size:11px;border-bottom:1px solid rgba(130,174,218,.1);background:#0a1a2c}
.legality-workbench .lg-queue-scroll{min-height:0;flex:1;overflow:auto;scrollbar-width:thin}
.legality-workbench .lg-queue-group{border-bottom:1px solid rgba(130,174,218,.09)}
.legality-workbench .lg-group-head{width:100%;height:32px;padding:0 11px;display:flex;align-items:center;gap:7px;border:0;border-bottom:1px solid rgba(130,174,218,.07);background:#0b1d30;color:#93a7bd;text-align:left;cursor:pointer}.legality-workbench .lg-group-head b{font-size:11.5px}.legality-workbench .lg-group-head>span:last-child{margin-left:auto;color:#61758d;font-size:10px}
.legality-workbench .lg-group-caret{width:13px;height:13px;display:flex;align-items:center;justify-content:center}.legality-workbench .lg-group-caret .svg-icon{width:10px;height:10px;fill:none;stroke:currentColor;transform:rotate(90deg)}
.legality-workbench .lg-queue-group.is-red .lg-group-head b{color:#ff686f}.legality-workbench .lg-queue-group.is-amber .lg-group-head b{color:#e6a130}.legality-workbench .lg-queue-group.is-green .lg-group-head b{color:#37c488}
.legality-workbench .lg-queue-row{width:100%;min-height:49px;padding:5px 12px;border:0;border-bottom:1px solid rgba(130,174,218,.065);background:#091827;color:#b7c5d5;text-align:left;cursor:pointer}.legality-workbench .lg-queue-row:hover{background:#0d2238}.legality-workbench .lg-queue-row.is-selected{background:#0f2b4c;box-shadow:inset 2px 0 var(--lg-blue),inset 0 0 0 1px rgba(75,156,255,.5)}
.legality-workbench .lg-queue-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legality-workbench .lg-row-target{display:flex;flex-direction:column}.legality-workbench .lg-row-target b{color:#d8e5f3;font-size:11px}.legality-workbench .lg-row-target small{color:#70859d;font-size:10px}.legality-workbench .lg-row-note{display:block;margin-top:2px;color:#c5a7ff;font-size:9px}.legality-workbench .lg-row-note.is-amber{color:#e7ad55}.legality-workbench .lg-row-region,.legality-workbench .lg-row-reason{font-size:10.5px}
.legality-workbench .lg-pager{height:50px;min-height:50px;display:flex;align-items:center;justify-content:center;padding:5px 8px;border-top:1px solid rgba(130,174,218,.1);background:#091725;overflow:hidden;white-space:nowrap}.legality-workbench .lg-pager .n-pagination{flex-wrap:nowrap!important;column-gap:3px!important}.legality-workbench .lg-pager .n-pagination-prefix,.legality-workbench .lg-pager .n-pagination-suffix{white-space:nowrap;font-size:11px}
.legality-workbench .lg-hidden-status{display:none}.legality-workbench .lg-detail-host{height:100%;min-height:0;display:flex;flex-direction:column}.legality-workbench .lg-review-head{color:#879bb2;font-size:12px}.legality-workbench .lg-review-head b{color:#c8d7e8}.legality-workbench .lg-review-head>.tag{margin-left:4px}
.legality-workbench .lg-detail-scroll{min-height:0;flex:1;overflow:auto;padding:9px;scrollbar-width:thin}
.legality-workbench .lg-verdict-card{min-height:116px;display:grid;grid-template-columns:1.05fr 1.55fr 1.05fr .92fr;border:1px solid rgba(130,174,218,.13);border-radius:7px;background:#0b1b2d;overflow:hidden}.legality-workbench .lg-verdict-card>div{min-width:0;padding:12px;border-right:1px solid rgba(130,174,218,.1)}.legality-workbench .lg-verdict-card>div:last-child{border-right:0}
.legality-workbench .lg-verdict-block{display:flex;align-items:center;gap:10px}.legality-workbench .lg-verdict-icon{width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,91,97,.11);color:var(--lg-red)}.legality-workbench .lg-verdict-icon .svg-icon{width:20px;height:20px;fill:none;stroke:currentColor}.legality-workbench .lg-verdict-block>div{min-width:0;display:flex;flex-direction:column}.legality-workbench .lg-verdict-card small{color:#7f92a8;font-size:10px}.legality-workbench .lg-verdict-block strong{margin:2px 0;color:var(--lg-red);font-size:24px;font-weight:600}.legality-workbench .lg-verdict-card.is-green .lg-verdict-block strong,.legality-workbench .lg-verdict-card.is-green .lg-verdict-icon{color:var(--lg-green)}.legality-workbench .lg-verdict-card.is-amber .lg-verdict-block strong,.legality-workbench .lg-verdict-card.is-amber .lg-verdict-icon{color:var(--lg-amber)}.legality-workbench .lg-verdict-block span,.legality-workbench .lg-core-reason span{color:#788ca3;font-size:10px}
.legality-workbench .lg-core-reason{display:flex;flex-direction:column;justify-content:center}.legality-workbench .lg-core-reason b{margin:7px 0;color:#e3edf8;font-size:14px;white-space:normal}.legality-workbench .lg-target-facts dl,.legality-workbench .lg-review-state dl{margin:0;display:grid;grid-template-columns:64px minmax(0,1fr);gap:5px 7px;font-size:10px}.legality-workbench .lg-target-facts dt,.legality-workbench .lg-review-state dt{color:#6f839b}.legality-workbench .lg-target-facts dd,.legality-workbench .lg-review-state dd{margin:0;color:#b9c7d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legality-workbench .lg-review-state{display:flex;flex-direction:column;gap:7px}.legality-workbench .lg-review-state>.tag{align-self:flex-start}
.legality-workbench .lg-basis-card,.legality-workbench .lg-evidence-card{margin-top:9px;border:1px solid rgba(130,174,218,.12);border-radius:7px;background:#091827;overflow:hidden}.legality-workbench .lg-basis-card>header,.legality-workbench .lg-evidence-card>header{height:34px;display:flex;align-items:center;gap:5px;padding:0 11px;color:#d5e1ee;font-size:12px;border-bottom:1px solid rgba(130,174,218,.09)}.legality-workbench .lg-basis-card>header span,.legality-workbench .lg-evidence-card>header span{color:#667b93;font-size:10px}
.legality-workbench .lg-basis-columns,.legality-workbench .lg-basis-row{display:grid;grid-template-columns:45px minmax(140px,1fr) minmax(102px,.72fr) minmax(92px,.66fr) minmax(220px,2.35fr);align-items:center;column-gap:8px}.legality-workbench .lg-basis-columns{height:28px;padding:0 10px;background:#0b1c2f;color:#6f849b;font-size:10px}.legality-workbench .lg-basis-row{width:100%;height:26px;min-height:26px;padding:2px 10px;border:0;border-top:1px solid rgba(130,174,218,.055);background:transparent;color:#aebdcd;text-align:left;font-size:10.5px;cursor:pointer}.legality-workbench .lg-basis-row:hover{background:#0d2238}.legality-workbench .lg-basis-row.is-selected{background:#10305a;box-shadow:inset 0 0 0 1px #2f82ef}.legality-workbench .lg-basis-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legality-workbench .lg-basis-row>span:nth-child(2){display:flex;align-items:baseline;gap:6px}.legality-workbench .lg-basis-row small{color:#61768e}.legality-workbench .lg-basis-row .is-pass{color:#38c98a}.legality-workbench .lg-basis-row .is-warn{color:#e4a22e}.legality-workbench .lg-basis-row .is-fail{color:#ff656c}.legality-workbench .lg-basis-row .svg-icon{width:12px;height:12px;vertical-align:-2px}
.legality-workbench .lg-evidence-tabs{height:36px;display:flex;align-items:end;gap:3px;padding:4px 8px 0;border-bottom:1px solid rgba(130,174,218,.09);background:#0a1a2c}.legality-workbench .lg-evidence-tab{height:31px;padding:0 12px;display:flex;align-items:center;gap:5px;border:1px solid rgba(130,174,218,.08);border-bottom:0;border-radius:5px 5px 0 0;background:#0b1b2d;color:#7c91a9;font-size:10.5px;cursor:pointer}.legality-workbench .lg-evidence-tab.is-active{background:#103666;color:#dbeaff;border-color:rgba(75,156,255,.35)}.legality-workbench .lg-evidence-tab .svg-icon{width:12px;height:12px;fill:none;stroke:currentColor}
.legality-workbench .lg-evidence-body{height:175px;min-height:175px;display:grid;grid-template-columns:minmax(260px,35%) minmax(0,1fr);gap:9px;padding:8px}.legality-workbench .lg-evidence-copy,.legality-workbench .lg-evidence-wide{min-width:0;overflow:auto;padding:7px 10px;border:1px solid rgba(130,174,218,.08);border-radius:6px;background:#0a1a2b}.legality-workbench .lg-evidence-wide{grid-column:1/-1}.legality-workbench .lg-evidence-copy h4,.legality-workbench .lg-evidence-wide h4{margin:0 0 5px;color:#cbd9e7;font-size:11.5px}.legality-workbench .lg-evidence-copy h4 span,.legality-workbench .lg-evidence-wide h4 span{color:#657a92;font-size:10px}.legality-workbench .lg-evidence-copy p,.legality-workbench .lg-evidence-wide p{margin:4px 0;color:#8fa1b5;font-size:10px;line-height:1.45}.legality-workbench .lg-evidence-copy dl{margin:5px 0;display:grid;grid-template-columns:67px 1fr;gap:3px;font-size:9.5px}.legality-workbench .lg-evidence-copy dt{color:#657b93}.legality-workbench .lg-evidence-copy dd{margin:0;color:#b5c4d4}.legality-workbench .lg-evidence-alert{padding-left:7px;border-left:2px solid var(--lg-red);color:#d59b9f!important}.legality-workbench .lg-link-btn{padding:0;border:0;background:transparent;color:var(--lg-blue);font-size:10px;cursor:pointer}.legality-workbench .lg-rule-focus{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:4px;background:#0d2238}.legality-workbench .lg-rule-focus.is-pass{color:var(--lg-green)}.legality-workbench .lg-rule-focus.is-warn{color:var(--lg-amber)}.legality-workbench .lg-rule-focus.is-fail{color:var(--lg-red)}.legality-workbench .lg-muted{color:#6e839a!important}
.legality-workbench .lg-map-wrap{position:relative;min-width:0;min-height:159px;border:1px solid rgba(130,174,218,.12);border-radius:6px;overflow:hidden;background:#dbe7ef}.legality-workbench #lgMap{position:absolute;inset:0}.legality-workbench .lg-map-legend{position:absolute;left:50%;bottom:5px;transform:translateX(-50%);display:flex;gap:13px;padding:3px 9px;border-radius:4px;background:rgba(5,15,27,.88);color:#c4d2e0;font-size:9px;white-space:nowrap}.legality-workbench .lg-map-legend span:before{content:"";display:inline-block;width:14px;height:3px;margin-right:4px;vertical-align:2px;background:currentColor}.legality-workbench .lg-map-legend .is-zone{color:#d84d52}.legality-workbench .lg-map-legend .is-plan{color:#4b9cff}.legality-workbench .lg-map-legend .is-track{color:#ff5b61}
.legality-workbench .lg-action-dock{min-height:52px;padding:6px 9px;border-top:1px solid rgba(130,174,218,.12);background:#081522}.legality-workbench .lg-action-dock .detail-actions{margin:0;padding:0;background:transparent;border:0}.legality-workbench .lg-action-dock .btn{height:38px!important;font-size:14px}.legality-workbench .detail-sect{margin-inline:0}
@media (max-width:1320px){.legality-workbench .lg-workspace{grid-template-columns:minmax(410px,38%) minmax(0,1fr)}.legality-workbench .lg-verdict-card{grid-template-columns:1fr 1.4fr 1fr}.legality-workbench .lg-review-state{grid-column:1/-1;border-top:1px solid rgba(130,174,218,.1)!important}.legality-workbench .lg-verdict-card{min-height:154px}.legality-workbench .lg-review-state{flex-direction:row;align-items:center}.legality-workbench .lg-review-state dl{flex:1;grid-template-columns:60px 1fr 60px 1fr}}
@media (max-width:1040px){.legality-workbench{overflow:auto!important}.legality-workbench .lg-shell{height:auto;min-height:100%}.legality-workbench .lg-kpi-host>.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.legality-workbench .lg-workspace{grid-template-columns:1fr}.legality-workbench .lg-queue-panel{min-height:620px}.legality-workbench .lg-review-panel{min-height:720px}.legality-workbench .lg-evidence-body{grid-template-columns:1fr}.legality-workbench .lg-map-wrap{min-height:260px}}
@media (prefers-reduced-motion:reduce){.legality-workbench *{scroll-behavior:auto!important;transition:none!important}}
</style>
