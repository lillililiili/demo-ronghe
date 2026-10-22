// 地图参照物命中所用的平面几何；不参与业务风险或空域合法性判断。
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
