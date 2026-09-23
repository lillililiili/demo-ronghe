export function objectSnapshot(risk) {
  if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk?.risk_type)) return null;
  const fact = risk.space_fact;
  if (fact?.longitude == null || fact?.latitude == null) return null;
  const lon = Number(fact.longitude), lat = Number(fact.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85) return null;
  return { lon, lat, riskId: risk.risk_id };
}

export function objectTrackPoints(target) {
  return (target?.track || []).filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat)
    && Math.abs(p.lon) <= 180 && Math.abs(p.lat) <= 85 && p.t != null && Number.isFinite(Number(p.t)))
    .map(p => ({ ...p, t: Number(p.t) })).sort((a, b) => a.t - b.t);
}

export function drawObjectRisk(ctx, map, { snapshot, trail, trailIndex, showTrail, heatPoints, showHeat, route, corridorWidth, color }) {
  ctx.save();
  if (route?.length && Number.isFinite(corridorWidth) && corridorWidth > 0) {
    const [lon, lat] = route[0];
    const origin = map.px(lon, lat);
    const offset = map.px(lon + corridorWidth / (111320 * Math.cos(lat * Math.PI / 180)), lat);
    ctx.beginPath();
    route.forEach((p, i) => { const q = map.px(...p); i ? ctx.lineTo(...q) : ctx.moveTo(...q); });
    ctx.strokeStyle = 'rgba(43,163,190,.17)'; ctx.lineWidth = Math.hypot(offset[0] - origin[0], offset[1] - origin[1]);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }
  if (showHeat) for (const point of heatPoints) {
    const [x, y] = map.px(point.lon, point.lat);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, 38);
    gradient.addColorStop(0, 'rgba(241,80,67,.35)'); gradient.addColorStop(.3, 'rgba(255,175,55,.24)'); gradient.addColorStop(1, 'rgba(255,208,95,0)');
    ctx.fillStyle = gradient; ctx.fillRect(x - 38, y - 38, 76, 76);
  }
  if (snapshot && route?.length > 1) {
    const point = map.px(snapshot.lon, snapshot.lat);
    let nearest, distance = Infinity;
    for (let i = 1; i < route.length; i++) {
      const a = map.px(...route[i - 1]), b = map.px(...route[i]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const p = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(p[0] - point[0], p[1] - point[1]);
      if (d < distance) { distance = d; nearest = p; }
    }
    if (distance > 12) {
      ctx.beginPath(); ctx.moveTo(...point); ctx.lineTo(...nearest); ctx.setLineDash([3, 4]);
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  if (showTrail && trail.length > 1) {
    const end = Math.min(trailIndex, trail.length - 1);
    for (let i = 1; i <= end; i++) {
      // 缺少连续采样时断开，不把两个远隔时刻连成实际飞行轨迹。
      if (trail[i].t - trail[i - 1].t > 30000 || trail[i].t <= trail[i - 1].t) continue;
      if (trail[i].break_before) continue;
      if (trail[i].track_id && trail[i - 1].track_id && trail[i].track_id !== trail[i - 1].track_id) continue;
      if (Number.isFinite(trail[i].point_seq) && Number.isFinite(trail[i - 1].point_seq)
        && trail[i].point_seq !== trail[i - 1].point_seq + 1) continue;
      const a = map.px(trail[i - 1].lon, trail[i - 1].lat), b = map.px(trail[i].lon, trail[i].lat);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.strokeStyle = '#bd55e4';
      ctx.globalAlpha = .3 + .7 * i / Math.max(end, 1); ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const current = trail[end], at = map.px(current.lon, current.lat);
    ctx.beginPath(); ctx.arc(...at, 5, 0, Math.PI * 2); ctx.fillStyle = '#bd55e4'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.restore();
}
