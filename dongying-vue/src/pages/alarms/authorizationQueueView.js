// 这里只整理展示优先级，不授予动作权限，也不推进授权状态。
import { stopActionLabel } from '../../components/disposal/emergencyStopView.js';
export const deviceChannel = row => ['LINGYUN_B', 'COUNTERMEASURE_4CH'].includes(row?.channel);
export const usesEmergency = row => deviceChannel(row) && row?.subject_kind === 'UAV_EVENT' && ['COUNTERMEASURE', 'JAMMING'].includes(row.action_type);
export const canStop = row => deviceChannel(row) && row?.allowed_actions?.includes('STOP');
export function cardStopLabel(row) {
  if (!usesEmergency(row)) return '停止处置';
  return stopActionLabel({ authorizations: [row] });
}
export function primaryCode(row, userId) {
  if (!deviceChannel(row)) return '';
  const actions = row?.allowed_actions || [];
  if (row?.status === 'REQUESTED' && row.requested_by !== userId && actions.some(a => ['APPROVE', 'REJECT'].includes(a))) return 'APPROVE';
  if (row?.status === 'APPROVED' && actions.includes('EXECUTE')) return 'EXECUTE';
  return '';
}
export function nextStep(row, userId) {
  if (row.channel === 'MANUAL') return '历史人工执行记录，仅供查阅';
  if (!deviceChannel(row)) return '执行通道未知，请查看详情';
  if (row.execution_block_reason) return '执行受阻，请查看原因';
  const code = primaryCode(row, userId);
  if (code === 'APPROVE') return '这条申请需要你审批';
  if (code === 'EXECUTE') return '等待下发设备执行';
  if (row.status === 'REQUESTED') return row.requested_by === userId ? '等待其他审批人员处理' : '等待审批，当前无需操作';
  if (row.status === 'EXECUTING') return '等待设备反馈';
  if (row.status === 'APPROVED') return '等待有权限的人员执行';
  if (row.status === 'FAILED') return '执行失败，请查看原因';
  if (row.status === 'EXPIRED') return '授权已过期，不能继续执行';
  if (row.status === 'STOPPED') return '';
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(row.status)) return '当前无需操作，可查看记录';
  return '状态未明确，请查看详情';
}
export const resultText = row => ({
  MANUAL_SUCCEEDED: '人工登记执行成功', MANUAL_FAILED: '人工登记执行失败',
  DEVICE_SUCCEEDED: '设备反馈执行成功', DEVICE_FAILED: '设备反馈执行失败',
  DEVICE_TIMED_OUT: '等待设备反馈超时', DEVICE_CANCELLED: '设备指令已取消',
  SUCCEEDED: '执行成功', FAILED: '执行失败', TIMED_OUT: '执行超时', CANCELLED: '已取消'
}[row?.result_code] || '');

// 接口尚无“待我处理”参数。完整读取待审批、已批准状态后再按 allowed_actions 筛选、分页。
// 不截取第一页冒充全部待办；变化、超限或任一页失败均向调用方报错。
export async function readPending(list, scope, userId, isCurrent = () => true) {
  const results = await Promise.allSettled(['REQUESTED', 'APPROVED'].map(async status => {
    const rows = [], size = 100;
    let expected;
    for (let page = 1; page <= 50; page++) {
      if (!isCurrent()) return [];
      const data = await list({ ...scope, status, page, size });
      if (!isCurrent()) return [];
      if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('待办数据不完整，请刷新重试');
      if (expected != null && data.total !== expected) throw new Error('办理记录正在变化，请刷新重新读取待办');
      expected = data.total;
      rows.push(...data.items);
      if (rows.length >= expected) {
        if (rows.length !== expected || new Set(rows.map(row => row.authorization_id)).size !== expected) throw new Error('待办分页记录发生变化，请刷新重试');
        return rows;
      }
      if (!data.items.length) throw new Error('待办数据未读取完整，请刷新重试');
    }
    throw new Error('未结束记录过多，无法完整整理待办，请在全部记录中按状态查看');
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const rows = new Map(results.flatMap(result => result.value).map(row => [row.authorization_id, row]));
  const priority = { EXECUTE: 0, APPROVE: 1 };
  return [...rows.values()].filter(row => primaryCode(row, userId)).sort((a, b) =>
    priority[primaryCode(a, userId)] - priority[primaryCode(b, userId)] ||
    (b.requested_at || 0) - (a.requested_at || 0) || b.authorization_id.localeCompare(a.authorization_id));
}
