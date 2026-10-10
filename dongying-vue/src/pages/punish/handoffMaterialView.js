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
  if (row.source_kind === 'TRACK') return row.name ? `目标 ${row.name} 的融合轨迹` : '目标融合轨迹';
  return row.name || labelOf(EVIDENCE_KIND_LABEL, row.kind_code, '') || '证据文件';
}

/** 移送时冻结的证据链；文件带 sha256，可与证据台账逐项比对。 */
export function evidenceChainView(material) {
  if (!Array.isArray(material?.evidence_chain)) return null;
  const rows = material.evidence_chain;
  const isTrack = row => row.category === 'TRACK' || row.source_kind === 'TRACK' || row.kind_code === 'TRACK_SNAPSHOT';
  const fused = rows.filter(row => row.source_kind === 'TRACK' && row.layer === 'FUSED')
    .sort((a, b) => (b.started_at ?? b.captured_at ?? -Infinity) - (a.started_at ?? a.captured_at ?? -Infinity)
      || String(a.source_id).localeCompare(String(b.source_id)))[0];
  const displayed = rows.filter(row => !isTrack(row) || row === fused);
  const items = displayed.map(row => ({
    key: `${row.source_kind}:${row.source_id}`,
    category: row.source_kind === 'TRACK' ? '融合轨迹' : labelOf(EVIDENCE_CATEGORY_LABEL, row.category, '其他'),
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
