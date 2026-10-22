// HLS UTC follows currentTime; the compositor can be presenting another sample.
export function hlsFrameTimestamp(playingAt, currentTime, mediaTime) {
  if (![playingAt, currentTime, mediaTime].every(Number.isFinite) || currentTime < 0 || mediaTime < 0) return null;
  return Math.round(playingAt + (mediaTime - currentTime) * 1000);
}
