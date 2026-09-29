// 跟踪确认与视频可用是两项独立事实；缺失字段一律不启动播放器。
export function targetVideoState(targetId, video) {
  const unavailable = message => ({ message, playable: false, simulated: false });
  if (!video) return unavailable('尚未读取当前目标的视频状态。');
  if (video.target_id !== targetId) return unavailable('视频与当前目标不一致，已停止显示。');
  const labels = { NOT_CONFIGURED: '视频源未接入', WAITING: '等待视频源就绪', AVAILABLE: '视频源已就绪', INTERRUPTED: '视频已中断' };
  const playable = video.status === 'TRACKING' && video.video_status === 'AVAILABLE'
    && video.playback_type === 'HLS' && !!video.task_id && !!video.device_id && !!video.stream_id && !!video.playback_url;
  return { message: video.reason || labels[video.video_status] || '视频状态未确认', playable,
    simulated: video.simulated === true || ['mock', 'replay'].includes(video.source_mode) };
}
