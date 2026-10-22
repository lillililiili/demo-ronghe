// Local east/north metre coordinates are used only for editing projection.
// The saved boundary remains WGS84; altitude remains the supplied AMSL value.
const METRES_PER_DEGREE = 6378137 * Math.PI / 180;
const finite = value => typeof value === 'number' && Number.isFinite(value);
export const validPoint = point => Array.isArray(point) && finite(point[0]) && finite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

export function editableSeaLevelBounds(version) {
  return version?.altitude_datum === 'AMSL'
    ? { lower: version.min_altitude_m ?? null, upper: version.max_altitude_m ?? null }
    : { lower: null, upper: null };
}

export function openBoundary(boundary) {
  const parts = boundary?.type === 'Polygon' ? [boundary.coordinates] : boundary?.coordinates;
  if (!Array.isArray(parts) || !parts.length) return [[[]]];
  return parts.map(part => part.map(ring => {
    const points = ring.map(point => point.slice(0, 2));
    if (points.length > 1 && same(points[0], points.at(-1))) points.pop();
    return points;
  }));
}

export function closeBoundary(polygons) {
  return { type: 'MultiPolygon', coordinates: polygons.map(part => part.map(ring => {
    const points = ring.map(point => [...point]);
    return points.length ? [...points, [...points[0]]] : [];
  })) };
}

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) < 1e-14 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function intersects(a, b, c, d) {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
export function validateVolume(polygons, lower, upper) {
  if (!finite(lower) || !finite(upper)) return '请填写海拔下限和海拔上限（米）。';
  if (upper <= lower) return '海拔上限必须高于海拔下限。';
  if ([lower, upper].some(value => Math.abs(value) > 99999999.99)) return '海拔高度超出可保存范围（绝对值不能超过 99999999.99 米）。';
  if ([lower, upper].some(value => Number(value.toFixed(2)) !== value)) return '海拔高度最多保留两位小数。';
  if (!polygons?.length) return '请添加空域边界。';
  for (const part of polygons) {
    if (!part.length) return '请添加空域边界。';
    for (const ring of part) {
      if (ring.length < 3) return '每条边界至少需要三个经纬度点。';
      if (ring.some(point => !validPoint(point))) return '经纬度未填完整或超出范围（经度 ±180°，纬度 ±90°）。';
      if (new Set(ring.map(point => point.join(','))).size !== ring.length) return '边界点不能重复，首尾会自动闭合。';
      for (let i = 0; i < ring.length; i++) for (let j = i + 2; j < ring.length; j++) {
        if (i === 0 && j === ring.length - 1) continue;
        if (intersects(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) return '边界不能自相交，请调整交叉的边界点。';
      }
      const area = ring.reduce((sum, point, i) => sum + cross(ring[0], point, ring[(i + 1) % ring.length]), 0);
      if (Math.abs(area) < 1e-14) return '边界点不能全部在同一直线上。';
    }
  }
  return '';
}

export function makeFrame(polygons, lower, upper) {
  const points = polygons.flat(2).filter(validPoint);
  const longitudes = points.map(point => point[0]), latitudes = points.map(point => point[1]);
  const lon = points.length ? (Math.min(...longitudes) + Math.max(...longitudes)) / 2 : 0;
  const lat = points.length ? (Math.min(...latitudes) + Math.max(...latitudes)) / 2 : 0;
  const mx = METRES_PER_DEGREE * Math.max(1e-6, Math.cos(lat * Math.PI / 180));
  const altitude = finite(lower) && finite(upper) ? (lower + upper) / 2 : 0;
  const width = points.length ? (Math.max(...longitudes) - Math.min(...longitudes)) * mx : 0;
  const depth = points.length ? (Math.max(...latitudes) - Math.min(...latitudes)) * METRES_PER_DEGREE : 0;
  const height = finite(lower) && finite(upper) ? Math.abs(upper - lower) : 0;
  const extent = Math.max(width, depth, height, points.length < 2 ? 500 : 1);
  return { lon, lat, mx, my: METRES_PER_DEGREE, altitude, extent, scale: 330 / extent };
}

export function project(point, altitude, frame, camera) {
  const x = (point[0] - frame.lon) * frame.mx, y = (point[1] - frame.lat) * frame.my, z = altitude - frame.altitude;
  const xr = x * Math.cos(camera.yaw) - y * Math.sin(camera.yaw);
  const yr = x * Math.sin(camera.yaw) + y * Math.cos(camera.yaw);
  const scale = frame.scale * camera.zoom;
  return { x: 400 + xr * scale, y: 260 - (yr * Math.sin(camera.pitch) + z * Math.cos(camera.pitch)) * scale,
    depth: yr * Math.cos(camera.pitch) - z * Math.sin(camera.pitch) };
}

export function unproject(screen, altitude, frame, camera) {
  const scale = frame.scale * camera.zoom;
  const xr = (screen.x - 400) / scale;
  const yr = ((260 - screen.y) / scale - (altitude - frame.altitude) * Math.cos(camera.pitch)) / Math.sin(camera.pitch);
  const x = xr * Math.cos(camera.yaw) + yr * Math.sin(camera.yaw);
  const y = -xr * Math.sin(camera.yaw) + yr * Math.cos(camera.yaw);
  return [frame.lon + x / frame.mx, frame.lat + y / frame.my];
}

export function heightFromDrag(altitude, screenDeltaY, frame, camera) {
  return altitude - screenDeltaY / (frame.scale * camera.zoom * Math.cos(camera.pitch));
}
