import { mapPool } from '@/services/apiClient.js';

/** Counts come from the same filtered, permission-scoped list endpoint as the page. */
export async function readDistributionCounts(fetchList, filters, dimensions, { isCurrent = () => true } = {}) {
  const count = async query => {
    if (!isCurrent()) return null;
    const result = await fetchList({ ...query, page: 1, size: 1 });
    if (!Number.isSafeInteger(result.total) || result.total < 0) throw new Error('统计总数缺失或无效');
    return result.total;
  };
  const total = await count(filters);
  const result = { total };
  const jobs = dimensions.flatMap(({ key, field, codes }) => codes.map(code => ({ key, field, code })));
  const counts = await mapPool(jobs, 3, async ({ field, code }) => {
    if (!isCurrent()) return null;
    // A selected dimension remains an intersection; never replace the user's filter.
    if (!total) return 0;
    if (filters[field]) return filters[field] === code ? total : 0;
    return count({ ...filters, [field]: code });
  });
  dimensions.forEach(({ key }) => { result[key] = []; });
  jobs.forEach((job, index) => result[job.key].push({ code: job.code, count: counts[index] }));
  return result;
}
