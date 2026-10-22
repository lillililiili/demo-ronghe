import { pointRelation } from './airspaceGeometry.js';

// 使用当前绘制的屏幕坐标命中，容差单位为像素，不影响业务距离或空域判定。
export function hitMapReference([x, y], references) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const hits = references.slice().reverse();
  const near = ({ points, labelBox }) => {
    if (labelBox && x >= labelBox[0] && x <= labelBox[2] && y >= labelBox[1] && y <= labelBox[3]) return true;
    if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]) <= 14;
    return points.slice(1).some(([bx, by], i) => {
      const [ax, ay] = points[i], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= 8;
    });
  };
  // 小参考点和线优先于大片区域，避免区域挡住内部参考物。
  return hits.find(item => !item.polygon && near(item))
    || hits.find(item => item.polygon && (near(item) || pointRelation([x, y], [[item.points]]) !== 'OUTSIDE')) || null;
}
