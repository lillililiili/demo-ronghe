import { strokePlannedRoute } from './positionMap.js';

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
    strokePlannedRoute(ctx, map, centerline, { color: '#8ca0a8', arrows: false });
  }
  window.MapView.strokeObservedTrack(ctx, (lon, lat) => map.px(lon, lat), points);
  ctx.restore();
}
