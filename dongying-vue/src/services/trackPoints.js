/** 保留观测身份和断点；过滤坏坐标时不能把两侧的点重新接起来。 */
export function measuredMapPoints(rows = []) {
  const points = [];
  let interrupted = true;
  for (const row of rows) {
    const location = row?.location || row;
    const lon = location?.longitude, lat = location?.latitude;
    const trusted = typeof lon === 'number' && typeof lat === 'number'
      && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
      && (!row?.location || location.coordinate_system === 'WGS84')
      && !row?.field_issues?.some(issue => issue.field === 'location');
    if (!trusted) { interrupted = true; continue; }
    points.push({
      lon, lat, point_id: row.point_id, track_id: row.track_id, point_seq: row.point_seq,
      t: row.observed_at ?? row.sort_time ?? null,
      alt: row.altitude_amsl_m ?? null,
      kind: String(row.point_kind || row.kind || 'MEAS').toLowerCase(),
      corridor_relation: row.corridor_relation || 'UNKNOWN',
      break_before: interrupted || row.break_before === true
    });
    interrupted = false;
  }
  return points;
}

/** 只用同一观测点的后台比对结果着色；新点、其他轨迹或时间不符都保持未知。 */
export function applyTrackComparison(points, comparison) {
  const facts = new Map((comparison?.points || []).map(point => [point.point_id, point]));
  return points.map(point => {
    const fact = facts.get(point.point_id);
    if (!fact || fact.track_id !== point.track_id || fact.observed_at !== point.t
      || fact.longitude !== point.lon || fact.latitude !== point.lat) return point;
    return { ...point, corridor_relation: fact.corridor_relation,
      break_before: point.break_before || fact.break_before };
  });
}
