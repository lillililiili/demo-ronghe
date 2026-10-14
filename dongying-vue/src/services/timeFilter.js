/* 列表页共用的“时间”筛选（2026-10-14 用户要求：告警事件、飞行任务、证据管理都加）。
   选项与口径一致：全部、今天、近 24 小时、近 7 天、自定义起止，全部按北京时间；
   返回半开区间 [from, to) 的毫秒时间戳，由各页按自己的后端参数名提交，后端在分页和计数前筛选。
   每次查询时现算窗口，实时刷新和跨零点自动跟上，不缓存旧窗口。 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
/* “近 N”窗口的终点留 5 分钟余量：设备时钟略快时，刚发生的记录不会因为时间戳比本机“现在”晚几秒而被筛掉。 */
const RECENT_END_SLACK_MS = 5 * 60_000;

export const TIME_FILTER_OPTIONS = Object.freeze([
  { value: '', label: '全部' },
  { value: 'TODAY', label: '今天' },
  { value: 'LAST_24H', label: '近 24 小时' },
  { value: 'LAST_7D', label: '近 7 天' },
  { value: 'CUSTOM', label: '自定义起止' }
]);
const CHOICES = new Set(TIME_FILTER_OPTIONS.map(option => option.value));

export function isTimeFilterChoice(value) {
  return CHOICES.has(value ?? '');
}

/* 北京时间今天 [00:00, 次日 00:00)。 */
export function beijingToday(now = Date.now()) {
  const from = Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;
  return { from, to: from + DAY_MS };
}

/* 日期时间选择框按浏览器所在时区显示和回传；页面上的时间都按北京时间显示，
   所以把框里看到的年月日时分秒原样当作北京时间。浏览器本身在北京时间时结果不变。 */
export function beijingWallClock(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  const d = new Date(value);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
    - BEIJING_OFFSET_MS;
}

/* 自定义起止是否完整有效（两端都有、开始早于结束）。 */
export function customRangeValid(range) {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const from = beijingWallClock(range[0]), to = beijingWallClock(range[1]);
  return from != null && to != null && from < to;
}

/* 当前选择对应的时间窗；“全部”或自定义起止没填完整时返回 null（不加时间条件）。 */
export function timeFilterWindow(choice, range = null, now = Date.now()) {
  switch (choice) {
    case 'TODAY': return beijingToday(now);
    case 'LAST_24H': return { from: now - DAY_MS, to: now + RECENT_END_SLACK_MS };
    case 'LAST_7D': return { from: now - 7 * DAY_MS, to: now + RECENT_END_SLACK_MS };
    case 'CUSTOM': return customRangeValid(range) ? { from: beijingWallClock(range[0]), to: beijingWallClock(range[1]) } : null;
    default: return null;
  }
}

/* 用在筛选摘要等文字里。 */
export function timeFilterLabel(choice) {
  return TIME_FILTER_OPTIONS.find(option => option.value === (choice ?? ''))?.label || '全部';
}
