// 图标仅是气象范围的入口，不代表气象观测点或影响全部高度。
export function isSimulatedWeatherRisk(row) {
  const mode = row?.source_mode || row?.sourceMode;
  const source = row?.source_code || row?.sourceCode;
  const reason = row?.reason_code || row?.reasonCode;
  return mode === 'mock' && ['WEATHER-DEMO', 'QA_WEATHER_RISK_INPUT'].includes(source)
    && ['WEATHER_STRONG_WIND', 'WEATHER_THUNDERSTORM', 'WEATHER_LOW_VISIBILITY'].includes(reason);
}

export function weatherPolygon(fact) {
  const ring = fact?.polygon;
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 10000) return null;
  if (!ring.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85.051129)) return null;
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  const area = ring.slice(1).reduce((sum, p, i) => sum + (ring[i][0] - first[0]) * (p[1] - first[1])
    - (p[0] - first[0]) * (ring[i][1] - first[1]), 0);
  return Math.abs(area) > 1e-14 ? ring : null;
}

export function insideWeather(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function weatherAnchor(fact) {
  const ring = weatherPolygon(fact);
  if (!ring) return null;
  const ys = ring.map(p => p[1]);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const crossings = [];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if ((a[1] > y) !== (b[1] > y)) crossings.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
  }
  crossings.sort((a, b) => a - b);
  let point = null, width = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    if (crossings[i + 1] - crossings[i] > width) {
      width = crossings[i + 1] - crossings[i];
      point = [(crossings[i] + crossings[i + 1]) / 2, y];
    }
  }
  return point;
}
