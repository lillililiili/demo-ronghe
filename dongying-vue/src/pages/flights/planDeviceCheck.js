import { flightApi } from '@/services/flightApi.js';
import { deviceApi } from '@/services/deviceApi.js';

export function deviceCheckStatus(row) {
  if (!row.abnormal && row.incidents?.length) return '时段内有告警';
  if (row.connectivity === 'DISABLED') return '已停用';
  if (row.connectivity === 'OFFLINE') return '离线';
  if (row.health_code === 'BAD') return '设备故障';
  if (row.abnormal) return '设备异常';
  if (row.complete && row.connectivity === 'ONLINE' && row.health_code === 'GOOD') return '正常';
  return '状态未知';
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
