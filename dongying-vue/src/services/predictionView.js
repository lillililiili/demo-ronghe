/** K03 展示投影：未来预测与原始/融合轨迹始终分开，过期只变未知，不在浏览器撤销事件。 */
export const PREDICTION_ORIGIN = 'PREDICTED_AIRSPACE_ENTRY';
export const PREDICTION_STATES = { ACTIVE: '预测入区预警', UNKNOWN: '预测暂不可判断', WITHDRAWN: '预测已撤销', ENTERED: '已进入（实测）' };
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
export function predictionLocation(location) {
  if (!numeric(location?.longitude) || !numeric(location?.latitude)) return null;
  const lon = Number(location.longitude), lat = Number(location.latitude);
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 85.051129 ? { lon, lat } : null;
}
export function predictionIsCurrent(prediction, now, unavailable = false) {
  return !unavailable && prediction?.status === 'READY' && numeric(prediction.valid_until)
    && Number(prediction.valid_until) > now && numeric(prediction.based_on_observed_at)
    && Number(prediction.based_on_observed_at) <= now;
}
export function predictionWarnings(prediction) {
  return Array.isArray(prediction?.warnings) ? prediction.warnings : prediction?.warning ? [prediction.warning] : [];
}
export function predictionWarningState(prediction, warning, now, unavailable = false) {
  if (['WITHDRAWN', 'ENTERED'].includes(warning?.state)) return warning.state;
  return warning?.state === 'ACTIVE' && predictionIsCurrent(prediction, now, unavailable) ? 'ACTIVE' : 'UNKNOWN';
}
/** 当前有效预测里最近一次预计入区还有几秒；没有有效的入区预警返回 null。 */
export function predictionEntrySeconds(prediction, now, unavailable = false) {
  if (!predictionIsCurrent(prediction, now, unavailable)) return null;
  const times = predictionWarnings(prediction).filter(warning => warning.state === 'ACTIVE' && numeric(warning.entry_at)
    && Number(warning.entry_at) > now).map(warning => Number(warning.entry_at));
  return times.length ? Math.ceil((Math.min(...times) - now) / 1000) : null;
}
/** 融合感知只呈现当前预测；告警页仍使用原始快照及完整生命周期。 */
export function currentPredictionViews(predictions, now, unavailable = false) {
  return (predictions || []).filter(prediction => predictionIsCurrent(prediction, now, unavailable))
    .map(prediction => {
      const warnings = predictionWarnings(prediction).filter(warning => warning.state === 'ACTIVE');
      return { ...prediction, warnings, warning: warnings[0] || null };
    });
}
export function predictionWarningRows(predictions, now, unavailable = false) {
  return currentPredictionViews(predictions, now, unavailable).flatMap(prediction => predictionWarnings(prediction)
    .map(warning => ({ prediction, warning, key: warning.event_id || warning.alarm_id || `${prediction.target_id}:${warning.airspace_version_id}`,
      state: predictionWarningState(prediction, warning, now, unavailable), targetId: prediction.target_id,
      targetNo: prediction.target_no, name: warning.airspace_name || '禁飞区名称未提供' })));
}
export function predictionProximityRows(prediction, now, unavailable = false) {
  if (!predictionIsCurrent(prediction, now, unavailable)) return [];
  const published = new Set(predictionWarnings(prediction).map(warning => warning.airspace_id).filter(Boolean));
  return (prediction.proximity || []).filter(row => row.airspace_id && !published.has(row.airspace_id)
    && ['CONFIRMING', 'POSSIBLE'].includes(row.state));
}
export function predictionMapData(predictions, now, selectedTargetId, unavailable = false) {
  return (predictions || []).map(prediction => {
    const current = predictionIsCurrent(prediction, now, unavailable);
    const anchor = predictionLocation(prediction.anchor?.location);
    const available = (prediction.points || []).map(point => Number(point.horizon_seconds))
      .filter(horizon => Number.isInteger(horizon) && horizon > 30 && horizon <= 600);
    const horizons = [10, 20, 30, ...(prediction.simulated === true ? [...new Set(available)].sort((a, b) => a - b) : [])];
    const samples = horizons.map(horizon => (prediction.points || []).find(point => Number(point.horizon_seconds) === horizon));
    const complete = samples.every(point => predictionLocation(point?.location) && numeric(point.predicted_at)
      && Number(point.predicted_at) > Number(prediction.generated_at));
    const selected = prediction.target_id === selectedTargetId;
    return { id: prediction.prediction_id, targetId: prediction.target_id, targetNo: prediction.target_no,
      selected, anchor, points: current && selected && anchor && complete
        ? samples.map(point => ({ ...predictionLocation(point.location), horizon: Number(point.horizon_seconds), predictedAt: Number(point.predicted_at) })) : [],
      warnings: current ? predictionWarnings(prediction).filter(warning => warning.state === 'ACTIVE'
        && predictionLocation(warning.entry_location) && numeric(warning.entry_at) && Number(warning.entry_at) >= now)
        .map(warning => ({ ...warning, ...predictionLocation(warning.entry_location) })) : [] };
  });
}
export function isPredictionAlarm(alarm) {
  const stage = (alarm?.risk_case || alarm?.riskCase)?.stage;
  if (stage) return stage === 'PREDICTED' || stage === 'UNKNOWN';
  return (alarm?.origin_kind || alarm?.originKind) === PREDICTION_ORIGIN;
}
export function alarmPredictionState(alarm, now) {
  const prediction = alarm?.prediction;
  const warning = prediction?.warning || predictionWarnings(prediction).find(row => row.event_id === (alarm?.event_id || alarm?.eventId));
  return predictionWarningState(prediction, warning || { state: alarm?.prediction_status }, now);
}
export function predictionVerificationId(event, alarm) {
  if (!isPredictionAlarm(alarm) && event?.origin_kind !== PREDICTION_ORIGIN) return null;
  return event?.verification_basis?.prediction_id || event?.prediction?.prediction_id || null;
}


/** 仅控制预测风险的核实入口；原核实历史和实际入区告警继续遵循各自流程。 */
export function predictionVerificationState(event, alarm, now) {
  const risk = alarm?.risk_case || alarm?.riskCase;
  // 同一风险转实测后，旧预测的 ENTERED/WITHDRAWN 只是历史依据，不再决定统一办理资格。
  if (risk) {
    if (risk.stage === 'UNKNOWN') return { state: 'UNKNOWN', blocked: true, terminal: false,
      message: risk.block_reason || event?.verification_basis?.message || '当前风险依据不足，暂不能确认属实；恢复有效依据后可继续在本条风险办理，如确认是误报可核实为误报。' };
    if (['CLEARED', 'ENDED'].includes(risk.stage)) return { state: risk.stage, blocked: true, terminal: true,
      message: risk.stage === 'CLEARED' ? '本次风险已避开，保留核实和处置历史。' : '本次风险已结束，保留核实和处置历史。' };
    if (risk.stage !== 'PREDICTED') return null;
  }
  if (!isPredictionAlarm(alarm) && event?.origin_kind !== PREDICTION_ORIGIN) return null;
  const state = alarmPredictionState({ ...alarm, event_id: event?.event_id || alarm?.event_id || alarm?.eventId,
    prediction: event?.prediction || alarm?.prediction, prediction_status: event?.prediction_status || alarm?.prediction_status }, now);
  if (state === 'WITHDRAWN') return { state, blocked: true, terminal: true,
    message: '预测预警已撤销，保留原核实与通知记录；不能再确认本次预测风险。' };
  if (state === 'ENTERED') return { state, blocked: true, terminal: true,
    message: risk ? '预测依据已转为实测入区，请刷新本条风险查看当前阶段并继续办理，原核实记录保留。'
      : '已实测入区，本次预测预警不再核实；请查看实际入区告警及其处置进度，原核实记录保留。' };
  const predictionId = event?.verification_basis?.prediction_id || event?.prediction?.prediction_id || alarm?.prediction?.prediction_id;
  if (!predictionId) return { state, blocked: true, terminal: false,
    message: '缺少可核实的预测快照，不能提交预测风险属实；如确认是误报，可核实为误报。' };
  if (state !== 'ACTIVE') return { state, blocked: true, terminal: false,
    message: '预测依据已过期或暂不可判断，不能提交预测风险属实；如确认是误报，可核实为误报。' };
  if (event?.verification_basis?.confirmable === false) return { state, blocked: true, terminal: false,
    message: `当前预测依据不足，不能提交预测风险属实。${event.verification_basis.message || '如确认是误报，可核实为误报。'}` };
  return { state, blocked: false, terminal: false, message: '' };
}
