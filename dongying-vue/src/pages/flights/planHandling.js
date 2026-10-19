/* 只按本次任务对照所引用的研判分流，不能拿同一目标的其他告警代替。 */
export function planHandling(plan, snapshot, access = {}) {
  const none = { kind: 'none', note: '' };
  const blocked = note => ({ kind: 'blocked', note });
  if (!['EXECUTING', 'COMPLETED'].includes(plan?.status_code)) return none;
  if (!snapshot) return { kind: 'loading', note: '正在读取关联记录…' };
  if (snapshot.error) return blocked('关联记录读取失败，请刷新任务重试。');
  const match = snapshot.data?.match;
  if (match?.availability === 'NO_EVALUATION') return { ...none, note: '可能尚未起飞、未被探测到或尚未匹配。请联系报备单位确认。' };
  if (match?.availability === 'FORBIDDEN') return blocked('当前账号没有研判查看权限。');
  if (match?.availability !== 'AVAILABLE' || !match.evaluation_id) return blocked('任务的研判记录暂不可用，请刷新任务重试。');
  if (snapshot.evaluationError) return blocked(snapshot.evaluationError.status === 403
    ? '当前账号无权查看关联研判。' : '关联研判读取失败，请刷新任务重试。');
  const evaluation = snapshot.evaluation;
  if (!evaluation || evaluation.evaluation_id !== match.evaluation_id || evaluation.plan_id !== plan.plan_id
    || (evaluation.target_id && match.target_id && evaluation.target_id !== match.target_id)) {
    return blocked('关联研判与任务对照不一致，请刷新任务重试。');
  }
  if (evaluation.has_alarm === true || evaluation.alarm_id) {
    if (!access.alarms) return blocked('已有关联告警，当前账号没有告警查看权限。');
    if (!evaluation.alarm_id) return blocked('已有关联告警，但该记录当前不可查看。');
    return { kind: 'alarm', label: '查看告警', note: '已有关联告警，请到告警页面查看核实与处置进度。',
      context: { alarm: evaluation.alarm_id } };
  }
  if (evaluation.has_alarm !== false) return blocked('告警关联状态暂不可用，请刷新任务重试。');
  if (!evaluation.object_type_code) return blocked('当前无法读取目标类别，暂不能打开无人机研判。');
  if (evaluation.object_type_code !== 'UAV') return { ...none, note: '当前目标不是无人机，不进入无人机合法性研判。' };
  if (!access.legality) return blocked('当前账号没有合法性研判页面查看权限。');
  return { kind: 'legality', label: '查看研判', note: '',
    context: { plan: plan.plan_id, evaluation: evaluation.evaluation_id, ...(evaluation.target_id ? { target: evaluation.target_id } : {}) } };
}

/* 列表和详情共用在途请求；完成即释放，下一次刷新必须重读告警关联。 */
export function createPlanSnapshotReader({ actuals, getEvaluation }) {
  const pending = new Map();
  return function read(planId) {
    if (pending.has(planId)) return pending.get(planId);
    const request = (async () => {
      let data;
      try { data = await actuals(planId); } catch (error) { return { error }; }
      if (data?.match?.availability !== 'AVAILABLE' || !data.match.evaluation_id) return { data };
      try { return { data, evaluation: await getEvaluation(data.match.evaluation_id) }; }
      catch (evaluationError) { return { data, evaluationError }; }
    })().finally(() => { if (pending.get(planId) === request) pending.delete(planId); });
    pending.set(planId, request);
    return request;
  };
}
