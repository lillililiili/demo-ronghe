/* 告警详情“高度/速度”（2026-10-18 rose 确认）：流程结束后最新状态可能没有速度，保留最后一次上报的有效速度，
   并写明是哪一刻上报的；高度同样取最新状态里的值。没有任何速度记录才写“—”，不补算速度。 */
const clock = value => new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

/**
 * @param {object|null} latest 目标 latest_state
 * @param {{speed_mps:number|string, observed_at:number}|null} lastReported 目标详情 last_reported_speed（最新状态没有速度时后台给出）
 * @returns {string} 例如“120 m / 8.5 m/s”或“120 m / 8.5 m/s（最后一次上报 10:21:05）”
 */
export function altitudeSpeedText(latest, lastReported) {
  const altitude = finite(latest?.altitude_amsl_m) ? `${latest.altitude_amsl_m} m` : '— m';
  if (finite(latest?.speed_mps)) return `${altitude} / ${latest.speed_mps} m/s`;
  if (finite(lastReported?.speed_mps)) {
    const at = finite(lastReported.observed_at) ? `最后一次上报 ${clock(lastReported.observed_at)}` : '最后一次上报';
    return `${altitude} / ${lastReported.speed_mps} m/s（${at}）`;
  }
  return `${altitude} / — m/s`;
}
