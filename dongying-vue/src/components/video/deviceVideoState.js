// 设备画面与告警选择独立；原始流无需伪造目标或跟踪任务。
export function deviceVideoState(deviceId, video) {
  const matched = !!deviceId && video?.device_id === deviceId;
  const kind = matched && video.stream_kind;
  const validKind = kind === 'RAW' && video.status === 'RAW'
    || kind === 'AI' && video.status === 'AI' && !!video.task_id && !!video.target_id;
  return {
    playable: !!(matched && validKind && video.playback_type === 'HLS' && video.stream_id && video.playback_url),
    simulated: matched && video.simulated === true,
    message: matched ? video.reason || '视频源尚未就绪' : '当前设备的视频状态尚未取得'
  };
}

export function matchingVideoFrame(video, metadata, playingAt, maxDeltaMs = 500) {
  if (video?.status !== 'AI' || video.stream_kind !== 'AI' || !Number.isFinite(playingAt)
    || !metadata || metadata.device_id !== video.device_id || metadata.stream_id !== video.stream_id
    || metadata.task_id !== video.task_id || metadata.status === 'NONE') return null;
  const frames = metadata.frames || [];
  let nearest = null, distance = maxDeltaMs + 1;
  for (const frame of frames) {
    const at = typeof frame.frame_timestamp === 'number' ? frame.frame_timestamp : Date.parse(frame.frame_timestamp);
    const gap = Math.abs(at - playingAt);
    if (Number.isFinite(gap) && gap < distance) { nearest = frame; distance = gap; }
  }
  return distance <= maxDeltaMs ? nearest : null;
}

export function validDetectionBox(b) {
  return !!b && ['x', 'y', 'width', 'height'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k]))
    && b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0 && b.x + b.width <= 1 && b.y + b.height <= 1;
}
export function selectableDetection(detection) {
  return !!detection?.target_id && detection.association_status === 'LINKED'
    && detection.class_code === 'UAV' && validDetectionBox(detection.bbox);
}

export function detectionPresentation(candidate) {
  return candidate
    ? { label: `告警 · ${candidate.label}`, alert: true }
    : { label: '未关联告警', alert: false };
}

export function containedVideoRect(width, height, videoWidth, videoHeight) {
  if (![width, height, videoWidth, videoHeight].every(n => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  return { x: (width - videoWidth * scale) / 2, y: (height - videoHeight * scale) / 2,
    width: videoWidth * scale, height: videoHeight * scale };
}
