import { pointRelation } from './airspaceRiskModel.js';

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

export const REFERENCE_NOTES = {
  dock: '无人机自动起降参考点；目标距离按距该点的水平距离展示。',
  facility: '重点设施中心参考点；目标距离按距该中心的水平距离展示。',
  route: '航线中心线；目标距离取到中心线的最短水平距离。',
  airspace: '监测空域平面范围；目标距离取到边界的最短水平距离，界内外仅表示平面位置。'
};
