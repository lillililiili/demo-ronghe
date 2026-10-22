import { PREDICTION_STATES, predictionIsCurrent, predictionLocation, predictionWarnings, predictionWarningState, predictionProximityRows, isPredictionAlarm, alarmPredictionState } from '../services/predictionView.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const REASONS = {
  NO_MEASUREMENTS: '尚无有效实测观测', POSITION_UNKNOWN: '实测位置未知', SIMULTANEOUS_POSITION_CONFLICT: '同一时刻的位置依据冲突',
  LOCAL_PROJECTION_UNSUPPORTED: '当前位置超出预测模型适用范围', POSITION_DISCONTINUITY: '实测位置发生不连续跳变',
  PREDICTION_PROCESSING_FAILED: '预测暂时处理失败，等待重新计算', TARGET_OR_SCOPE_UNAVAILABLE: '目标或数据范围暂不可用', STABILITY_PENDING: '连续入区预测尚待稳定确认',
  READY: '预测依据有效', INSUFFICIENT_POINTS: '有效实测点不足', INSUFFICIENT_TIME_SPAN: '连续观测时间不足',
  STALE_OR_UNTRUSTED_MEASUREMENT: '实测已过期或时间不可信', TARGET_IDENTITY_NOT_CURRENT: '目标身份已不属于当前有效轨迹',
  STALE_MEASUREMENT: '最新实测位置已过期', DISCONTINUOUS_MEASUREMENTS: '实测轨迹不连续', TIME_UNTRUSTED: '观测时间不可信',
  POSITION_ACCURACY_UNSUITABLE: '位置误差不满足预测要求', DIRECTION_UNRESOLVED: '暂不能确定飞行方向', TURNING: '正在转向，预测待稳定',
  SPEED_UNSTABLE: '速度变化较大，预测待稳定', FIT_UNRELIABLE: '轨迹趋势不够稳定',
  STABLE_ENTRY_PREDICTION: '连续实测支持稳定的入区预测', NEW_MEASUREMENTS_CONFIRM_AVOIDANCE: '新实测确认未来 30 秒不再入区',
  ENTRY_AWAITING_CONFIRMATION: '预测将进入禁飞区，等待连续新实测确认',
  AVOIDANCE_AWAITING_CONFIRMATION: '预测航向已避开，等待连续新实测确认', ACTUAL_ENTRY_OBSERVED: '实测已确认进入空域',
  ACTUAL_ENTRY_BEFORE_WARNING: '稳定预警形成前已实测入区，按实际入区处理', TARGET_DOMAIN_CHANGED: '目标归属或来源范围已变化',
  PREDICTION_UNAVAILABLE: '预测依据暂不可用', AIRSPACE_VERSION_INVALID: '空域版本无效', AIRSPACE_VERSION_CONFLICT: '空域版本存在冲突',
  AIRSPACE_VERSION_AMBIGUOUS: '预测时段的空域版本不明确', AIRSPACE_GEOMETRY_UNKNOWN: '空域边界暂不可确认',
  PREDICTED_ENTRY_CONFIRMED: '预测位置及误差范围支持入区判断', FULL_HORIZON_DISJOINT: '未来 30 秒预测范围与禁飞区不相交',
  HORIZONTAL_DISJOINT: '预测水平位置与空域不相交', VERTICAL_DISJOINT: '预测高度与空域不相交',
  ALTITUDE_RELATION_UNKNOWN: '预测高度与空域的关系暂不明确', UNCERTAINTY_OR_BOUNDARY_CONTACT: '位置误差范围或边界接触尚不能确认入区',
  ACCURACY_DEFAULTED: '位置误差采用规则中配置的默认范围'
};
export function predictionReasonText(code) {
  return [...new Set(String(code || '').split(',').map(value => value.trim()).filter(Boolean))]
    .map(value => REASONS[value] || '预测依据已更新').filter((value, index, rows) => rows.indexOf(value) === index).join('；') || '预测依据已更新';
}
export function predictionEvidenceNotesText(notes) {
  const messages = (Array.isArray(notes) ? notes : []).map(note => {
    const value = String(note || '').trim();
    if (value.startsWith('FUSION_TRACK_CONFIG:')) return `实测轨迹融合配置版本：${value.slice('FUSION_TRACK_CONFIG:'.length) || '未提供'}`;
    if (value.startsWith('FUSION_CURRENT_CONFIG:')) return `当前目标融合配置版本：${value.slice('FUSION_CURRENT_CONFIG:'.length) || '未提供'}`;
    return ({
      ALTITUDE_ERROR_IS_MODEL_ASSUMPTION: '高度误差采用模型假设值',
      ERROR_BOUNDS_ARE_MODEL_ESTIMATES: '误差范围为模型估计，不代表准确率',
      SIMULATOR_DEFAULT_CONFIGURATION_NOT_HISTORICALLY_FROZEN: '模拟器默认配置未在历史观测中冻结'
    })[value] || REASONS[value] || '其他预测依据说明已更新';
  });
  return [...new Set(messages)].join('；');
}
export function predictionTime(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '未提供';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Number(value));
}
export function predictionPosition(location) {
  const point = predictionLocation(location);
  return point ? `${point.lon.toFixed(6)}, ${point.lat.toFixed(6)}` : '位置未提供';
}
const valueUnit = (value, unit) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '未提供' : `${Number(value).toFixed(1)} ${unit}`;
export function predictionDetailsHtml(prediction, { now = Date.now(), unavailable = false, frozen = false, showProximity = false } = {}) {
  if (!prediction) return '<p class="prediction-message" role="status">尚无可读取的预测依据。</p>';
  const current = predictionIsCurrent(prediction, now, unavailable);
  const expiredWithoutPoints = !frozen && prediction.valid_until != null && prediction.valid_until !== ''
    && Number.isFinite(Number(prediction.valid_until)) && Number(prediction.valid_until) <= now && !(prediction.points || []).length;
  const warnings = predictionWarnings(prediction);
  const pendingWarnings = warnings.some(warning => !['WITHDRAWN', 'ENTERED'].includes(warning.state));
  const terminalOnly = warnings.length > 0 && !pendingWarnings;
  const state = frozen ? '预警创建时的预测快照' : current ? '未来位置预测 · 依据有效' : terminalOnly ? '历史预测依据' : '预测暂不可判断';
  const source = prediction.simulated || prediction.source_mode === 'replay' ? '模拟／回放' : prediction.source_mode === 'live' ? '真实来源' : '来源未提供';
  const inactiveNote = [
    warnings.some(warning => warning.state === 'WITHDRAWN') ? '已撤销的预测预警保留为历史记录。' : '',
    warnings.some(warning => warning.state === 'ENTERED') ? '已确认实测入区，后续查看实际入区处置进度。' : '',
    pendingWarnings ? '尚未结束的预警保留待确认；这不代表风险已解除。' : '',
    !warnings.length ? '当前没有可用的未来位置；是否存在入区风险仍需有效依据确认。' : ''
  ].filter(Boolean).join('');
  const proximity = showProximity && !frozen ? predictionProximityRows(prediction, now, unavailable).map(row =>
    `<div class="prediction-warning"><b>${esc(row.airspace_name || '禁飞区')} · ${row.state === 'CONFIRMING' ? '稳定性确认中' : '可能接近，暂不能确认'}</b>
      <span>${esc((row.reason_codes || []).map(predictionReasonText).join('；'))}</span>
      <small>空域版本 ${esc((row.airspace_version_ids || []).join('、') || '未提供')} · 接近提示，尚未形成正式预警</small></div>`).join('') : '';
  const rows = [ ['实测基准', predictionTime(prediction.based_on_observed_at)], ['预测生成', predictionTime(prediction.generated_at)],
    ['有效至', predictionTime(prediction.valid_until)], ['预测方向', valueUnit(prediction.heading_deg, '°')], ['预测速度', valueUnit(prediction.speed_mps, 'm/s')],
    ['数据来源', source] ];
  const points = [10, 20, 30].map(seconds => {
    const point = (prediction.points || []).find(row => Number(row.horizon_seconds) === seconds);
    const datum = point?.altitude_m == null ? '' : ({ AMSL: '（海拔）', AGL: '（离地）' }[point.altitude_datum] || '（基准未提供）');
    return `<tr><th scope="row">预测 +${seconds}秒</th><td>${esc(predictionTime(point?.predicted_at))}</td><td>${esc(predictionPosition(point?.location))}</td><td>${esc(valueUnit(point?.altitude_m, 'm') + datum)}</td><td>${esc(valueUnit(point?.uncertainty_m, 'm'))}</td></tr>`;
  }).join('');
  const warningRows = warnings.map(warning => {
    const status = frozen ? warning.state : predictionWarningState(prediction, warning, now, unavailable);
    const versions = warning.airspace_version_ids?.length ? warning.airspace_version_ids : [warning.airspace_version_id].filter(Boolean);
    const entry = Number(warning.entry_at);
    const eta = !frozen && current && status === 'ACTIVE' && entry > now ? `约 ${Math.ceil((entry - now) / 1000)} 秒后` : '';
    return `<div class="prediction-warning"><b>${esc(PREDICTION_STATES[status] || '预测状态未知')} · ${esc(warning.airspace_name || '禁飞区')}</b>
      <span>${eta ? esc(eta) + ' · ' : ''}预计入区时间 ${esc(predictionTime(warning.entry_at))}</span><span>预计入区位置 ${esc(predictionPosition(warning.entry_location))}</span>
      <small>空域版本 ${esc(versions.join('、') || '未提供')} · 预警状态版本 ${esc(warning.version ?? '未提供')}</small>${warning.airspace_basis === 'FIRST_FROZEN' ? '<small>缺失空域资料来自首次冻结依据。</small>' : warning.airspace_basis === 'LAST_KNOWN' ? '<small>空域名称与版本为最后有效预测依据。</small>' : ''}${warning.reason ? `<span>${esc(predictionReasonText(warning.reason))}</span>` : ''}
      ${!frozen && warning.event_id ? `<a class="lnk" href="#/alarms?event=${encodeURIComponent(warning.event_id)}">查看预测预警与办理进度</a>` : ''}</div>`;
  }).join('');
  return `<header class="prediction-title"><strong>${esc(state)}</strong><span class="tag t-cyan">预测</span></header>
    ${!frozen && !current ? `<p class="prediction-message" role="status">${unavailable ? '预测读取失败，以下为上次结果。' : '预测依据不足或已经过期。'}未来线已隐藏。${esc(inactiveNote)}</p>` : '<p class="prediction-message">虚线和空心点表示预计位置，实测轨迹保持原样。时间均为北京时间，+10／20／30秒以预测生成时刻计算。</p>'}
    ${!frozen && prediction.evidence_status === 'LAST_KNOWN' ? `<p class="prediction-message">保留的历史依据仅供追溯，不能作为当前有效预测。${prediction.last_evidence_observed_at != null ? `最后有效预测所用实测：${esc(predictionTime(prediction.last_evidence_observed_at))}。` : ''}${prediction.last_evidence_generated_at != null ? `最后有效预测生成：${esc(predictionTime(prediction.last_evidence_generated_at))}。` : ''}</p>` : ''}
    <dl class="kv">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    ${expiredWithoutPoints ? '<p class="prediction-message">当前预测位置已失效，历史预测请查看首次预警的冻结依据。</p>' : `<details${frozen ? '' : ' open'}><summary>未来 30 秒的位置与高度${!current && !frozen ? '（上次结果）' : ''}</summary>
      <div class="prediction-table-scroll"><table><thead><tr><th>预测时长</th><th>预计时刻</th><th>经纬度</th><th>高度</th><th>位置不确定范围</th></tr></thead><tbody>${points}</tbody></table></div></details>`}
    <p class="prediction-message">${esc((prediction.reason_codes || []).map(predictionReasonText).join('；'))}</p>
    ${prediction.uncertainty_note ? `<p class="prediction-message">${esc(prediction.uncertainty_note)}</p>` : ''}
    ${(prediction.evidence_notes || []).length ? `<p class="prediction-message">${esc(predictionEvidenceNotesText(prediction.evidence_notes))}</p>` : ''}
    ${warningRows || '<p class="prediction-message">尚无稳定入区预警。</p>'}${proximity}
    <details><summary>算法与规则版本</summary><dl class="kv"><dt>算法版本</dt><dd>${esc(prediction.model_version || '未提供')}</dd><dt>规则版本</dt><dd>${esc(prediction.rule_version || '未提供')}</dd></dl></details>`;
}


/** 预测风险独立于当前实测合法性；合法或失联均不推导预测已撤离。 */
export function predictionAlarmStatusHtml(alarm, { now = Date.now(), currentObservation = false, legalStatus = null, includeReason = true } = {}) {
  if (!isPredictionAlarm(alarm)) return '';
  const state = alarmPredictionState(alarm, now);
  const eventState = alarm.state || alarm.eventState;
  const verified = eventState === 'CONFIRMED' ? '预测风险已核实' : eventState === 'FALSE_POSITIVE' ? '已核实为误报' : '预测风险待人工核实';
  const process = ['WITHDRAWN', 'ENTERED'].includes(state) && eventState === 'PENDING_VERIFICATION' ? '原核实记录保留' : verified;
  const tone = state === 'ACTIVE' ? 'amber' : state === 'ENTERED' ? 'red' : 'grey';
  const detail = state === 'WITHDRAWN' ? '本次预测预警已撤销，原核实与通知记录保留。'
    : state === 'ENTERED' ? '实测已确认进入预警空域，请查看实际入区告警及处置进度。'
      : !currentObservation ? '当前实测位置无效或不可确认，不能当作已进入或已撤离。'
        : legalStatus === 'LEGAL' ? '当前实测尚未进入预警空域；当前合法不代表预测风险已解除。'
          : '当前实测研判与预测入区风险分别处理，不能据此推断已撤离。';
  const eventId = alarm.event_id || alarm.eventId;
  const frozen = alarm.prediction_snapshot;
  const frozenWarning = frozen?.warning || frozen?.warnings?.find(row => row.event_id === eventId);
  const warning = frozenWarning || alarm.prediction?.warning || alarm.prediction?.warnings?.find(row => row.event_id === eventId);
  const reasonLabel = frozenWarning ? '预测预警原因（出预警时）' : '预测预警原因';
  return `<div class="uav-now is-${tone}" role="status" aria-label="预测入区风险">
    <div class="uav-now-top"><span class="uav-now-label">预测入区风险</span><span class="uav-now-process">${esc(process)}</span></div>
    <strong class="uav-now-title"><i aria-hidden="true"></i>${esc(PREDICTION_STATES[state] || '预测状态未知')}</strong>
    <span class="uav-now-sub">${esc(detail)}</span></div>
    ${includeReason ? `<div class="sit-target-alarm-reason is-risk" aria-label="${reasonLabel}"><span>${reasonLabel}</span>
      <strong>预计进入${esc(warning?.airspace_name || '禁飞区（名称未提供）')}</strong>
      <small>${frozenWarning ? '依据首次预警冻结快照。' : '首次冻结依据见预警详情。'}</small></div>` : ''}`;
}
