/* 大屏航迹缓存：有效期内复用（不再请求）；过期或新目标才去拉；已消失的目标从缓存里清掉。 */
const assert = require('node:assert/strict');

(async () => {
  const { reuseCachedTracks, rememberTrack } = await import('../src/services/trackCache.js');
  const cache = new Map();
  const fresh = ids => ids.map(id => ({ targetId: id, track: [] }));
  const pending = targets => targets.filter(target => !target.trackLoaded).map(target => target.targetId);

  const first = reuseCachedTracks(fresh(['a', 'b']), cache, 30_000, 1_000);
  assert.deepEqual(pending(first), ['a', 'b']);
  first.forEach(target => { target.track = [{ lon: 118.5, lat: 37.4 }]; rememberTrack(cache, target, 1_000); });

  const second = reuseCachedTracks(fresh(['a', 'b', 'c']), cache, 30_000, 20_000);
  assert.deepEqual(pending(second), ['c'], '有效期内的 a、b 复用，只拉新目标 c');
  assert.deepEqual(second[0].track, [{ lon: 118.5, lat: 37.4 }]);

  const third = reuseCachedTracks(fresh(['a']), cache, 30_000, 40_000);
  assert.deepEqual(pending(third), ['a'], 'a 过期后重拉');
  assert.deepEqual([...cache.keys()], ['a'], '已消失的 b 从缓存移除');
  console.log('全部通过：大屏航迹缓存');
})().catch(error => { console.error(error); process.exitCode = 1; });
