// 展示层只整理已保存的规则事实，不计算合法性、不授予复核权限。
export function legalityReviewFocus(evaluation) {
  const hits = evaluation?.hit_details || [];
  const unknownReasons = [...new Set(evaluation?.unknown_reasons || [])];
  const candidate = evaluation?.decision_assurance;
  const versionValid = candidate?.status === 'UNAVAILABLE'
    ? candidate.algorithm_version == null || candidate.algorithm_version === ''
    : typeof candidate?.algorithm_version === 'string' && candidate.algorithm_version.trim().length > 0;
  const assuranceProvided = !!candidate
    && ['SUFFICIENT', 'INSUFFICIENT', 'UNAVAILABLE', 'NOT_APPLICABLE'].includes(candidate.status)
    && typeof candidate.review_required === 'boolean'
    && Array.isArray(candidate.reasons)
    && candidate.accuracy_status === 'NOT_VALIDATED'
    && versionValid;
  const assurance = assuranceProvided ? evaluation.decision_assurance : null;
  const assuranceStatus = assurance?.status || 'UNAVAILABLE';
  const assuranceReasons = [...new Set(assurance?.reasons || [])];
  const uncertainHits = hits.filter(hit => hit.result_code === 'UNDETERMINED');
  const failedHits = hits.filter(hit => hit.result_code === 'FAIL');
  const unresolved = assuranceStatus === 'INSUFFICIENT' || assuranceStatus === 'UNAVAILABLE'
    || unknownReasons.length > 0 || uncertainHits.length > 0;
  const superseded = !!evaluation?.superseded_by_evaluation_id || evaluation?.review?.state === 'SUPERSEDED';
  const reviewed = Number(evaluation?.review?.version) > 0 && evaluation?.review?.state !== 'PENDING_REVIEW';
  const applicable = !!evaluation && evaluation.mode !== 'SHADOW'
    && evaluation.legal_status !== 'NOT_APPLICABLE' && !superseded;
  const reliable = assuranceStatus === 'SUFFICIENT' && assurance?.review_required === false;
  // 缺少算法结果是可靠性未知，不能冒充明确待复核。
  const needsReview = applicable && !reviewed && assuranceProvided && assurance?.review_required === true;
  const canReview = (evaluation?.allowed_actions || []).includes('REVIEW');
  const showTask = needsReview || reviewed || superseded || (applicable && !assuranceProvided && !reviewed);
  const title = superseded ? '已有更新的研判' : reviewed ? '已完成人工复核'
    : needsReview ? '需要核对的信息缺口'
      : !assuranceProvided && applicable ? '判定可靠性未知' : '当前无需人工复核';
  const note = superseded ? '请查看最新结果；本次结论与复核历史继续保留。'
    : reviewed ? '下方保留原始系统结论；人工结论与说明可在复核历史查看。'
      : needsReview && assuranceStatus === 'UNAVAILABLE' ? '本条记录的算法可靠性结果不可用，请根据下列原因核对信息缺口。'
        : needsReview ? '本次算法依据不足，当前结论暂不能可靠确认，请根据下列原因核对信息缺口。'
          : !assuranceProvided && applicable ? '本条记录未保存算法可靠性结果，不能当作明确待复核，也不能把系统结论视为可靠自动结论。'
            : reliable ? '本次算法依据充分，系统已自动采纳结论；如发现新证据，可在更多操作中补充人工纠正。'
              : '当前记录不需要人工复核，可查看判定依据与历史。';
  return {
    unknownReasons, assuranceReasons, uncertainHits, failedHits, unresolved,
    assuranceProvided, assuranceStatus, reliable, superseded, reviewed, applicable,
    needsReview, canReview, showTask, title, note
  };
}
