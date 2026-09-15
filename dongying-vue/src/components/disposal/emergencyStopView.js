/* 只把服务端停止事实映射为文案，不推导设备物理停机成功。 */
const DEVICE_STATUS = {
  QUEUED: '停止命令正在排队', WAITING_FEEDBACK: '已发出停止命令，等待反馈',
  CONTROLLER_ALL_OFF_ACK: '控制器已确认全关，实际停机仍需核查',
  FAILED: '停止命令失败，设备停止尚未确认', TIMED_OUT: '等待反馈超时，设备停止尚未确认',
  OFFLINE: '设备离线，无法确认停止', UNSUPPORTED: '不支持远程停止，请现场处理',
  MANUALLY_CONFIRMED: '现场已确认停止', NOT_REQUIRED: '未执行，已撤销，无需停止设备'
};

export function deviceStopText(device) { return DEVICE_STATUS[device?.stop_status] || '停止结果未知'; }

export function requiresStopFollowup(overview) {
  return !!overview?.latest_stop && (!overview.latest_stop.devices?.length
    || overview.latest_stop.devices.some(device => !['MANUALLY_CONFIRMED', 'NOT_REQUIRED'].includes(device.stop_status)));
}

export function stopActionLabel(overview) {
  if (typeof overview?.requires_device_stop === 'boolean') return overview.requires_device_stop ? '急停本次处置' : '撤销本次处置';
  const rows = overview?.authorizations || [];
  return rows.length && rows.every(row => ['APPROVED', 'REQUESTED'].includes(row.status))
    ? '撤销本次处置' : '急停本次处置';
}

export function stopSummary(overview) {
  const devices = overview?.latest_stop?.devices || [];
  if (!devices.length) return { tone: 'warning', title: '未取得设备停止反馈', detail: '本次处置已中止；请核对是否有现场动作需要停止。' };
  if (devices.every(device => device.stop_status === 'NOT_REQUIRED')) return { tone: 'neutral', title: '本次处置已撤销', detail: '尚未执行的处置已撤销，无需向设备下发停止命令。' };
  const unresolved = devices.filter(device => !['MANUALLY_CONFIRMED', 'NOT_REQUIRED'].includes(device.stop_status));
  if (!unresolved.length) return { tone: 'success', title: '设备已确认停止', detail: '已记录现场停机确认，可查看确认人、时间和依据。' };
  if (unresolved.every(device => device.stop_status === 'CONTROLLER_ALL_OFF_ACK')) {
    return { tone: 'warning', title: '已收到全关确认', detail: '控制器已确认全关，实际停机仍需现场核查。' };
  }
  if (unresolved.every(device => ['QUEUED', 'WAITING_FEEDBACK'].includes(device.stop_status))) {
    return { tone: 'warning', title: '等待设备停止反馈', detail: unresolved.some(device => device.stop_status === 'QUEUED')
      ? '停止命令正在排队，设备是否停止仍需确认。' : '已发出停止命令，设备是否停止仍需确认。' };
  }
  return { tone: 'error', title: '设备停止尚未确认', detail: `${unresolved.length} 台设备仍需核查，请查看设备反馈并继续处理。` };
}

export function stopTime(value) {
  if (value == null) return '—';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
