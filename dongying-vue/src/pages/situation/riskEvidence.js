import { getAlarm, getAlarmAirspaceHits, getUavRiskCase } from '@/services/alarmApi.js';
import { legalityApi } from '@/services/legalityApi.js';
import { flightApi } from '@/services/flightApi.js';
import { riskApi } from '@/services/riskApi.js';
import { toAirspaces, toFlightPlans } from '@/services/situationData.js';
import { weatherPolygon } from '@/services/weatherRiskGeometry.js';
import { REASON_CODE_LABEL, VIOLATION_CODE_LABEL, SOURCE_MODE_LABEL, ALTITUDE_BAND_LABEL, OBJECT_TREND_LABEL, CORRIDOR_RELATION_LABEL, DISPOSAL_STATUS_LABEL, RISK_STATE_LABEL, ALARM_PROGRESS_LABEL } from '@/ui/labels.js';
import { apiRequestTimed } from '@/services/apiClient.js';
import { RULE_REASON_TEXT } from '@/ui/legalityReviewModal.js';
import { ruleHitText } from '@/ui/ruleHitText.js';

export const itemKey = item => item?.key || `${item?.kind || ''}:${item?.risk_case_id || item?.risk_id || item?.alarm_id || ''}`;
export const emptyRiskContext = item => ({ itemKey: itemKey(item), airspaces: [], flightPlans: [], points: [], lines: [], polygons: [], notice: '' });
export const evidenceSignature = item => JSON.stringify([itemKey(item), item?.risk_case_version, item?.event_version, item?.version,
  item?.alarm_id, item?.event_id, item?.target_id, item?.target_no, item?.plan_id, item?.plan_no, item?.area_id, item?.area_name,
  item?.source_mode,item?.simulated,item?.route_version_id, item?.updated_at, item?.reason_code, item?.reason_text, item?.stage, item?.state]);
export const evidenceTime = value => value == null ? '未知' : Number.isNaN(new Date(value).getTime()) ? '未知'
  : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const known = value => value == null || value === '' ? '未知' : String(value);
// 与告警列表同一本词典（RULE_REASON_TEXT）；三本都查不到的原因代码不上屏，返回空串。
const reasonLabel = code => code === 'BVLOS_EXCEEDED' ? '超视距历史提示（不作为新增违规结论）'
  : RULE_REASON_TEXT[code] || VIOLATION_CODE_LABEL[code] || REASON_CODE_LABEL[code] || '';
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))];
const caseAreaId = data => data.riskCase?.airspace_id || data.item?.area_id || null;
const caseHits = data => { const id = caseAreaId(data); return id ? data.hits.filter(hit => hit.airspace?.airspace_id === id) : data.hits; };
const getEvaluationRefs = id => apiRequestTimed(`/alarms/${encodeURIComponent(id)}/evaluation-refs`);
const getExecutionEvidence = id => apiRequestTimed(`/legality-evaluations/${encodeURIComponent(id)}/execution-evidence`);
export async function loadRiskStatus(item, request = apiRequestTimed) {
  const latest = await request(`/situation/risk-items/${encodeURIComponent(itemKey(item))}`);
  if (latest?.key !== itemKey(item) || latest.kind !== item.kind
      || !['CURRENT','UNKNOWN','NOT_CURRENT'].includes(latest.current_status)) throw new Error('当前风险状态暂不可用');
  return { item: latest };
}
export async function loadRiskProgress(item, read = getUavRiskCase) {
  if (item.kind!=='UAV' || !item.risk_case_id) return null;
  const detail=await read(item.risk_case_id);
  if (detail?.risk_case?.risk_case_id!==item.risk_case_id) throw new Error('办理进度暂不可用');
  return {counter:detail.risk_case.counter ?? null,verification_status:detail.risk_case.verification_status ?? null,
    allowed_actions:detail.risk_case.allowed_actions ?? [],block_reason:detail.risk_case.block_reason ?? null};
}
export function hasCurrentRiskTarget(item, targets, now=Date.now()) {
  return item?.current_status==='CURRENT' && (targets || []).some(target=>target.targetId===item.target_id
    && (!item.source_mode || target.sourceMode===item.source_mode) && target.posValid!==false && !target.stale && !target.historical && !target.timeUntrusted
    && target.freshness!=='STALE' && target.observedAt!=null && target.mapExpiresAt!=null && target.mapExpiresAt>now
    && Number.isFinite(target.lon) && Number.isFinite(target.lat) && Math.abs(target.lon)<=180 && Math.abs(target.lat)<=90);
}
const point = (longitude, latitude, label, basis) => longitude != null && latitude != null
  && Number.isFinite(Number(longitude)) && Number.isFinite(Number(latitude))
  && Math.abs(Number(longitude)) <= 180 && Math.abs(Number(latitude)) <= 90
  ? { lon: Number(longitude), lat: Number(latitude), label, basis } : null;
function plannedEventPoints(data) {
  return (data.evaluations || []).flatMap(evaluation => list(evaluation.hit_details).flatMap(hit => {
    const facts = hit.facts || {}, dimension = facts.dimension;
    if (!['takeoff_point','landing_point'].includes(dimension) || !['FAIL','UNDETERMINED'].includes(hit.result_code)) return [];
    const plan = (data.linkedPlans || []).find(link => link.planId === evaluation.plan_id)?.plan;
    if (facts.plan_version == null || plan?.version !== Number(facts.plan_version) || plan?.filing?.coordinate_system !== 'WGS84') return [];
    const prefix = dimension === 'takeoff_point' ? 'takeoff' : 'landing';
    return [point(plan.filing[`${prefix}_longitude`],plan.filing[`${prefix}_latitude`],prefix === 'takeoff' ? '当时报备起飞点' : '当时报备降落点','PLANNED')].filter(Boolean);
  }));
}

// Only explicitly linked historical evaluations are eligible. Never request a target's latest evaluation.
export async function loadRiskEvidence(item, api = { getAlarm, getAlarmAirspaceHits, getUavRiskCase, getEvaluationRefs, getExecutionEvidence, legalityApi, flightApi, riskApi }) {
  const result = { item, risk: null, alarm: null, event: null, riskCase: null, fact: null, evaluations: [], hits: [], plan: null, route: null, notices: [] };
  const read = async (label, action) => {
    try { return await action(); }
    catch (error) { result.notices.push(`${label}${error?.status === 403 ? '无查看权限' : '暂不可用'}`); return null; }
  };
  if (item.kind === 'UAV') {
    if (item.risk_case_id) {
      const detail = await api.getUavRiskCase(item.risk_case_id);
      if (detail?.risk_case?.risk_case_id !== item.risk_case_id) throw new Error('风险详情与选中事项不一致');
      result.riskCase = detail.risk_case; result.alarm = detail.alarm; result.event = detail.event;
    } else if (item.alarm_id) result.alarm = await api.getAlarm(item.alarm_id);
    else throw new Error('缺少告警或风险周期关联，无法读取事件依据');
    const ids = unique([item.alarm_id, result.alarm?.alarm_id, ...list(result.riskCase?.related_alarm_ids)]);
    const pages = await Promise.all(ids.map(id => read('告警时空域依据', () => api.getAlarmAirspaceHits(id))));
    result.hits = pages.flatMap(page => list(page?.items));
    if (pages.some(page => !page || ['UNKNOWN', 'PARTIAL'].includes(page.status))) result.notices.push('报警时的部分空域依据暂不可用。');
    const refs = await Promise.all(ids.map(id => read('事件研判引用', () => api.getEvaluationRefs(id))));
    if (refs.some(ref => !ref || ['PARTIAL', 'UNKNOWN'].includes(ref.status))) result.notices.push('报警时的部分研判依据暂不可用。');
    const evaluationIds = unique([...refs.flatMap(ref => list(ref?.items).map(row => row.evaluation_id)), result.alarm?.evaluation_id, result.event?.evaluation_id,
      ...result.hits.map(hit => hit.evaluation_id), ...list(result.alarm?.evaluation_ids)]);
    result.evaluations = (await Promise.all(evaluationIds.map(id => read('事件研判依据', () => api.legalityApi.getEvaluation(id))))).filter(Boolean);
    if (!evaluationIds.length) result.notices.push('报警时的详细判定依据暂不可用。');
    result.trajectories = (await Promise.all(result.evaluations.map(evaluation => read('报警时的实测轨迹',
      () => api.legalityApi.trajectory(evaluation.evaluation_id))))).filter(Boolean);
    const executionPages = await Promise.all(result.evaluations.map(evaluation => read('报警时的起降及身份依据',
      () => api.getExecutionEvidence(evaluation.evaluation_id))));
    result.executionEvidence = executionPages.flatMap((page,index) => {
      const evaluation = result.evaluations[index], rules = relevantHits(evaluation).map(hit => hit.rule_code);
      return list(page?.items).filter(row => rules.includes(row.rule_code)).map(row => ({ ...row,evaluation_id:evaluation.evaluation_id }));
    });
  } else {
    result.risk = await api.riskApi.getRisk(item.risk_id);
    if (result.risk?.risk_id !== item.risk_id) throw new Error('风险详情与选中事项不一致');
    result.fact = await read(item.kind === 'WEATHER' ? '气象依据' : '异物依据', () => item.kind === 'WEATHER'
      ? api.riskApi.getWeatherFact(item.risk_id) : api.riskApi.getSpaceFact(item.risk_id));
    if (result.fact?.source_mode && result.risk.source_mode && result.fact.source_mode !== result.risk.source_mode) {
      result.fact = null; result.notices.push('事件依据来源待核对。');
    }
  }
  const links = new Map();
  for (const row of [...result.evaluations, result.risk, item].filter(Boolean)) {
    if (row.plan_id && row.route_version_id) links.set(`${row.plan_id}:${row.route_version_id}`, row);
  }
  result.linkedPlans = await Promise.all([...links.values()].map(async row => {
    const [plan, route] = await Promise.all([
      read('关联任务', () => api.flightApi.detail(row.plan_id)),
      read('事件航线版本', () => api.flightApi.routeVersion(row.route_version_id))
    ]);
    return { plan, route, routeId: row.route_version_id, planId: row.plan_id };
  }));
  result.plan = result.linkedPlans[0]?.plan || null;
  if (!result.plan && (result.risk?.plan_id || item.plan_id)) result.plan = await read('关联任务', () => api.flightApi.detail(result.risk?.plan_id || item.plan_id));
  return result;
}

export function riskEvidenceContext(data) {
  const { item, fact, hits } = data, context = emptyRiskContext(item);
  const versions = new Map();
  for (const hit of caseHits(data)) {
    const area = hit.airspace, version = area?.version;
    if (!version?.airspace_version_id) continue;
    const key = version.airspace_version_id;
    if (!versions.has(key)) versions.set(key, { area, hitTimes: [] });
    versions.get(key).hitTimes.push(`${hit.occurrence ? `第${hit.occurrence}次升级` : '首次告警'} · ${evidenceTime(hit.observed_at ?? hit.evaluated_at)}`);
  }
  context.airspaces = [...versions.values()].flatMap(({ area, hitTimes }) => toAirspaces([{ ...area, current_version: area.version }])
    .map(adapted => ({ ...adapted, id: `${adapted.id} · V${area.version.version_no}`, historical: true,
      historyRows: [['历史版本', `V${area.version.version_no}`], ['有效时段', `${evidenceTime(area.version.valid_from)} ～ ${evidenceTime(area.version.valid_to)}`], ['命中时间', unique(hitTimes).join('；')]] })));
  context.flightPlans = (data.linkedPlans || []).flatMap(({ plan, route, routeId, planId }) => plan && route && routeId && plan.plan_id === planId && route.route_version_id === routeId
    ? toFlightPlans([{ ...plan, route: { ...plan.route, route_version_id: routeId } }], { [routeId]: route }).map(row => ({ ...row, id: `${row.id}:${routeId}` })) : []);
  for (const trajectory of data.trajectories || []) {
    let segment = [];
    const flush = () => { if (segment.length > 1) context.lines.push({ coordinates: segment, label: '报警时的实测轨迹' }); segment = []; };
    for (const row of list(trajectory.points)) {
      const measured = point(row.longitude, row.latitude, '报警时的实测点', 'EVENT_SNAPSHOT');
      if (!measured || row.break_before) flush();
      if (measured) { context.points.push(measured); segment.push([measured.lon, measured.lat]); }
    }
    flush();
  }
  const executionPoints = (data.executionEvidence || []).flatMap(row => {
    if (!['takeoff_point','landing_point'].includes(row.dimension)) return [];
    const label = row.dimension === 'takeoff_point' ? '起飞点' : '降落点';
    return [['planned',`当时报备${label}`,'PLANNED'],['actual',`实际${label}`,'EVENT_SNAPSHOT']].flatMap(([key,name,basis]) => {
      const value = row[key];
      if (value?.coordinate_system !== 'WGS84') return [];
      return [point(value.longitude,value.latitude,name,basis)].filter(Boolean);
    });
  });
  context.points.push(...(data.executionEvidence?.length ? executionPoints : plannedEventPoints(data)));
  const position = item.kind === 'SPACE_OBJECT' ? fact : item.position;
  const basis = position?.basis === 'CURRENT_MEAS' ? 'CURRENT_MEAS' : 'EVENT_SNAPSHOT';
  const snapshot = point(position?.longitude, position?.latitude, basis === 'CURRENT_MEAS' ? '当前实测位置' : '事件位置快照', basis);
  if (snapshot && item.kind !== 'WEATHER' && (!position?.basis || ['CURRENT_MEAS', 'EVENT_SNAPSHOT'].includes(position.basis))
      && (basis!=='CURRENT_MEAS' || !item.current_status || item.current_status==='CURRENT')) context.points.push(snapshot);
  const polygon = item.kind === 'WEATHER' && weatherPolygon(fact);
  if (polygon) context.polygons.push({ coordinates: polygon, label: fact.area_name || '气象来源边界' });
  context.notice = data.notices.join('；');
  if (caseAreaId(data) && data.hits.length && !caseHits(data).length) context.notice += ' 本事项报警时的空域边界暂不可用。';
  if ((data.linkedPlans || []).length > context.flightPlans.length) context.notice += ' 报警时的部分航线暂不可用。';
  if (item.kind === 'WEATHER' && !polygon) context.notice += ' 气象影响边界暂不可用。';
  return context;
}

const factLabels = { distance_m: '测得距离（米）', deviation_m: '偏离距离（米）', half_width_m: '走廊半宽（米）', distance_basis: '距离依据',
  altitude_datum: '高度基准', min_altitude_m: '高度下限（米）', max_altitude_m: '高度上限（米）', target_altitude_m: '目标同基准高度（米）',
  target_altitude_amsl_m: '目标海拔（米）', target_height_agl_m: '目标离地高度（米）', local_time: '当地时刻', local_hour: '当地小时',
  timezone: '时区', comparison: '核对结果', dimension: '核对项目', accuracy_m: '位置误差（米）', occurred_at: '事实时间',
  plan_match_code: '任务匹配', match_reason: '匹配原因', required: '核对要求', start_at: '批准开始时间', end_at: '批准结束时间',
  plan_start_at: '批准开始时间', plan_end_at: '批准结束时间', as_of: '判定时刻', overrun_side: '超出时段方向', plan_version: '当时报备版本' };
const valueLabels = { MATCH: '一致', MISMATCH: '不一致', UNDETERMINED: '不可判定', NOT_APPLICABLE: '不适用',
  ROUTE_CENTERLINE: '航线中心线', CORRIDOR_EDGE: '走廊边界', BEFORE_START: '早于开始', AFTER_END: '晚于结束',
  takeoff_point: '起飞点', landing_point: '降落点', pilot: '飞手', reporting_unit: '报送单位' };
const paramLabels = { tolerance_m: '允许偏离（米）', grace_min: '时间宽限（分钟）', distance_basis: '距离依据', max_accuracy_m: '允许位置误差（米）' };
const statusLabels = { PREDICTED: '预测预警', OBSERVED: '实测风险', ACTIVE: '当前有效', CURRENT: '当前有效', FRESH: '观测有效',
  UNKNOWN: '未知', STALE: '观测过期', HISTORY: '历史事件', CLEARED: '已解除', ENDED: '已结束', WITHDRAWN: '预测已撤销', ENTERED: '实测已入区',
  CONFIRMED: '告警已确认', FALSE_POSITIVE: '误报', NOT_CURRENT: '当前不影响', AFFECTING: '当前有影响', NOT_AFFECTING: '当前无影响',
  AMSL: '海拔', AGL: '离地高度', WGS84: 'WGS-84', FULL: '完全匹配', PARTIAL: '部分匹配', NONE: '无匹配', PASS: '通过', FAIL: '未通过' };
export const evidenceDisplay = value => value === true ? '是' : value === false ? '否' : ({ ...SOURCE_MODE_LABEL, ...ALTITUDE_BAND_LABEL, ...OBJECT_TREND_LABEL,
  ...CORRIDOR_RELATION_LABEL, ...DISPOSAL_STATUS_LABEL, ...RISK_STATE_LABEL, ...ALARM_PROGRESS_LABEL, ...valueLabels, ...statusLabels })[value] || known(value);
const formatFact = (key, value) => key.endsWith('_at') || key === 'as_of' ? evidenceTime(value) : evidenceDisplay(value);
const relevantHits = (evaluation, areaId = null) => list(evaluation.hit_details).filter(hit => ['FAIL', 'UNDETERMINED'].includes(hit.result_code)
  && (!areaId || !hit.facts?.airspace_id || hit.facts.airspace_id === areaId));
export function riskEvidenceView(data) {
  const { item, risk, alarm, event, riskCase, fact, evaluations } = data;
  const reasons = unique([item.reason_text, risk?.reason_text, ...list(alarm?.violation_reasons).map(reasonLabel),
    ...evaluations.flatMap(row => list(row.violation_reasons).map(reasonLabel))]);
  if (!reasons.length) reasons.push(reasonLabel(item.reason_code) || '风险原因尚未提供');
  // 风险摘要已是“甲、乙”合并的一句时，不再逐条重复甲、乙。
  const shown = reasons.filter(reason => !reasons.some(other => other !== reason && other.split('、').includes(reason)));
  const rows = [ ['目标', item.target_no || risk?.target_no || alarm?.target_no || '未知'], ['受影响任务', unique((data.linkedPlans || []).map(row => row.plan?.plan_no)).join('、') || data.plan?.plan_no || item.plan_no || risk?.plan_no || '未知'],
    [item.kind === 'UAV' ? '本事项空域' : '区域', riskCase?.airspace_name || item.area_name || fact?.area_name || '未知'], ['事件时间', evidenceTime(item.occurred_at ?? risk?.occurred_at)],
    ['事件事实状态', known(item.state || event?.state || risk?.state)], ['风险阶段', known(item.stage || riskCase?.stage)],
    ['当前影响', known(item.presence_reason || item.current_status || risk?.current_reason || risk?.current_status || alarm?.observation_status)],
    ['办理进度', known(riskCase?.counter?.status || riskCase?.verification_status || risk?.state || item.state)],
    ['来源', `${item.simulated ? '模拟 · ' : ''}${evidenceDisplay(alarm?.source_name || risk?.source_name || fact?.source_name || item.source_mode)}`] ];
  for (const execution of data.executionEvidence || []) {
    const dimension = { takeoff_point:'起飞点',landing_point:'降落点',pilot:'飞手',reporting_unit:'报送单位' }[execution.dimension];
    if (!dimension) continue;
    for (const [key,label] of [['planned','当时报备'],['actual','实际']]) {
      const value = execution[key];
      const position = value?.longitude != null && value?.latitude != null;
      rows.push([`${label}${dimension}`, position ? `${value.longitude}, ${value.latitude}（${value.coordinate_system ? evidenceDisplay(value.coordinate_system) : '坐标系未记录'}）`
        : value?.name ? `${value.name}${value.name_basis === 'CURRENT_DIRECTORY' ? '（当前目录名称）' : ''}` : '未知']);
      if (value?.occurred_at != null) rows.push([`${label}${dimension}时刻`,evidenceTime(value.occurred_at)]);
      if (value?.accuracy_m != null) rows.push([`${label}${dimension}精度`,`${value.accuracy_m} 米`]);
      if (value?.valid_from != null || value?.valid_to != null) rows.push([`${label}${dimension}有效期`,`${evidenceTime(value.valid_from)} ～ ${evidenceTime(value.valid_to)}`]);
      if (value?.source_name || value?.source_mode) rows.push([`${label}${dimension}来源`,[value.source_name,evidenceDisplay(value.source_mode)].filter(Boolean).join(' · ')]);
    }
    rows.push([`${dimension}核对`,evidenceDisplay(execution.comparison)]);
    if (execution.reason) {
      const explanations = [];
      if (execution.planned_availability !== 'AVAILABLE') explanations.push('当时报备资料暂不可用');
      if (execution.actual_availability !== 'AVAILABLE') explanations.push('实际资料暂不可用');
      if (execution.actual?.longitude != null && !execution.actual.coordinate_system) explanations.push('实际坐标的坐标系未记录，暂无法地图定位');
      if (explanations.length) rows.push([`${dimension}依据说明`,explanations.join('；')]);
    }
  }
  if (!data.executionEvidence?.length) for (const evaluation of evaluations) for (const hit of relevantHits(evaluation)) {
    if (['takeoff_point','landing_point'].includes(hit.facts?.dimension)) {
      const label = hit.facts.dimension === 'takeoff_point' ? '起飞点' : '降落点';
      const planned = plannedEventPoints({ ...data,evaluations:[{ ...evaluation,hit_details:[hit] }] })[0];
      rows.push([`当时报备${label}`, planned ? `${planned.lon}, ${planned.lat}` : '未知'],[`实际${label}`, '当时坐标暂不可用']);
    }
  }
  for (const link of data.linkedPlans || []) if (link.route && link.routeId && link.route.route_version_id === link.routeId) {
    rows.push([`事件航线${link.plan?.plan_no ? ` · ${link.plan.plan_no}` : ''}`, `V${known(link.route.version_no)} · ${evidenceDisplay(link.route.altitude_datum)} · ${known(link.route.min_altitude_m)} ～ ${known(link.route.max_altitude_m)} 米`]);
  }
  if (item.kind === 'SPACE_OBJECT') rows.push(['事件位置', fact?.longitude != null && fact?.latitude != null ? `${fact.longitude}, ${fact.latitude}` : '未知'],
    ['距航线中心线', fact?.distance_to_route_m == null ? '未知' : `${fact.distance_to_route_m} 米`], ['高度带', `${evidenceDisplay(fact?.altitude_band)} · ${evidenceDisplay(fact?.altitude_datum)}`],
    ['目标高度', fact?.target_altitude_raw == null ? '未知' : `${fact.target_altitude_raw} 米 · ${evidenceDisplay(fact.altitude_datum)}`],
    ['数量', fact?.object_count == null ? '未知（不按0计）' : String(fact.object_count)], ['数量趋势', known(fact?.trend)],
    ['监测时段', `${evidenceTime(fact?.window_from)} ～ ${evidenceTime(fact?.window_to)}`]);
  if (item.kind === 'WEATHER') {
    rows.push(['气象摘要', known(fact?.summary)], ['资料性质', fact?.forecast_message_id ? '预报资料' : '来源未明确预报或观测性质'],
      ['发布时间', evidenceTime(fact?.published_at)], ['有效时段', `${evidenceTime(fact?.valid_from)} ～ ${evidenceTime(fact?.valid_to)}`],
      ['气象边界', weatherPolygon(fact) ? '来源提供的有效边界' : '未提供有效边界，无法绘制影响范围'],
      ['高度范围', '未提供高度分层，不能认定影响全部高度']);
    for (const [key, label, unit] of [['wind_speed_mps', '风速', 'm/s'], ['wind_from_degrees', '来风方向', '°'], ['visibility_m', '能见度', '米'], ['precipitation_rate_mm_h', '降雨强度', 'mm/h']]) {
      if (fact?.[key] != null) rows.push([label, `${fact[key]} ${unit}`]);
    }
  }
  const names = {};
  for (const hit of data.hits || []) if (hit.airspace?.airspace_id && hit.airspace.name) names[hit.airspace.airspace_id] = hit.airspace.name;
  if (riskCase?.airspace_id && riskCase.airspace_name) names[riskCase.airspace_id] = riskCase.airspace_name;
  const plans = {};
  for (const link of data.linkedPlans || []) if (link.plan?.plan_id && link.plan.plan_no) plans[link.plan.plan_id] = link.plan.plan_no;
  const hitTitle = hit => hit.reason_code === 'BVLOS_EXCEEDED' ? reasonLabel(hit.reason_code)
    : ruleHitText(hit.message, { names, plans, fallback: reasonLabel(hit.reason_code) }) || '判定依据';
  const checks = evaluations.flatMap(evaluation => relevantHits(evaluation, caseAreaId(data)).map(hit => ({
    title: `${hitTitle(hit)} · ${evidenceTime(evaluation.observed_at ?? evaluation.evaluated_at)}`,
    message: '', rows: Object.entries(hit.facts || {}).filter(([key]) => factLabels[key]).map(([key, value]) =>
      [factLabels[key], formatFact(key, value)]),
    params: list(hit.params).filter(param => paramLabels[param.key]).map(param => `${paramLabels[param.key]}：${evidenceDisplay(param.value)}`)
  })));
  const keyEvidence = evaluations.flatMap(evaluation => relevantHits(evaluation, caseAreaId(data)).map(hit => {
    const facts = Object.entries(hit.facts || {}).filter(([key]) => factLabels[key] && !['required','plan_version'].includes(key))
      .map(([key, value]) => `${factLabels[key]}：${formatFact(key, value)}`);
    const params = list(hit.params).filter(param => paramLabels[param.key]).map(param => `${paramLabels[param.key]}：${evidenceDisplay(param.value)}`);
    return { title: hitTitle(hit), text: [...facts, ...params].join('；'), time: evidenceTime(evaluation.observed_at ?? evaluation.evaluated_at) };
  }));
  const scopedReasons = unique(caseHits(data).map(hit => reasonLabel(hit.reason_code)));
  return { reasons: shown, rows: rows.map(([label,value]) => [label,evidenceDisplay(value)]), checks, keyEvidence, scopedReasons };
}
