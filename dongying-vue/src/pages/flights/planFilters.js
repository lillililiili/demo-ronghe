/* 飞行计划列表的筛选口径与行文字。统计卡与列表共用同一口径（状态 + 北京时间今天），
   点卡片后列表数量与卡片数字一致；手动刷新、定时重读与实时刷新都按同一份筛选重取。 */
import { readableNo } from '../../ui/labels.js';
import { displayPlanNo } from '../../ui/deviceNumber.js';

/* 与后端 keyword 上限一致；后端不去空格，空白会被拒绝，所以前端先去首尾空格再提交。 */
export const PLAN_KEYWORD_MAX = 128;
/* 前四张统计卡对应的状态，“今日报备计划”不限状态。历史 APPROVED 已由迁移并入 PENDING。 */
export const PLAN_KPI_STATUS = Object.freeze({ today: '', executing: 'EXECUTING', pending: 'PENDING', completed: 'COMPLETED' });
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;

/* 北京时间今天 [from, to)；与统计卡的查询窗口完全相同。 */
export function beijingDayWindow(now = Date.now()) {
  const from = Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;
  return { from, to: from + DAY_MS };
}

/* 其他页面的“任务”下拉：默认只列还没结束的任务（执行中的和以后的），已结束的只有勾选“含已过期”才列出；
   按开始时间新到旧，由后端时间窗筛选（结束时间不早于现在），不在浏览器里滤大列表。 */
const PICKER_AHEAD_MS = 366 * DAY_MS;
export function planPickerQuery({ includeExpired = false, size = 100, now = Date.now() } = {}) {
  const query = { page: 1, size };
  if (!includeExpired) {
    query.window_from = now;
    query.window_to = now + PICKER_AHEAD_MS;
  }
  return query;
}
export function planPickerItems(plans = [], { includeExpired = false } = {}) {
  return includeExpired ? plans : plans.filter(plan => plan?.status_code !== 'CANCELLED');
}
export function planPickerLabel(plan) {
  const no = displayPlanNo(plan?.plan_no) || plan?.plan_id || '任务';
  const name = String(plan?.route?.name || '').trim();
  const head = name ? `${name}（${no}）` : no;
  const start = Number(plan?.start_at);
  if (plan?.start_at == null || !Number.isFinite(start)) return head;
  const { day, clock } = beijingParts(start);
  return `${head} · ${day.slice(day.indexOf('/') + 1)} ${clock}`;
}

export function normalizePlanKeyword(value) {
  return String(value ?? '').trim().slice(0, PLAN_KEYWORD_MAX);
}

/* 列表请求参数：空值由 flightApi 丢弃；只在“今天”范围打开时带时间窗。 */
export function planListQuery(filters = {}, { page = 1, size = 20, now = Date.now() } = {}) {
  const query = { page, size, status_code: filters.status_code || '', keyword: normalizePlanKeyword(filters.keyword) };
  if (filters.today) {
    const day = beijingDayWindow(now);
    query.window_from = day.from;
    query.window_to = day.to;
  }
  return query;
}

/* 当前筛选恰好等于哪张统计卡（用于高亮）；不是“今天”范围时没有选中的卡。 */
export function activePlanKpi(filters = {}) {
  if (!filters.today) return null;
  return Object.keys(PLAN_KPI_STATUS).find(key => PLAN_KPI_STATUS[key] === (filters.status_code || '')) || null;
}

/* 点卡片：只看今天该状态的计划，并清空关键词，使列表与卡片数字一致；再点已选中的卡片恢复全部日期与状态。 */
export function planKpiFilters(filters = {}, key) {
  if (!Object.hasOwn(PLAN_KPI_STATUS, key)) return { ...filters };
  if (activePlanKpi(filters) === key) return { ...filters, today: false, status_code: '' };
  return { ...filters, today: true, status_code: PLAN_KPI_STATUS[key], keyword: '' };
}

function beijingParts(ms) {
  const date = new Date(ms + BEIJING_OFFSET_MS);
  const pad = value => String(value).padStart(2, '0');
  return { day: `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`, clock: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` };
}

/* 计划时段（北京时间）：同一天写“2026/10/6 09:21–10:21”，跨天写两端日期；缺任一端如实说明。 */
export function planWindowText(plan) {
  const start = Number(plan?.start_at), end = Number(plan?.end_at);
  if (plan?.start_at == null || plan?.end_at == null || !Number.isFinite(start) || !Number.isFinite(end)) return '任务时段未提供';
  const a = beijingParts(start), b = beijingParts(end);
  return a.day === b.day ? `${a.day} ${a.clock}–${b.clock}` : `${a.day} ${a.clock} – ${b.day} ${b.clock}`;
}

/* 同名航线的多份计划靠编号和时段区分；内部 ID 不上屏。 */
export function planNumberText(plan) {
  return displayPlanNo(readableNo(plan?.plan_no)) || '编号未提供';
}

/* 上级（管服平台）计划接口不可用时的提示：取不到、原因、最近一次收到，以及列表只代表本系统已有计划。
   available 不是 false（可用或状态读不到）时不提示，避免把未知说成断开。 */
export function upstreamPlanNotice(status, formatTime) {
  if (!status || status.available !== false) return null;
  const configured = status.configured_at != null ? formatTime(status.configured_at) : '';
  const reason = status.status === 'NOT_CONFIGURED' ? '管服平台任务接口尚未配置'
    : status.status === 'AWAITING_ADAPTER' ? `管服平台任务接口${configured ? `已于 ${configured} 保存配置，但` : ''}尚未接通`
      : String(status.message || '管服平台任务接口当前不可用').replace(/[，,]?\s*上级任务数据暂时取不到。?$/, '');
  const everReceived = status.last_received_at != null;
  const received = everReceived ? `最近一次收到上级任务：${formatTime(status.last_received_at)}` : '尚未收到过上级任务';
  const scope = everReceived ? '下方列表为本系统已有的任务（含此前收到的上级任务）' : '下方列表只含本系统已有的任务（模拟或本地录入）';
  return {
    title: '上级任务数据暂时取不到',
    detail: `${reason}；${received}。${scope}，可能不全或已过时，不代表上级没有任务。`
  };
}
