// 跟踪回执不等于现场视频流；只有明确模拟回执才开放模拟画面。
export function targetVideoState(targetId, task, command) {
  if (!task) return { message: '当前目标没有光电跟踪任务，暂无可查看画面。', simulated: false };
  if (task.target_id !== targetId) return { message: '跟踪任务与当前目标不一致，已停止显示。', simulated: false };
  if (task.status !== 'OPEN') return { message: task.status === 'ENDING' ? '正在结束光电跟踪。' : '光电跟踪已结束或不可用。', simulated: false };
  if (!command || command.command_id !== task.command_id || command.device_id !== task.device_id) {
    return { message: '尚未取得当前跟踪任务的有效设备回执。', simulated: false };
  }
  if (command.status !== 'SUCCEEDED') return {
    message: ({ QUEUED: '跟踪指令已排队。', SENT: '等待设备确认跟踪指令。', FAILED: '跟踪指令执行失败。', TIMED_OUT: '跟踪设备回执超时。' })[command.status] || '跟踪回执状态未明确。', simulated: false
  };
  return command.simulated === true
    ? { message: '模拟跟踪已确认，可查看演示画面；不反映现场目标。', simulated: true }
    : { message: '设备已确认跟踪，但实时视频流尚未接入。', simulated: false };
}
