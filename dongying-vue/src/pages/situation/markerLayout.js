// 只移动屏幕图标；观测位置、轨迹及覆盖范围保持原始坐标。
const GAP = 6;
const STEP = 42;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const keyOf = item => `${item.kind}:${item.data.id}`;
const intersects = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + GAP
  && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + GAP;

function placeMarker(item, occupied, width, height) {
  const size = { width: item.width || 36, height: item.height || 36 };
  const origin = {
    x: clamp(item.x, size.width / 2 + 4, width - size.width / 2 - 4),
    y: clamp(item.y, size.height / 2 + 4, height - size.height / 2 - 4), ...size
  };
  const free = box => box.x - box.width / 2 >= 4 && box.x + box.width / 2 <= width - 4
    && box.y - box.height / 2 >= 4 && box.y + box.height / 2 <= height - 4
    && occupied.every(other => !intersects(box, other));
  if (free(origin)) return origin;
  // 由近及远按固定次序排开，同址大量目标也不折叠、不限八项。
  const rings = Math.ceil(Math.max(width, height) / STEP);
  for (let ring = 1; ring <= rings; ring++) {
    for (let offset = -ring; offset <= ring; offset++) {
      const offsets = [[offset, -ring], [ring, offset], [-offset, ring], [-ring, -offset]];
      for (const [dx, dy] of offsets) {
        const candidate = { ...origin, x: origin.x + dx * STEP, y: origin.y + dy * STEP };
        if (free(candidate)) return candidate;
      }
    }
  }
  // 视口确实放不下时仍保留图标，允许通过放大地图区分，不能静默隐藏。
  return origin;
}

export function layoutSituationMarkers(items, { width, height, obstacles = [] }) {
  const visible = items.filter(item => Number.isFinite(item.x) && Number.isFinite(item.y)
    && item.x >= 0 && item.x <= width && item.y >= 0 && item.y <= height)
    .map(item => ({ ...item, key: keyOf(item) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const points = new Map();
  const occupied = [...obstacles];
  for (const item of visible) {
    const box = placeMarker(item, occupied, width, height);
    occupied.push(box);
    points.set(item.key, { point: [box.x, box.y], anchor: [item.x, item.y], visible: true });
  }
  return { points, groups: [], width, height };
}

export function createSituationMarkerLayout() {
  let previous, signature = '';
  return (items, options) => {
    const next = JSON.stringify([options.width, options.height, options.obstacles,
      items.map(item => [keyOf(item), item.x, item.y, item.width, item.height])]);
    if (next === signature && previous) return previous;
    signature = next;
    previous = layoutSituationMarkers(items, options);
    return previous;
  };
}
