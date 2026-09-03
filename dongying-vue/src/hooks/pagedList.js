/* 列表分页口径：与后端契约一致。
   字段固定为 page / size / items / total；页码从 1，默认 20，最大 100。
   纯函数，不依赖 Vue，便于页面在接 API 之前先切本地切片。 */
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 100;

export function normalizePage(page) {
  const n = Number(page);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export function normalizeSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 1) return PAGE_DEFAULT;
  return Math.min(PAGE_MAX, Math.floor(n));
}

export function parsePagedPayload(data) {
  const src = data && typeof data === 'object' ? data : {};
  const items = Array.isArray(src.items) ? src.items : [];
  const page = normalizePage(src.page);
  const size = normalizeSize(src.size);
  const total = Number.isFinite(Number(src.total))
    ? Math.max(0, Math.floor(Number(src.total)))
    : items.length;
  return { page, size, items, total };
}

export function sliceLocal(all, page, size) {
  const list = Array.isArray(all) ? all : [];
  const p = normalizePage(page);
  const s = normalizeSize(size);
  const start = (p - 1) * s;
  return { page: p, size: s, items: list.slice(start, start + s), total: list.length };
}
