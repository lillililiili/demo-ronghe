const COLORS = { WITHIN: '#2fd06e', OUTSIDE: '#ff4d5e', UNKNOWN: '#ffb020', BOUNDARY: '#ffb020' };
const NOTE_TEXT = [
  ['颜色只表示实测位置与计划走廊的横向关系，不代表合法性；缺失轨迹断开，不补点。', '颜色表示是否偏离计划航线；是否违规请查看合法性研判。'],
  ['已有计划匹配记录，但计划时段内没有可用实测点，计划线保留灰色虚线。', '已找到对应飞机，但这段时间没有可显示的轨迹，地图只显示灰色计划线。'],
  ['实测点都在同一位置，只显示位置点；完全匹配不代表已有整条飞行轨迹，计划线仍为灰色虚线。', '目前只测到同一个位置，无法连成飞行轨迹，所以计划线仍是灰色虚线。'],
  ['缺少轨迹间隔参数，仅显示实测点。', '尚未设置轨迹中断的判断间隔，暂时只显示测到的位置点。'],
  ['空间计算不可用，范围关系未知。', '暂时无法判断是否偏离计划航线。'],
  ['尚未关联感知目标；没有轨迹不代表未起飞', '还没找到对应飞机；没有轨迹不代表没有起飞'],
  ['缺少可见的计划航线版本', '没有可查看的计划航线，暂时无法显示'],
  ['计划时段不完整，不能截取实际轨迹', '计划的开始或结束时间未填全，暂时无法显示这段时间的轨迹'],
  ['未执行或已取消计划不绘制实际对照', '计划还没执行或已经取消，暂时没有实际飞行轨迹可对照']
];
export function trajectoryNoteText(note) {
  return NOTE_TEXT.reduce((text, [original, label]) => text.split(original).join(label), String(note || '暂时没有可显示的飞行轨迹'));
}

export function trustedTrajectoryPoints(data) {
  return (data?.points || []).map(point => {
    const lon = point.longitude, lat = point.latitude;
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)
      || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    return { ...point, lon, lat };
  });
}

export function strokePlanComparison(ctx, map, centerline, points) {
  ctx.save();
  if (centerline?.length) {
    ctx.beginPath(); centerline.forEach(([lon, lat], i) => { const [x, y] = map.px(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = '#8ca0a8'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 6]); ctx.stroke(); ctx.setLineDash([]);
  }
  let previous = null;
  for (const point of points) {
    if (!point) { previous = null; continue; }
    const [x, y] = map.px(point.lon, point.lat);
    if (previous && !point.break_before && point.track_id === previous.track_id && point.point_seq === previous.point_seq + 1) {
      const [px, py] = map.px(previous.lon, previous.lat);
      const relations = [previous.corridor_relation, point.corridor_relation];
      const relation = relations.every(value => value === 'WITHIN') ? 'WITHIN'
        : relations.includes('OUTSIDE') ? 'OUTSIDE' : 'UNKNOWN';
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.lineWidth = 3; ctx.strokeStyle = COLORS[relation]; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = COLORS[point.corridor_relation] || COLORS.UNKNOWN; ctx.fill();
    previous = point;
  }
  ctx.restore();
}
