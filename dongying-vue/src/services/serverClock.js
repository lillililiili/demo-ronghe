/* 平台时钟（CDX-P01）：地图上目标"此刻还在不在"要按平台的时间判，不能按本机时间判。
   本机时钟和平台差十几秒时，刚收到的目标会被当成已过期（本机快）或还没到（本机慢），地图上一个都不显示。
   偏差取接口响应头 Date：它只精确到秒，按请求往返的中点估计，只用往返快的样本，取最近几次的中位数；
   估出来不到 2 秒的偏差在 Date 的误差以内，按 0 算，免得同一台机器上的页面被这点误差带偏。 */
const MAX_ROUND_TRIP_MS = 2_000;
const IGNORE_BELOW_MS = 2_000;
const KEEP_SAMPLES = 7;

const samples = [];
let offsetMs = 0;

export function noteServerDate(dateHeader, sentAt, receivedAt) {
  const serverSecond = Date.parse(dateHeader || '');
  if (!Number.isFinite(serverSecond) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return;
  const roundTrip = receivedAt - sentAt;
  if (roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) return;
  // Date 截到整秒：平台此刻落在 [Date, Date+1s) 之间，取中间。
  samples.push(serverSecond + 500 - (sentAt + roundTrip / 2));
  if (samples.length > KEEP_SAMPLES) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  offsetMs = Math.abs(median) < IGNORE_BELOW_MS ? 0 : Math.round(median);
}

/** 平台此刻（毫秒）。还没有样本时等于本机时间。 */
export const serverNow = () => Date.now() + offsetMs;

/** 平台时间减本机时间（毫秒）；测试与页面提示用。 */
export const serverClockOffset = () => offsetMs;

export function resetServerClock() {
  samples.length = 0;
  offsetMs = 0;
}
