/** 平台经纬度契约：只接受明确的 WGS-84，不把缺失值或其他基准当作位置。 */
export function isWgs84(value) {
  return typeof value === 'string' && ['WGS84', 'WGS-84'].includes(value.trim().toUpperCase());
}

function decimal(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    value = Number(text);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function wgs84Position(location) {
  if (!isWgs84(location?.coordinate_system)) return null;
  const lon = decimal(location.longitude), lat = decimal(location.latitude);
  if (lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}
