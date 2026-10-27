export const MAX_EO_SELECTION = 20;
export const selectionKey = row => row?.riskCaseId ? `risk:${row.riskCaseId}` : row?.key || `event:${row?.eventId || ''}`;
export function rectangle(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
export function pointsWithin(points, rect) {
  return points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height);
}
export function toggleSelected(selected, row) {
  if (!row?.eventId || !row.targetId) return selected;
  return selected.some(item => selectionKey(item) === selectionKey(row)) ? selected.filter(item => selectionKey(item) !== selectionKey(row))
    : selected.length < MAX_EO_SELECTION ? [...selected, { ...row }] : selected;
}
export function reconcileSelected(selected, candidates) {
  return selected.map(item => {
    const current = candidates.find(row => selectionKey(row) === selectionKey(item) && row.targetId === item.targetId);
    return current ? { ...item, ...current, unavailable: !!current.unavailable } : { ...item, unavailable: true };
  });
}
