// 新-29（2026-10-08，法规核对，确认书 2-10）：超视距不再算违规、不出告警。飞手（遥控器）离无人机超过 500 米时，
// 后台在超视距检查（C02-6）的明细里标 beyond_vlos，并带一句“飞手离无人机约 N 米（超过 500 米），是否经批准请核实”
// （facts.pilot_distance_note）；目标摘要 legality_summary.pilot_distance_note 是最近一次研判里的这句。
// 研判页、告警详情、态势图目标弹窗照样显示，给值班员参考。以前因超视距出的告警原样保留，违规原因的中文照旧。
export const PILOT_DISTANCE_RULE = 'C02-6';

export function isPilotDistanceNoteHit(hit) {
  return hit?.rule_code === PILOT_DISTANCE_RULE && hit.facts?.beyond_vlos === true;
}

export function pilotDistanceHit(evaluation) {
  return (evaluation?.hit_details || []).find(isPilotDistanceNoteHit) || null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/* 研判详情取明细里的那句；目标（详情或列表项）取 legality_summary 里的那句，也可以直接传 legality_summary。没有就空串，页面不显示。 */
export function pilotDistanceNote(source) {
  return text(pilotDistanceHit(source)?.facts?.pilot_distance_note)
    || text(source?.legality_summary?.pilot_distance_note)
    || text(source?.pilot_distance_note);
}
