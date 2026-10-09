// 研判页把“置信度不足”说清楚：几路来源、可信度多少、要求多少（CDX-P04）。
// 只用研判记录带回的三个数（confidence / confidence_threshold / source_count），页面不自己算可信度；
// 早先的研判没存下限或来源数时返回空串，页面照旧写“置信度不足”。
const known = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const percent = value => `${Math.round(Number(value) * 100)}%`;

export function lowConfidenceReason(evaluation) {
  if (!(evaluation?.unknown_reasons || []).includes('LOW_CONFIDENCE')) return '';
  const { confidence, confidence_threshold: threshold, source_count: sources } = evaluation;
  if (!known(confidence) || !known(threshold)) return '';
  const count = known(sources) ? Number(sources) : null;
  const seen = count === 1 ? '只有一路来源' : count > 1 ? `${count} 路来源` : '';
  const value = seen ? `${seen}（可信度 ${percent(confidence)}）` : `可信度 ${percent(confidence)}`;
  return `${value}，达不到 ${percent(threshold)}，不自动出告警，请人工复核`;
}
