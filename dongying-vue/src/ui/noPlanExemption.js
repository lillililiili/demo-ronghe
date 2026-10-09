// 新-28（2026-10-08，确认书 2-2）：没有报备任务、离地 120 米以下、不在禁飞区/管制区/限高区/临时管控区里的飞行，
// 按规定无需申请，后台判合法、不出告警。任务匹配（C01）照实记“对不上任务”，判定时事实里带 no_plan_exempt 和当时的离地高度，
// 研判页只依据明确记录的豁免事实解释原因，不能由合法结果反推适用此豁免。
export const NO_PLAN_EXEMPT_SHORT = '没有报备任务，按规定无需申请';

export function noPlanExemptHit(evaluation) {
  return (evaluation?.hit_details || []).find(hit => hit?.rule_code === 'C01' && hit.facts?.no_plan_exempt === true) || null;
}

export function noPlanExemptReason(evaluation) {
  if (evaluation?.legal_status !== 'LEGAL') return '';
  const hit = noPlanExemptHit(evaluation);
  if (hit) {
    const agl = hit.facts.height_agl_m;
    const height = agl !== null && agl !== undefined && agl !== '' && Number.isFinite(Number(agl)) ? `离地约 ${Math.round(Number(agl))} 米，` : '';
    return `没有报备任务；${height}不超过 120 米，不在禁飞区、管制区、限高区、临时管控区内，按规定无需申请`;
  }
  // 无计划允许飞行的规则版本也可判合法；缺少明确豁免事实时保留原判定说明。
  return '';
}
