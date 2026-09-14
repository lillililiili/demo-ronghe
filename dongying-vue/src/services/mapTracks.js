/* 给地图目标补上轨迹点。situationData.js 保持纯函数（node 单测直接 import），
   取数放这里：读 /targets/{id}/tracks 最新一条的点，再交给 toTrack。 */
import { targetApi } from './targetApi.js';
import { toTrack } from './situationData.js';

const BATCH = 6;

export function copyTracks(fromTargets, toTargets) {
  const previous = new Map();
  for (const target of fromTargets || []) {
    if (target && target.targetId && target.trackLoaded)
      previous.set(target.targetId, { track: target.track || [], trackLoaded: true });
  }
  for (const target of toTargets || []) {
    const prev = target && previous.get(target.targetId);
    if (!prev) continue;
    target.track = prev.track;
    target.trackLoaded = true;
  }
  return toTargets;
}

export async function fetchTrackPoints(targetId) {
  const tracks = await targetApi.tracks(targetId, { page: 1, size: 1 });
  const track = tracks && tracks.items && tracks.items[0];
  if (!track) return [];
  const page = await targetApi.pointsAll(track.track_id, { size: 100 });
  return toTrack(page.items || []);
}

export async function attachTracks(targets, { max = 40 } = {}) {
  const pending = (targets || []).filter(target =>
    target && target.targetId && target.posValid !== false && !target.trackLoaded).slice(0, max);
  for (let i = 0; i < pending.length; i += BATCH) {
    await Promise.all(pending.slice(i, i + BATCH).map(async target => {
      try { target.track = await fetchTrackPoints(target.targetId); }
      catch { target.track = target.track || []; }
      target.trackLoaded = true;
    }));
  }
  return targets;
}
