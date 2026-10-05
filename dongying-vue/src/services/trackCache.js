/* 地图航迹缓存（纯函数，便于 node 单测）。cache 是 Map，targetId -> { track, at }，由调用方持有。
   maxAgeMs 内拉过的航迹直接复用；本次已不在目标列表里的从缓存移除。 */
export function reuseCachedTracks(targets, cache, maxAgeMs, now = Date.now()) {
  const alive = new Set();
  for (const target of targets || []) {
    if (!target || !target.targetId) continue;
    alive.add(target.targetId);
    const hit = cache.get(target.targetId);
    if (hit && now - hit.at < maxAgeMs) {
      target.track = hit.track;
      target.trackLoaded = true;
    }
  }
  for (const id of [...cache.keys()]) if (!alive.has(id)) cache.delete(id);
  return targets;
}

export function rememberTrack(cache, target, now = Date.now()) {
  if (cache && target && target.targetId) cache.set(target.targetId, { track: target.track || [], at: now });
}
