import { flightApi } from '@/services/flightApi.js';
import { deviceApi } from '@/services/deviceApi.js';

// 当前状态只读服务端设备事实；告警记录与处置单完成快照不替代当前健康依据。
export function deviceCheckCategory(row = {}) {
  if (row.abnormal === true) return 'ABNORMAL';
  if (row.abnormal === false && row.complete === true && row.connectivity === 'ONLINE' && row.health_code === 'GOOD') return 'NORMAL';
  return 'UNKNOWN';
}
export function deviceCheckCounts(rows = []) {
  return rows.reduce((counts, row) => {
    counts[deviceCheckCategory(row)]++;
    if (row.incidents?.length) counts.withHistory++;
    return counts;
  }, { NORMAL: 0, ABNORMAL: 0, UNKNOWN: 0, withHistory: 0 });
}
export function deviceCheckHistory(row = {}) {
  const incidents = row.incidents || [];
  if (!incidents.length) return '';
  const open = incidents.filter(item => item.closed_at == null).length;
  return open ? `告警记录 ${incidents.length} 条 · 未关闭 ${open} 条`
    : `历史告警 ${incidents.length} 条 · 均已关闭`;
}
export function deviceCheckStatus(row = {}) {
  const category = deviceCheckCategory(row);
  if (category === 'NORMAL') return '正常';
  if (category === 'UNKNOWN') return row.connectivity === 'ONLINE'
    ? row.health_code === 'GOOD' ? '在线 · 状态待核查' : '在线 · 健康待确认'
    : '状态待确认';
  if (row.connectivity === 'DISABLED') return '已停用';
  if (row.connectivity === 'OFFLINE') return '离线';
  if (row.health_code === 'BAD') return '设备故障';
  return '设备异常';
}

export function deviceCheckExplanation(row = {}) {
  if (deviceCheckCategory(row) !== 'UNKNOWN') return '';
  if (row.connectivity !== 'ONLINE') return '连接或健康信息不足，需核查设备上报。';
  return row.health_code === 'GOOD'
    ? '已收到在线心跳，状态依据尚不完整或已过期，暂不能确认正常。'
    : '已收到在线心跳，尚缺有效的健康正常依据，暂不能确认正常。';
}

// 保留本次查看中已显示设备的相对位置；只接收本次返回的设备，新设备追加。
// 不缓存设备事实，不让接口的异常优先排序打断正在阅读的卡片或地图弹窗。
export function retainDeviceOrder(rows = [], previous = []) {
  const current = new Map(rows.map(row => [row.device_id, row]));
  const ordered = [];
  for (const row of previous) {
    if (current.has(row.device_id)) {
      ordered.push(current.get(row.device_id));
      current.delete(row.device_id);
    }
  }
  return ordered.concat([...current.values()]);
}

// 附近范围、设备类型与检查结论统一由服务端计算，通知时重新检查并保存快照。
export async function checkPlanDevices(plan, signal) {
  if (signal.aborted) throw new Error('检查已取消');
  const result = await flightApi.deviceCheck(plan.plan_id);
  if (signal.aborted) throw new Error('检查已取消');
  // 检查接口决定附近范围与异常；台账仅补充坐标及展示类型，不另行推断设备故障。
  const rows = await Promise.all((result.rows || []).map(async row => {
    try {
      const detail = await deviceApi.detail(row.device_id);
      const lon = Number(detail.longitude), lat = Number(detail.latitude);
      const valid = detail.coordinate_system === 'WGS-84' && detail.longitude != null && detail.latitude != null
        && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
      const device = detail.device || detail;
      return { ...row, device_type_code: device.device_type_code || row.device_type_code,
        device_type_name: device.device_type_name || row.device_type_name,
        position: valid ? { lon, lat } : null };
    } catch {
      // 位置读取失败不能抹掉已查到的故障，也不能编造点位。
      return { ...row, position: null };
    }
  }));
  if (signal.aborted) throw new Error('检查已取消');
  return { ...result, rows };
}
