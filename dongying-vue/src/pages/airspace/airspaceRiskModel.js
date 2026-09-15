// 仅做地图位置展示与平面范围筛选；不计算风险等级、合法性或现场是否已经解除。
function coordinate(value, limit) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

export function riskSnapshotPoint(risk) {
  const longitude = coordinate(risk?.space_fact?.longitude, 180);
  const latitude = coordinate(risk?.space_fact?.latitude, 90);
  return longitude === null || latitude === null ? null : [longitude, latitude];
}

// 最近发现时间控制列表窗口，坐标观测时间单独控制定位资格。
export function recentMonitoredTargets(rows, now, minutes, polygons) {
  const from = now - minutes * 60_000;
  return rows.filter(row => !['PERSON', 'VEHICLE', 'SHIP', 'REMOTE_CONTROLLER'].includes(row.object_type_code)
    && Number.isFinite(row.last_seen_at) && row.last_seen_at >= from && row.last_seen_at <= now)
    .map(row => {
      const state = row.latest_state, locatedAt = state?.observed_at;
      const point = Number.isFinite(locatedAt) && locatedAt >= from && locatedAt <= now
        ? riskSnapshotPoint({ space_fact: state?.location }) : null;
      return { ...row, point, relation: pointRelation(point, polygons) };
    });
}

function ringRelation([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    // 闭环的首尾重复点不能让所有坐标都被视为边界。
    if (dx === 0 && dy === 0) continue;
    const cross = (x - ax) * dy - (y - ay) * dx;
    if (Math.abs(cross) <= 1e-10 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
      && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return 'BOUNDARY';
    if ((ay > y) !== (by > y) && x < dx * (y - ay) / dy + ax) inside = !inside;
  }
  return inside ? 'INSIDE' : 'OUTSIDE';
}

export function pointRelation(point, polygons) {
  if (!point || !polygons?.length) return 'UNKNOWN';
  let boundary = false;
  for (const [outer, ...holes] of polygons) {
    if (!outer?.length) continue;
    const outside = ringRelation(point, outer);
    if (outside === 'OUTSIDE') continue;
    const inner = holes.map(ring => ringRelation(point, ring));
    if (inner.includes('INSIDE')) continue;
    if (outside === 'BOUNDARY' || inner.includes('BOUNDARY')) boundary = true;
    else return 'INSIDE';
  }
  return boundary ? 'BOUNDARY' : 'OUTSIDE';
}

export async function loadRiskPages(list, params = {}, isCurrent = () => true) {
  const rows = [];
  let total = 0;
  for (let page = 1; ; page++) {
    if (!isCurrent()) return null;
    const data = await list({ ...params, page, size: 100 });
    if (!isCurrent()) return null;
    if (!Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0
      || (!data.items.length && rows.length < data.total)) throw new Error('风险列表读取不完整，请刷新重试。');
    total = data.total;
    rows.push(...data.items);
    if (rows.length >= total) break;
  }
  return [...new Map(rows.map(row => [row.risk_id, row])).values()];
}
