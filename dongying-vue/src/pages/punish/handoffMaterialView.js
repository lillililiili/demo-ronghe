/* 处罚交接材料里的当事人、研判和移送时证据链（2026-10-06）。只整理展示，不改冻结的材料。
   旧材料没有这几段时返回 null，页面不显示，不拿现在的数据补。 */
import { EVIDENCE_KIND_LABEL, LEGALITY_LABEL, PLAN_MATCH_LABEL, labelOf } from '../../ui/labels.js';
import { COMMAND_TYPE_LABEL, EVIDENCE_CATEGORY_LABEL } from '../../services/evidenceLedger.js';

const BASIS_LABEL = { EVENT_ALARM: '告警依据的研判', LATEST: '移送时最新研判' };
const REVIEW_LABEL = { PENDING_REVIEW: '待人工复核', CONFIRMED: '人工已确认', REJECTED: '人工已驳回', OVERRIDDEN: '人工已改判', SUPERSEDED: '已被重新研判取代' };

function reviewText(row) {
  if (row.review_state === 'OVERRIDDEN' && row.manual_status) return `人工改判为${labelOf(LEGALITY_LABEL, row.manual_status)}`;
  if (row.manual_status) return `人工结论：${labelOf(LEGALITY_LABEL, row.manual_status)}`;
  return REVIEW_LABEL[row.review_state] || '';
}

export function partyView(material) {
  const party = material?.party;
  if (!party) return null;
  const clues = { plan: party.plan_no || '', uavSn: party.uav_sn || '' };
  if (party.status === 'IDENTIFIED') {
    const lines = [party.pilot_name ? `飞手：${party.pilot_name}` : '', party.operator_name ? `运营单位：${party.operator_name}` : ''].filter(Boolean);
    return { unidentified: false, title: '当事人已明确', lines, ...clues };
  }
  return { unidentified: true, title: party.label || '当事人不明，按待补线索移送', lines: Array.isArray(party.reasons) ? party.reasons : [], ...clues };
}

/** reasonText 由页面传入（研判原因码的中文说明），这里不依赖弹窗模块。旧材料没有研判段时返回 null，空数组表示移送时没有找到研判。 */
export function judgmentViews(material, reasonText = code => String(code || '')) {
  if (!Array.isArray(material?.judgments)) return null;
  return material.judgments.map(row => ({
    key: row.evaluation_id,
    basisCode: row.basis,
    basis: BASIS_LABEL[row.basis] || '研判',
    legal: labelOf(LEGALITY_LABEL, row.legal_status, '结论未提供'),
    review: reviewText(row),
    planMatch: row.plan_match_code ? `任务匹配：${labelOf(PLAN_MATCH_LABEL, row.plan_match_code)}` : '',
    // 无匹配计划时研判里留的是比对过的候选计划，不能写成“报备计划”，和研判页说法一致。
    plan: !row.plan_no ? '' : row.plan_match_code === 'NONE' ? `候选任务 ${row.plan_no}（未匹配上这条任务）` : `报备任务 ${row.plan_no}`,
    reasons: (row.violation_reasons || []).map(reasonText).filter(Boolean),
    unknowns: (row.unknown_reasons || []).map(reasonText).filter(Boolean),
    evaluatedAt: row.evaluated_at ?? null,
    tone: row.legal_status === 'ILLEGAL' ? 't-red' : row.legal_status === 'LEGAL' ? 't-green' : 't-gray'
  }));
}

function itemName(row) {
  if (row.source_kind === 'COMMAND') return labelOf(COMMAND_TYPE_LABEL, row.name, '设备指令');
  if (row.source_kind === 'TRACK') return `${row.name ? `目标 ${row.name} 的` : '目标'}${row.layer === 'FUSED' ? '融合' : '来源'}轨迹`;
  return row.name || labelOf(EVIDENCE_KIND_LABEL, row.kind_code, '') || '证据文件';
}

/** 移送时冻结的证据链；文件带 sha256，可与证据台账逐项比对。 */
export function evidenceChainView(material) {
  if (!Array.isArray(material?.evidence_chain)) return null;
  const rows = material.evidence_chain;
  const isTrack = row => row.category === 'TRACK' || row.source_kind === 'TRACK' || row.kind_code === 'TRACK_SNAPSHOT';
  // 材料目录必须与冻结快照逐项一致，不能仅显示最后一段融合轨迹而隐藏历史段或原始来源。
  const fused = rows.some(row => row.source_kind === 'TRACK' && row.layer === 'FUSED');
  const displayed = rows;
  const items = displayed.map(row => ({
    key: `${row.source_kind}:${row.source_id}`,
    record: row,
    category: row.source_kind === 'TRACK' ? (row.layer === 'FUSED' ? '融合轨迹' : '来源轨迹') : labelOf(EVIDENCE_CATEGORY_LABEL, row.category, '其他'),
    name: itemName(row),
    // 轨迹的编号就是内部轨迹号，对处罚部门没有意义，不显示。
    no: row.source_kind === 'TRACK' ? '' : row.evidence_no || '',
    sha256: row.sha256 || '',
    href: row.source_kind === 'FILE' ? `#/evidence?file=${encodeURIComponent(row.source_id)}` : '',
    at: row.captured_at ?? row.started_at ?? null,
    points: row.source_kind === 'TRACK' && row.point_count != null ? `${row.point_count} 个点` : ''
  }));
  return { total: items.length, items, trackUnavailable: !fused && rows.some(isTrack) };
}


/** 新材料独立冻结的实测入区依据；不读取当前风险，也不把处置核实改写为原始事件结论。 */
export function measuredRiskBasisView(material) {
  const basis = material?.measured_risk_basis;
  if (!basis || typeof basis !== 'object' || Array.isArray(basis)) return null;
  const related = !!basis.event_id && basis.event_id === material?.event?.event_id;
  const measured = basis.basis_kind === 'INDEPENDENT_MEASURED_ENTRY' && related;
  const verification = basis.risk_verification && typeof basis.risk_verification === 'object'
    && !Array.isArray(basis.risk_verification) ? basis.risk_verification : null;
  const trigger = verification?.trigger_mode === 'AUTO'
    ? (verification.automation_run_id ? '规则自动核实' : '自动核实（规则运行未记录）')
    : verification?.trigger_mode === 'MANUAL' ? '人工核实' : '核实方式未记录';
  const conclusion = { CONFIRMED: '风险属实', FALSE_POSITIVE: '误报', PENDING_VERIFICATION: '待核实' }[verification?.conclusion] || '结论未记录';
  const verificationBasis = { PREDICTION: '预测风险依据', OBSERVED: '实测风险依据' }[verification?.basis_kind] || '核实依据类型未记录';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const position = finite(basis.longitude) && finite(basis.latitude)
    ? `WGS84 ${basis.longitude}, ${basis.latitude}` : '实测位置未记录';
  const heights = [];
  if (finite(basis.altitude_amsl_m)) heights.push(`海拔 ${basis.altitude_amsl_m} 米（AMSL）`);
  if (finite(basis.height_agl_m)) heights.push(`离地 ${basis.height_agl_m} 米（AGL）`);
  const simulated = basis.simulated === true || basis.source_mode === 'replay' || basis.source_mode === 'mock';
  const source = simulated ? (basis.source_mode === 'replay' ? '模拟／回放来源' : '模拟来源')
    : basis.source_mode === 'live' ? '实时来源' : '来源未记录';
  const references = [
    ['风险记录', basis.risk_case_id], ['实测事件', basis.event_id], ['实测研判', basis.evaluation_id],
    ['关联反制授权', basis.authorization_id], ['禁飞区', basis.airspace_id], ['空域版本', basis.airspace_version_id],
    ['实测观测', basis.observation_id], ['实测轨迹点', basis.point_id], ['观测来源', basis.source_id],
    ['观测设备', basis.device_id], ['研判规则版本', basis.rule_set_version_id]
  ].filter(([, value]) => value != null && value !== '').map(([label, value]) => ({ label, value: String(value) }));
  return {
    measured, title: measured ? '已保存本禁飞区独立实测入区依据' : related ? '实测依据类型待核查' : '实测依据与原始事件关联待核查',
    observedAt: basis.observed_at ?? null, evaluatedAt: basis.evaluated_at ?? null, completedAt: basis.completed_at ?? null,
    source, simulated, position,
    altitude: heights.join('；') || '高度及基准未记录', accuracy: finite(basis.position_accuracy_m) ? `${basis.position_accuracy_m} 米` : '未记录',
    references,
    verification: verification ? { conclusion, trigger, basis: verificationBasis, at: verification.created_at ?? null,
      actor: verification.actor_name || verification.actor_id || '', ruleRun: verification.automation_run_id || '', note: verification.note || '' } : null
  };
}


export function eventMaterialStateText(material, stateLabels = {}) {
  return `原始事件记录（移送时）：${labelOf(stateLabels, material?.event?.state, '状态未提供')}`;
}
