import { ALTITUDE_BAND_LABEL, CORRIDOR_RELATION_LABEL, SEVERITY_LABEL, SEVERITY_TAG, labelOf } from './labels.js';

// P03（2026-10-08 用户确认）：鸟群风险发现以后，每一轮评估都记进这条风险的“评估历史”，风险详情按段列出。
// 一段 = 相邻几次评估的事实都没变（离航线距离按 50 米一档、在不在航线走廊内、高度档、当时是否构成风险及等级），最长 5 分钟。
// 时间一律按北京时间写：和今天同一天只写时分秒，否则带月日。

const ZONE = 'Asia/Shanghai';
export const EVALUATION_LEVEL_NOTE = '风险等级按发现时定，之后的评估只记录，不会自动改等级。';

function validDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
const dayOf = date => date.toLocaleDateString('zh-CN', { timeZone: ZONE });
const clockOf = date => date.toLocaleTimeString('zh-CN', { hour12: false, timeZone: ZONE });
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function evaluationTime(value, now = Date.now()) {
  const date = validDate(value);
  if (!date) return '未知';
  if (dayOf(date) === dayOf(new Date(now))) return clockOf(date);
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: ZONE, month: 'numeric', day: 'numeric' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('month')}月${part('day')}日 ${clockOf(date)}`;
}

/** 一段的时间：只评估过一次写一个时刻，否则写“起–止”；同一天的止只写时分秒。 */
export function segmentTimeText(segment, now = Date.now()) {
  const first = evaluationTime(segment?.first_evaluated_at, now);
  const last = validDate(segment?.last_evaluated_at), start = validDate(segment?.first_evaluated_at);
  if (!last || !start || last.getTime() === start.getTime()) return first;
  return `${first}–${dayOf(last) === dayOf(start) ? clockOf(last) : evaluationTime(last, now)}`;
}

/** 离航线多远、在不在走廊里、高度档，一行写完；没测到距离时不再重复“距离未知”。 */
export function segmentFactsText(segment) {
  const min = finite(segment?.min_distance_m), max = finite(segment?.max_distance_m);
  const facts = [];
  if (min === null) facts.push('离航线距离未测到');
  else {
    const low = Math.round(min), high = Math.round(max ?? min);
    facts.push(low === high ? `离航线中心线约 ${low} 米` : `离航线中心线约 ${low}–${high} 米`);
  }
  if (segment?.corridor_relation && segment.corridor_relation !== 'UNKNOWN') facts.push(labelOf(CORRIDOR_RELATION_LABEL, segment.corridor_relation, ''));
  facts.push(labelOf(ALTITUDE_BAND_LABEL, segment?.altitude_band, '高度未知'));
  return facts.filter(Boolean).join(' · ');
}

/** 当时是否构成风险及等级：标签文字与颜色。 */
export function segmentVerdict(segment) {
  if (!segment?.risk_present) return { text: '不构成风险', tag: 't-gray' };
  return { text: `${labelOf(SEVERITY_LABEL, segment.severity, '等级未知')}风险`, tag: SEVERITY_TAG[segment.severity] || 't-gray' };
}

/** 最上面一句：共评估几次，首次、最近几点。 */
export function evaluationSummaryText(history, now = Date.now()) {
  if (!history?.evaluation_count) return '';
  return `共评估 ${history.evaluation_count} 次，首次 ${evaluationTime(history.first_evaluated_at, now)}，最近 ${evaluationTime(history.last_evaluated_at, now)}`;
}

/** 改动以前发现的风险没有发现那次的记录，说清楚下面从哪里开始。 */
export function evaluationHistoryNote(history) {
  if (!history?.applicable || history.from_detection) return '';
  return history.total
    ? '这条风险是在开始记评估历史以前发现的，发现那次的评估没有记录，下面是之后的评估。'
    : '这条风险是在开始记评估历史以前发现的，之后还没有再评估过，所以这里没有记录。';
}
