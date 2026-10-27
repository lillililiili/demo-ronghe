// HLS UTC can refer to a different sample than the video compositor presents.
export function hlsFrameTimestamp(playingAt, currentTime, mediaTime, fragments) {
  if (![playingAt, currentTime, mediaTime].every(Number.isFinite) || currentTime < 0 || mediaTime < 0) return null;
  if (Array.isArray(fragments)) {
    const fragment = fragments
      .filter(item => Number.isFinite(item?.start) && Number.isFinite(item?.duration)
        && Number.isFinite(item?.programDateTime) && item.duration > 0
        && mediaTime >= item.start && mediaTime < item.start + item.duration)
      .sort((a, b) => b.start - a.start)[0];
    return fragment ? Math.round(fragment.programDateTime + (mediaTime - fragment.start) * 1000) : null;
  }
  return Math.round(playingAt + (mediaTime - currentTime) * 1000);
}
