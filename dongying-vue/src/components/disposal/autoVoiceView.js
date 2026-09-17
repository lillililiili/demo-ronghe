export const AUTO_VOICE_STATUS = {
  DISABLED: '电话录音通知未启用', WAITING: '等待自动拨打', CALLING: '系统正在拨打',
  SIMULATED_PLAYED: '模拟接通并播放完成', FAILED: '电话通知失败，需人工处理',
  UNAVAILABLE: '电话录音通知暂不可用', BLOCKED: '自动电话通知已暂停', UNKNOWN: '通话结果未确认'
};

export function autoVoiceView(data) {
  const voice = data?.auto_voice;
  if (!voice) return {
    title: '电话录音通知状态暂不可用', reason: '当前服务未提供电话通知状态。', tone: 'muted', canRetry: false
  };
  const latest = [...(data.records || [])].filter(row => row.kind === 'VOICE_SIMULATED')
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
  const recipientSnapshot = latest ? latest.recipient_snapshot : voice.recipient_snapshot;
  return {
    title: AUTO_VOICE_STATUS[voice.status] || '通话结果未确认', reason: voice.reason || '',
    tone: voice.status === 'SIMULATED_PLAYED' ? 'success'
      : ['FAILED', 'UNAVAILABLE', 'BLOCKED', 'UNKNOWN'].includes(voice.status) ? 'warning' : 'muted',
    // 结果未知不能通过重拨猜测，后端允许且结果明确失败时才开放重试。
    canRetry: voice.can_retry === true && ['FAILED', 'UNAVAILABLE', 'BLOCKED'].includes(voice.status),
    simulated: data.voice_mode === 'SIMULATED' || voice.status === 'SIMULATED_PLAYED',
    recipient: latest ? latest.recipient_name || recipientSnapshot?.recipient_name : recipientSnapshot ? recipientSnapshot.recipient_name : Number(voice.attempt_count) > 0 ? undefined : data.recipient?.name,
    recipientHint: recipientSnapshot?.contact_hint,
    recordingName: voice.recording_name, triggeredAt: voice.triggered_at, updatedAt: voice.updated_at,
    answeredAt: voice.answered_at, playbackCompletedAt: voice.playback_completed_at,
    source: voice.trigger_source, evaluatedAt: voice.evaluated_at, dataUpdatedAt: voice.data_updated_at
  };
}
