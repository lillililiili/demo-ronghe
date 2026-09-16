// 展示层只整理已保存的规则事实，不计算合法性、不授予复核权限。
export function legalityReviewFocus(evaluation) {
  const hits = evaluation?.hit_details || [];
  const unknownReasons = [...new Set(evaluation?.unknown_reasons || [])];
  const uncertainHits = hits.filter(hit => hit.result_code === 'UNDETERMINED');
  const failedHits = hits.filter(hit => hit.result_code === 'FAIL');
  const unresolved = unknownReasons.length > 0 || uncertainHits.length > 0;
  const superseded = !!evaluation?.superseded_by_evaluation_id || evaluation?.review?.state === 'SUPERSEDED';
  const reviewed = Number(evaluation?.review?.version) > 0 && evaluation?.review?.state !== 'PENDING_REVIEW';
  const applicable = !!evaluation && evaluation.legal_status !== 'NOT_APPLICABLE' && !superseded;
  const needsReview = applicable && !reviewed && (evaluation.review?.state === 'PENDING_REVIEW' || (evaluation.allowed_actions || []).includes('REVIEW'))
    && evaluation.legal_status !== 'LEGAL';
  const title = superseded ? '已有更新的研判' : reviewed ? '已完成人工复核'
    : needsReview && unresolved ? '需要核对的信息缺口' : needsReview ? '需要核对的判定依据' : '当前无需人工复核';
  const note = superseded ? '请查看最新结果；本次结论与复核历史继续保留。'
    : reviewed ? '下方保留原始系统结论；人工结论与说明可在复核历史查看。'
      : needsReview && unresolved ? '优先补充以下无法确定的信息，再记录核对结果。已取得的计划、轨迹和规则事实无需重复填写。'
        : needsReview ? '系统已给出判定依据；当前仍待复核，仅需说明核对结果或与系统结论不同的事实。'
          : '可查看判定依据；如发现新证据，可通过更多操作纠正或重新研判。';
  return { unknownReasons, uncertainHits, failedHits, unresolved, superseded, reviewed, needsReview, title, note };
}
