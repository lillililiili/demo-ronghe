export function objectSnapshot(risk) {
  if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk?.risk_type)) return null;
  const fact = risk.space_fact;
  if (fact?.longitude == null || fact?.latitude == null) return null;
  const lon = Number(fact.longitude), lat = Number(fact.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85) return null;
  return { lon, lat, riskId: risk.risk_id };
}

export function drawObjectRisk(ctx, map, { snapshot, route, corridorWidth, color }) {
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
  ctx.restore();
}
