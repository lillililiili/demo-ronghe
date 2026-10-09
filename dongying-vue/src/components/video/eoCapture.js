/* 光电跟踪画面取证的纯函数：录像格式、文件名、计时和结果文案。浏览器媒体接口留在组件里。 */

/** 单段录像最长 1 分钟；码率按 2.5 Mbps 封顶，一段约 19 MB，低于证据单文件 32 MiB 上限。 */
export const MAX_RECORDING_MS = 60_000;
export const RECORDING_BITS_PER_SECOND = 2_500_000;

/* 平台证据只收 WEBM、MP4 录像；按浏览器支持程度依次尝试。 */
const RECORDING_FORMATS = [
  { mimeType: 'video/webm;codecs=vp9', type: 'video/webm', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', type: 'video/webm', extension: 'webm' },
  { mimeType: 'video/webm', type: 'video/webm', extension: 'webm' },
  { mimeType: 'video/mp4', type: 'video/mp4', extension: 'mp4' }
];

/** 浏览器能录、平台也收的第一种格式；都不支持时返回 null。 */
export function recordingFormat(isTypeSupported) {
  return recordingFormats(isTypeSupported)[0] || null;
}

/** 能声明支持不代表编码器一定能启动；保留其余格式供启动失败时回退。 */
export function recordingFormats(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return [];
  return RECORDING_FORMATS.filter(item => {
    try { return isTypeSupported(item.mimeType) === true; } catch { return false; }
  });
}

const pad = value => String(value).padStart(2, '0');

/** 文件名只用字母、数字和连字符，取证时刻按本机时间，便于值班人员辨认。 */
export function captureFileName(kindCode, at, extension) {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${kindCode === 'EO_VIDEO' ? 'eo-video' : 'eo-still'}-${stamp}.${extension}`;
}

export function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** 点击截图或录像时说明不能取证的原因（按钮旁不常驻解释）；可以取证时返回空串。 */
export function captureBlocked({ permitted, playing, recordable, kindCode }) {
  const video = kindCode === 'EO_VIDEO';
  if (!permitted) return '当前账号没有截图、录像取证的权限。';
  if (video && !recordable) return '当前浏览器不支持录像，可以先截图取证。';
  if (!playing) return video ? '视频播放时才能录像，请先播放视频。' : '视频播放时才能截图，请先播放视频。';
  return '';
}

/** 保存成功后的提示：证据编号和实际关联到了什么，以服务端返回为准。 */
export function captureSavedText(file, kindCode, simulated = false) {
  const what = kindCode === 'EO_VIDEO' ? '录像' : '截图';
  const no = file?.evidence_no ? ` ${file.evidence_no}` : '';
  const kinds = (file?.links || []).map(link => link.subject_kind);
  const linked = kinds.includes('EVENT') ? '，已关联目标和告警' : kinds.includes('TARGET') ? '，已关联目标' : '';
  return `${what}已存为证据${no}${linked}${simulated ? '（测试视频画面，非现场）' : ''}。`;
}

/**
 * 保存失败时的提示。结果未知（超时、断网、409）时允许按原文件、原幂等键重新提交，不会重复入库；
 * 重复提交被服务端识别为已保存时，直接说明已经保存过。
 */
export function captureFailure(error, uncertain) {
  if (error?.code === 'IDEMPOTENCY_REPLAY') {
    return { text: '这份取证之前已经保存成功，不会重复入库，请到证据台账查看。', retry: false };
  }
  if (uncertain) {
    return { text: `保存结果未确认：${error?.message || '没有收到明确结果'} 可以按原文件重新提交，不会重复入库。`, retry: true };
  }
  if (error?.status === 403) return { text: '当前账号没有截图、录像取证的权限。', retry: false };
  return { text: error?.message || '取证保存失败，请稍后重试。', retry: false };
}

/** 视频已关闭或换了目标后才返回的结果，用全局提示告知；结果未知时引导去台账核对，不再提供重试。 */
export function captureBackgroundText(kindCode, outcome) {
  const what = kindCode === 'EO_VIDEO' ? '录像' : '截图';
  if (outcome.retry) return `${what}取证的保存结果未确认，请到证据台账查看是否已保存。`;
  return outcome.text;
}
