/* 无人机现在状态（2026-10-14 rose 确认方案）：把“无人机现在怎样了”和“告警处理到哪一步”分开显示。
   只读已有事实：目标是否还在有效时限内、最新合法性研判、通知后的位置判断。
   停报、失联、位置未知都不算飞离；通知后的“已离开”只是当时的判断，最新研判仍违规时以违规为准。 */

export const UAV_NOW_TITLE = {
  VIOLATING: '仍在违规', LEFT: '已飞离', COMPLIANT: '已不再违规', BOUNDARY: '压在边界', UNKNOWN_POSITION: '位置不明', PENDING: '还在判断'
};
const TONE = { VIOLATING: 'red', LEFT: 'green', COMPLIANT: 'green', BOUNDARY: 'amber', UNKNOWN_POSITION: 'grey', PENDING: 'grey' };

const clock = value => new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

export function ageText(at, now) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

/** 通知后位置判断的依据，用于“当时判定已撤离”下面的小字。 */
export function departureBasisText(observation) {
  if (!observation?.presence) return '';
  const at = Number(observation.position?.observed_at);
  const when = Number.isFinite(at) && at > 0 ? `${clock(at)} 的实测位置` : '通知后的实测位置';
  if (observation.presence === 'LEFT') {
    return observation.basis === 'LATEST_LEGALITY' ? `依据${when}，最新研判已为合法` : `依据${when}，已离开告警时所在区域`;
  }
  if (observation.presence === 'STILL_PRESENT') return `依据${when}，仍在告警区域或仍有违规`;
  if (observation.basis === 'AIRSPACE_BOUNDARY') return `依据${when}，位置压在区域边线上，无法判断`;
  return '通知后没有时效内的新实测位置，无法判断是否离开';
}

/**
 * @param {object} input
 * @param {boolean} input.current 目标是否仍在有效时限内（地图上的目标，或告警的 observation_status=CURRENT）
 * @param {number} [input.observedAt] 最新实测时间
 * @param {string} [input.legalStatus] 最新研判 LEGAL / ILLEGAL / ABNORMAL / UNDETERMINED
 * @param {string[]} [input.legalReasons] 最新研判的违规原因码
 * @param {object} [input.departure] 通知后的位置判断 departure_observation
 * @param {number} input.now 平台时间
 * @param {(code:string)=>string} [input.reasonText]
 */
export function uavNowStatus({ current, observedAt, legalStatus, legalReasons, departure, now, reasonText = code => code }) {
  const observed = Number(observedAt);
  const age = Number.isFinite(observed) && observed > 0 ? ageText(observed, now) : '';
  const basis = age ? `${clock(observed)} 实测 · ${age}` : '';
  const result = key => ({ key, title: UAV_NOW_TITLE[key], tone: TONE[key], detail: '', basis, departed: false });
  if (!current) {
    return { ...result('UNKNOWN_POSITION'),
      detail: age ? `已超过有效时限没有新位置，不能当作已飞离` : '没有时效内的实测位置，不能当作已飞离',
      basis: age ? `最后实测 ${clock(observed)} · ${age}` : '' };
  }
  const reasons = (Array.isArray(legalReasons) ? legalReasons : []).map(reasonText).filter(Boolean);
  const presence = departure?.presence;
  if (legalStatus === 'ILLEGAL' || presence === 'STILL_PRESENT') {
    const leftAt = Number(departure?.position?.observed_at);
    const left = presence === 'LEFT'
      ? `通知后${Number.isFinite(leftAt) && leftAt > 0 ? ` ${clock(leftAt)} ` : ''}曾判定已离开，但最新研判仍为违规` : '';
    return { ...result('VIOLATING'),
      title: reasons.length ? `仍在违规：${reasons.join('、')}` : UAV_NOW_TITLE.VIOLATING,
      detail: left || (presence === 'STILL_PRESENT' ? '通知后仍在告警区域或仍有违规' : '最新研判仍为违规') };
  }
  if (departure?.basis === 'AIRSPACE_BOUNDARY' && presence !== 'LEFT') {
    return { ...result('BOUNDARY'), detail: '位置正好在区域边线上，等下一个位置再判断' };
  }
  if (presence === 'LEFT') {
    // departed：有有效位置证明通知后已离开，且最新研判不再违规（2026-10-14 rose 选定：这类告警从融合感知消失）。
    return { ...result(departure.basis === 'LATEST_LEGALITY' ? 'COMPLIANT' : 'LEFT'), departed: true,
      detail: departureBasisText(departure).replace(/^依据/, '') };
  }
  if (legalStatus === 'LEGAL') return { ...result('COMPLIANT'), detail: '最新研判为合法' };
  return { ...result('PENDING'), detail: '还没有足够的数据判断现在是否违规' };
}

const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

/** 卡片里的“无人机现在”整块；process 是处理进度，缩成右上角小标签。 */
export function uavNowHtml(status, { process = '' } = {}) {
  if (!status) return '';
  return `<div class="uav-now is-${status.tone}" role="status" aria-label="无人机现在：${escapeHtml(status.title)}">
    <div class="uav-now-top"><span class="uav-now-label">无人机现在</span>${process ? `<span class="uav-now-process">${escapeHtml(process)}</span>` : ''}</div>
    <strong class="uav-now-title"><i aria-hidden="true"></i>${escapeHtml(status.title)}</strong>
    ${status.detail ? `<span class="uav-now-sub">${escapeHtml(status.detail)}</span>` : ''}
    ${status.basis ? `<span class="uav-now-sub">${escapeHtml(status.basis)}</span>` : ''}
  </div>`;
}

/** 列表行里的小状态。 */
export function uavNowPillHtml(status) {
  if (!status) return '';
  return `<span class="uav-now-pill is-${status.tone}"><i aria-hidden="true"></i>${escapeHtml(UAV_NOW_TITLE[status.key])}</span>`;
}

/**
 * 告警原因：先写最新研判的结论，和告警记录的原因不同才另写一行。研判时间要后台补给后再显示。
 * 告警记录的原因随升级累计：没升级过叫“出告警时”；升级记录读全了拆成出告警时和升级时新增；否则叫“告警累计原因”。
 */
export function alarmReasonView({ legalStatus, legalReasons, alarmReasons, escalationCount = 0, escalations = null, escalationsTotal = 0, reasonText = code => code }) {
  const join = codes => (Array.isArray(codes) ? codes : []).map(reasonText).filter(Boolean).join('、');
  const split = alarmReasonSplit(alarmReasons, { escalationCount, escalations, escalationsTotal });
  const escalated = Number(escalationCount) > 0;
  const resolved = escalated && split.label === '告警原因';
  const atAlarmLabel = escalated && !resolved ? '告警累计原因' : '出告警时';
  const recorded = resolved && split.added.length
    ? `${join(split.atAlarm) || '未记录'}；升级时新增：${join(split.added)}`
    : join(alarmReasons) || '未记录具体触发原因';
  const latest = legalStatus === 'ILLEGAL' ? (join(legalReasons) || '违规（原因未提供）')
    : legalStatus === 'LEGAL' ? '已无违规' : '';
  if (!latest) {
    return { label: resolved && split.added.length ? '告警原因（出告警时；升级时新增）' : split.label, text: recorded, tone: 'risk', atAlarm: '', atAlarmLabel };
  }
  return { label: '现在的违规原因 · 最新研判', text: latest, tone: legalStatus === 'LEGAL' ? 'ok' : 'risk',
    atAlarm: latest === recorded ? '' : recorded, atAlarmLabel };
}

/** 告警原因的标题：告警记录的原因会随升级累计；升级过就不能说成“出告警时”。 */
export function alarmReasonLabel(escalationCount) {
  return Number(escalationCount) > 0 ? '告警原因（累计，含升级时新增）' : '告警原因（出告警时）';
}

/**
 * 有升级记录时，把累计原因拆成出告警时的和升级时新增的；升级记录没读全时不拆。
 * @returns {{ label: string, atAlarm: string[], added: string[] }}
 */
export function alarmReasonSplit(reasons, { escalationCount = 0, escalations = null, escalationsTotal = 0 } = {}) {
  const all = [...new Set((Array.isArray(reasons) ? reasons : []).filter(Boolean))];
  if (!(Number(escalationCount) > 0)) return { label: '告警原因（出告警时）', atAlarm: all, added: [] };
  const rows = Array.isArray(escalations) ? escalations : null;
  if (!rows || !rows.length || rows.length < Number(escalationsTotal || escalationCount)) {
    return { label: alarmReasonLabel(escalationCount), atAlarm: all, added: [] };
  }
  const added = [...new Set(rows.flatMap(row => Array.isArray(row?.reasons_added) ? row.reasons_added : []))];
  return { label: '告警原因', atAlarm: all.filter(code => !added.includes(code)), added: all.filter(code => added.includes(code)) };
}
