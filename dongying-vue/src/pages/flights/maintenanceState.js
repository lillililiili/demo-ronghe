/* 设备处置单状态的中文说法；不依赖接口模块，列表“需要处理”提示和详情栏共用。 */
export function maintenanceState(task) {
  return task?.workflow_state || (task?.status === 'HANDLED' ? 'LEGACY_HANDLED' : task?.status);
}
export function maintenanceStateLabel(task) {
  return ({ PENDING: '待处理', PROCESSING: '处理中', READY_TO_COMPLETE: '待确认办结',
    PENDING_VERIFICATION: '系统核验中', COMPLETED: '已办结', LEGACY_HANDLED: '历史已反馈' })[maintenanceState(task)] || '状态待确认';
}
