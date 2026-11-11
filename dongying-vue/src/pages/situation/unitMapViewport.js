// Only already-authorized device positions determine the unit's initial view.
// The surrounding margin is a viewport, never a claimed sensor coverage area.
export function unitMapViewport(user, snapshot, coverageBounds) {
  if (!user || user.user_type !== 'FRONTEND') return { ready: false, focus: null, notice: '' };
  if (!user.org_id) return { ready: true, focus: null, notice: '账号未关联单位，暂不能定位单位区域' };
  if (snapshot.deniedSegments?.includes('devices')) return { ready: true, focus: null, notice: '没有设备查看权限，暂不能自动定位单位区域' };
  if (snapshot.failedSegments?.includes('devices')) return { ready: false, focus: null, notice: '单位设备位置读取失败，恢复后可重新定位' };
  if (!snapshot.deviceUpdatedAt) return { ready: false, focus: null, notice: '' };
  const located = (snapshot.devices || []).filter(row => row.posValid === true
    && Number.isFinite(row.lon) && Number.isFinite(row.lat) && Math.abs(row.lon) <= 180 && Math.abs(row.lat) <= 90);
  if (!located.length) return { ready: true, focus: null, notice: '本单位暂无可定位设备，当前显示默认底图' };
  if (!Array.isArray(coverageBounds) || coverageBounds.length !== 4) return { ready: false, focus: null, notice: '' };
  const [west, south, east, north] = coverageBounds;
  const points = located.filter(p => p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north);
  if (!points.length) return { ready: true, focus: null, notice: '本单位设备不在当前底图覆盖区，当前显示默认底图' };
  const lons = points.map(p => p.lon), lats = points.map(p => p.lat);
  const middleLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const latMargin = 1000 / 111320, lonMargin = latMargin / Math.max(.1, Math.cos(middleLat * Math.PI / 180));
  return {
    ready: true,
    focus: { kind: 'fit', padding: .2, coordinates: [
      [Math.max(west, Math.min(...lons) - lonMargin), Math.max(south, Math.min(...lats) - latMargin)],
      [Math.min(east, Math.max(...lons) + lonMargin), Math.min(north, Math.max(...lats) + latMargin)]
    ] },
    notice: points.length < located.length ? '已定位本单位设备区域，部分设备超出当前底图覆盖区' : '本单位设备区域'
  };
}
