// 新-28（2026-10-08，确认书 2-2）：没有报备任务、离地 120 米以下、不在禁飞区/管制区/限高区/临时管控区里的飞行，
// 按规定无需申请，后台判合法、不出告警。任务匹配（C01）照实记“对不上任务”，判定时事实里带 no_plan_exempt 和当时的离地高度，
// 研判页据此写清为什么合法，不再写“全部检查通过”。列表项不带单项检查，只写短句。
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
  // 列表项不带单项检查：没有对上任务、也没有本机候选任务却判合法的，就是按规定无需申请的这一类。
  if (!evaluation.hit_details && evaluation.plan_match_code === 'NONE' && !evaluation.plan_id) return NO_PLAN_EXEMPT_SHORT;
  return '';
}
