// 播放资格来自目标视频只读接口；前端额外隔离错目标与不完整响应。
export function targetVideoState(targetId, video) {
  if (!video) return { message: '尚未读取当前目标的视频状态。', simulated: false };
  if (video.target_id !== targetId) return { message: '视频与当前目标不一致，已停止显示。', simulated: false };
  const simulated = video.status === 'AVAILABLE' && video.playback_type === 'SIMULATED_CANVAS'
    && video.simulated === true && !!video.task_id && !!video.device_id;
  return { message: video.reason || '视频状态尚未明确，暂无可查看画面。', simulated };
}
