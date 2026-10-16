/* 只把服务端停止事实映射为文案，不推导设备物理停机成功。
 * 2026-10-14 起急停后不再登记现场停机核查：只说明停止结果和下一步，不要求任何人确认；
 * MANUALLY_CONFIRMED 只出现在旧记录里，只读显示。 */
const DEVICE_STATUS = {
  QUEUED: '停止命令正在排队', WAITING_FEEDBACK: '已发出停止命令，等待反馈',
  CONTROLLER_ALL_OFF_ACK: '控制器已确认全关',
  FAILED: '停止命令失败，可重试停止或到现场关停设备', TIMED_OUT: '等待反馈超时，可重试停止或到现场关停设备',
  OFFLINE: '设备离线，停止命令未下发；可重试停止或到现场关停设备', UNSUPPORTED: '该处置不支持远程停止，请到现场关停设备',
  MANUALLY_CONFIRMED: '现场已确认停止', NOT_REQUIRED: '未执行，已撤销，无需停止设备'
};
const WAITING = ['QUEUED', 'WAITING_FEEDBACK'];
const SETTLED = ['CONTROLLER_ALL_OFF_ACK', 'MANUALLY_CONFIRMED', 'NOT_REQUIRED'];

export function deviceStopText(device) { return DEVICE_STATUS[device?.stop_status] || '停止结果未知'; }

/** 还在等设备回停止结果时才需要更快地回读；停止结果已定的不再催人处理。 */
export function requiresStopFollowup(overview) {
  return !!overview?.latest_stop && (!overview.latest_stop.devices?.length
    || overview.latest_stop.devices.some(device => WAITING.includes(device.stop_status)));
}

export function stopActionLabel(overview) {
  if (typeof overview?.requires_device_stop === 'boolean') return overview.requires_device_stop ? '急停本次处置' : '撤销本次反制';
  const rows = overview?.authorizations || [];
  return rows.length && rows.every(row => ['APPROVED', 'REQUESTED'].includes(row.status))
    ? '撤销本次反制' : '急停本次处置';
}

export function stopSummary(overview) {
  const devices = overview?.latest_stop?.devices || [];
  if (!devices.length) return { tone: 'warning', title: '未取得设备停止反馈', detail: '本次处置已中止；如有设备仍在动作，请到现场关停。' };
  if (devices.every(device => device.stop_status === 'NOT_REQUIRED')) return { tone: 'neutral', title: '本次处置已撤销', detail: '尚未执行的处置已撤销，无需向设备下发停止命令。' };
  const notStopped = devices.filter(device => ![...WAITING, ...SETTLED].includes(device.stop_status));
  if (notStopped.length) {
    return { tone: 'error', title: '远程停止未完成', detail: `${notStopped.length} 台设备未能远程停止，请到现场关停设备；支持重试的可先重试停止。` };
  }
  const waiting = devices.filter(device => WAITING.includes(device.stop_status));
  if (waiting.length) {
    return { tone: 'warning', title: '等待设备停止反馈', detail: waiting.some(device => device.stop_status === 'QUEUED')
      ? '停止命令正在排队。' : '已发出停止命令，等待设备反馈。' };
  }
  const stopped = devices.filter(device => device.stop_status !== 'NOT_REQUIRED');
  if (stopped.every(device => device.stop_status === 'MANUALLY_CONFIRMED')) {
    return { tone: 'success', title: '设备已确认停止', detail: '已记录现场停机确认，可查看确认人、时间和依据。' };
  }
  return { tone: 'success', title: '已收到全关确认', detail: '控制器已确认全关。' };
}

export function stopTime(value) {
  if (value == null) return '—';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
