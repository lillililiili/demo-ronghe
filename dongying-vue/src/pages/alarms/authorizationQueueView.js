// 这里只整理展示优先级，不授予动作权限，也不推进授权状态。
import { stopActionLabel } from '../../components/disposal/emergencyStopView.js';
export const deviceChannel = row => ['LINGYUN_B', 'COUNTERMEASURE_4CH'].includes(row?.channel);
export const usesEmergency = row => deviceChannel(row) && row?.subject_kind === 'UAV_EVENT' && ['COUNTERMEASURE', 'JAMMING'].includes(row.action_type);
export const canStop = row => deviceChannel(row) && row?.allowed_actions?.includes('STOP');
// 待审批的申请可以撤回，已批准还没执行的授权可以撤销（BUG-03）；是否有权由服务端 allowed_actions 决定。
export const canCancel = row => ['REQUESTED', 'APPROVED'].includes(row?.status) && !!row?.allowed_actions?.includes('CANCEL');
export const cancelLabel = row => (row?.status === 'APPROVED' ? '撤销授权' : '撤回申请');
const receiptTimedOut = row => ['ADAPTER_TIMEOUT', 'DEVICE_TIMED_OUT', 'TIMED_OUT'].includes(row?.result_code);
export function executionEvidenceHref(row) {
  if (!deviceChannel(row) || !row.execution_command_id || !row.authorization_id) return '';
  return `#/evidence?${new URLSearchParams({ command: row.execution_command_id, subjectKind: 'AUTHORIZATION', subjectId: row.authorization_id })}`;
}
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
// 已批准、走设备通道、但当前账号不能下发时说清原因（BUG-02：以前只显示“等待有权限的人员执行”，不知道缺什么）。
// 只解释，不放开按钮：按钮仍只看后端 allowed_actions；can 传 hasPermission，口径与后端裁剪 EXECUTE 的条件一致。
export function executeBlockedReason(row, userId, can = () => false) {
  if (!deviceChannel(row) || row?.status !== 'APPROVED' || row.execution_block_reason
    || (row.allowed_actions || []).includes('EXECUTE')) return '';
  if (row.authorization_mode === 'DIRECT') {
    if (row.requested_by !== userId) return '这是免逐次审批的直接反制，只能由发起人本人下发执行。';
    if (!can('disposal:direct')) return '这是免逐次审批的直接反制，当前账号没有直接反制权限，不能下发执行。';
  } else if (!can('disposal:execute')) {
    return '当前账号没有“执行处置”权限，不能下发设备执行；请由处置授权人执行，或请管理员调整角色权限。';
  }
  if (!can('devices.op')) return '下发设备反制还需要设备操作权限，当前账号没有，不能下发执行；请由处置授权人执行，或请管理员调整角色权限。';
  return '';
}
export function nextStep(row, userId) {
  if (row.channel === 'MANUAL') return '历史人工执行记录，仅供查阅';
  if (!deviceChannel(row)) return '执行通道未知，请查看详情';
  if (row.execution_block_reason) return canCancel(row) ? '执行受阻，请查看原因；用不上了可以撤销这条授权，换设备重新申请' : '执行受阻，请查看原因';
  const code = primaryCode(row, userId);
  if (code === 'APPROVE') return '这条申请需要你审批';
  if (code === 'EXECUTE') return '等待下发设备执行';
  if (row.status === 'REQUESTED') return row.requested_by === userId ? '等待其他审批人员处理' : '等待审批，当前无需操作';
  if (row.status === 'EXECUTING') return '等待设备反馈';
  if (row.status === 'APPROVED') return '等待有权限的人员执行';
  if (row.status === 'FAILED') return receiptTimedOut(row) ? '回执超时，实际执行结果待核查' : '执行失败，请查看原因';
  if (row.status === 'EXPIRED') return '授权已过期，不能继续执行';
  if (row.status === 'STOPPED') return '';
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(row.status)) return '当前无需操作，可查看记录';
  return '状态未明确，请查看详情';
}
export const resultText = row => receiptTimedOut(row)
  ? '超时不代表设备未执行；请查看设备反馈并核查实际状态，避免重复下发。' : ({
  MANUAL_SUCCEEDED: '人工登记执行成功', MANUAL_FAILED: '人工登记执行失败',
  DEVICE_SUCCEEDED: '设备反馈执行成功', DEVICE_FAILED: '设备反馈执行失败',
  DEVICE_TIMED_OUT: '等待设备反馈超时', DEVICE_CANCELLED: '设备指令已取消',
  SUCCEEDED: '执行成功', FAILED: '执行失败', TIMED_OUT: '执行超时', CANCELLED: '已取消',
  CANCELLED_BY_REQUESTER: '申请人自己撤回或撤销了这条授权', CANCELLED_BY_APPROVER: '审批人员撤销了这条授权'
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
