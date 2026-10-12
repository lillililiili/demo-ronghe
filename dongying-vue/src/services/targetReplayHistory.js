/** 融合轨迹可能因断报分段。回放读取全部已留存分段，段间不补线。 */
export async function targetReplayHistory(api, targetId) {
  const tracks = (await api.tracksAll(targetId)).items.filter(row => row.layer === 'FUSED');
  const points = [];
  for (const track of tracks) {
    const page = await api.pointsAll(track.track_id);
    points.push(...page.items.map(point => ({ ...point, track_id: track.track_id })));
    if (points.length > 50000) throw new Error('历史轨迹超过五万点，请缩小查询时段后回放');
  }
  points.sort((a,b) => (a.observed_at ?? a.sort_time ?? Infinity) - (b.observed_at ?? b.sort_time ?? Infinity)
    || String(a.track_id).localeCompare(String(b.track_id)) || Number(a.point_seq || 0) - Number(b.point_seq || 0));
  return points.map((point, index) => ({ ...point,
    break_before: point.break_before === true || index === 0 || point.track_id !== points[index - 1].track_id }));
}
