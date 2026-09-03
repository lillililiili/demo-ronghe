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
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('分页载荷无效：必须是对象');
  }
  for (const field of ['page', 'size', 'items', 'total']) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      throw new TypeError(`分页载荷无效：缺少 ${field}`);
    }
  }
  const { page, size, items, total } = data;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new TypeError('分页载荷无效：page 必须是正整数');
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > PAGE_MAX) {
    throw new TypeError(`分页载荷无效：size 必须是 1-${PAGE_MAX} 的整数`);
  }
  if (!Array.isArray(items)) {
    throw new TypeError('分页载荷无效：items 必须是数组');
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError('分页载荷无效：total 必须是非负整数');
  }
  if (items.length > size) {
    throw new TypeError('分页载荷无效：items 数量超过 size');
  }
  if (total === 0 && items.length > 0) {
    throw new TypeError('分页载荷无效：total 为 0 时 items 必须为空');
  }
  const pageCount = Math.max(1, Math.ceil(total / size));
  if (page > pageCount) {
    throw new TypeError('分页载荷无效：page 超过有效页数');
  }
  const remaining = Math.max(0, total - (page - 1) * size);
  if (items.length > remaining) {
    throw new TypeError('分页载荷无效：items 数量超过当前页剩余总数');
  }
  return { page, size, items, total };
}

export function sliceLocal(all, page, size) {
  const list = Array.isArray(all) ? all : [];
  const s = normalizeSize(size);
  const pageCount = Math.max(1, Math.ceil(list.length / s));
  const p = Math.min(normalizePage(page), pageCount);
  const start = (p - 1) * s;
  return { page: p, size: s, items: list.slice(start, start + s), total: list.length };
}
