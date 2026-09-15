// 只画接口保存的 WGS-84 区域，不以航线或行政区推算气象边界。
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

function polygonPath(ctx, pixels) {
  ctx.beginPath();
  pixels.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
}

const WEATHER_PALETTES = {
  wind: [[44, 89, 181], [39, 152, 197], [41, 184, 160], [115, 197, 103], [225, 211, 77], [238, 151, 57], [213, 78, 66]],
  storm: [[36, 157, 128], [63, 193, 87], [175, 218, 67], [250, 216, 58], [249, 140, 42], [225, 54, 66], [171, 43, 104]],
  visibility: [[165, 184, 208], [139, 164, 203], [115, 135, 188], [127, 111, 178], [150, 89, 160]]
};
export const weatherLayerKind = reason => reason === 'WEATHER_STRONG_WIND' ? 'wind' : reason === 'WEATHER_THUNDERSTORM' ? 'storm' : 'visibility';
export const weatherLayerGradient = kind => `linear-gradient(90deg, ${WEATHER_PALETTES[kind].map(c => `rgb(${c.join(',')})`).join(',')})`;
const clamp = n => Math.max(0, Math.min(1, n));
const fract = n => n - Math.floor(n);
const textures = new WeakMap();

function edgeDistance(x, y, ring) {
  let min = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
    min = Math.min(min, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return min;
}

// 专属 mock 来源的视觉纹理。仅表达示意强弱，不生成测量值、阈值或新的风险事实。
function simulatedTexture(fact, ring, kind) {
  const cached = textures.get(fact);
  if (cached?.kind === kind) return cached;
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [west, south, east, north] = bounds;
  const normalized = ring.map(([x, y]) => [(x - west) / (east - west), (north - y) / (north - south)]);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 192;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(192, 192);
  const palette = WEATHER_PALETTES[kind];
  const blob = (x, y, cx, cy, sx, sy) => Math.exp(-((x - cx) ** 2 / sx + (y - cy) ** 2 / sy));
  for (let row = 0; row < 192; row++) for (let col = 0; col < 192; col++) {
    const x = col / 191, y = row / 191;
    if (!insideWeather([x, y], normalized)) continue;
    const edge = clamp(edgeDistance(x, y, normalized) / .12);
    const wave = Math.sin(x * 9 + Math.sin(y * 6) * 1.8);
    let strength = .30 + .38 * blob(x, y, .62, .40, .09, .32) + .14 * wave;
    if (kind === 'storm') strength = .90 * blob(x, y, .63, .38, .025, .065)
      + .63 * blob(x, y, .36, .64, .03, .028) + .42 * blob(x, y, .43, .33, .04, .035)
      + .06 * Math.sin(x * 48 + y * 32) * Math.sin(y * 43);
    if (kind === 'visibility') strength = .24 + .49 * blob(x, y, .56, .48, .16, .08) + .09 * wave;
    const value = clamp(strength) * (palette.length - 1), index = Math.min(palette.length - 2, Math.floor(value));
    const ratio = value - index, offset = (row * 192 + col) * 4;
    for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] = palette[index][channel] * (1 - ratio) + palette[index + 1][channel] * ratio;
    pixels.data[offset + 3] = 210 * edge * (kind === 'storm' ? clamp(strength * 5) : .87);
  }
  context.putImageData(pixels, 0, 0);
  const result = { canvas, bounds, kind };
  textures.set(fact, result);
  return result;
}

function drawWindParticles(ctx, map, fact, bounds) {
  if (!Number.isFinite(fact.wind_from_degrees)) return;
  const [west, south, east, north] = bounds;
  const angle = (fact.wind_from_degrees + 180) * Math.PI / 180;
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const time = map._still?.() ? 0 : performance.now() / 18000;
  // 地理坐标锚定：拖动、缩放时与气象纹理一起移动，不在屏幕上铺固定箭头。
  const position = (i, phase) => {
    const seed = fract(Math.sin(i * 127.1 + 3.7) * 43758.5453);
    const cross = fract(Math.sin(i * 311.7 + 9.2) * 96321.912);
    const x = fract(seed + dx * phase), y = fract(cross + dy * phase);
    const bend = .018 * Math.sin(x * 7 + y * 5);
    return map.px(west + (x - dy * bend) * (east - west), north - (y + dx * bend) * (north - south));
  };
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < 240; i++) {
    const phase = time * (.6 + fract(i * .618) * .5);
    let previous = position(i, phase - .024);
    for (let step = 1; step <= 5; step++) {
      const next = position(i, phase - .024 + step * .0048);
      if (Math.hypot(next[0] - previous[0], next[1] - previous[1]) < 30) {
        ctx.strokeStyle = `rgba(255,255,255,${.08 + step * .11})`;
        ctx.beginPath(); ctx.moveTo(...previous); ctx.lineTo(...next); ctx.stroke();
      }
      previous = next;
    }
  }
}

export function drawWeatherArea(ctx, map, fact, ring, route, color, kind, simulated, boundaryVisible) {
  const pixels = ring.map(p => map.px(...p));
  ctx.save();
  polygonPath(ctx, pixels);
  if (boundaryVisible || !simulated) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.save();
  ctx.clip();
  if (simulated) {
    const texture = simulatedTexture(fact, ring, kind);
    const [west, south, east, north] = texture.bounds;
    const topLeft = map.px(west, north), bottomRight = map.px(east, south);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(texture.canvas, topLeft[0], topLeft[1], bottomRight[0] - topLeft[0], bottomRight[1] - topLeft[1]);
    if (kind === 'wind') drawWindParticles(ctx, map, fact, texture.bounds);
  } else {
    ctx.fillStyle = color; ctx.globalAlpha = .19; ctx.fill(); ctx.globalAlpha = 1;
  }
  // 紫色外圈只表示平面交集，不代替飞行时段、高度或合法性判定。
  if (route?.length) {
    ctx.beginPath();
    route.forEach((p, i) => { const [x, y] = map.px(...p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 11;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}
