import { onBeforeUnmount, reactive } from 'vue';

/** Read-only statistics; a new list request invalidates every older chart response. */
export function useModuleStatistics(fetchStats, definitions) {
  const state = reactive({ loading: true, error: '', total: 0, groups: [] });
  let sequence = 0;
  let active = true;
  function begin() {
    sequence += 1;
    Object.assign(state, { loading: true, error: '', groups: [] });
  }
  function fail(error) {
    sequence += 1;
    Object.assign(state, { loading: false, groups: [], error: error?.status === 403
      ? '当前账号没有查看统计数据的权限' : error?.message || String(error || '统计读取失败') });
  }
  async function load(query) {
    begin();
    const own = sequence;
    const { page, size, sort, order, ...filters } = query;
    try {
      const result = await fetchStats(filters, { isCurrent: () => active && own === sequence });
      if (!active || own !== sequence) return;
      if (!Number.isSafeInteger(result.total) || result.total < 0) throw new Error('统计总数缺失或无效');
      const groups = definitions.map(definition => {
        const rows = result[definition.key];
        if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.count) || row.count < 0)) {
          throw new Error('统计分类数据缺失或无效');
        }
        const total = rows.reduce((sum, row) => sum + row.count, 0);
        if (!definition.windowed && total !== result.total) {
          throw new Error('数据正在变化，分类数量与总数暂不一致，请重试');
        }
        return { ...definition, total, data: rows.map(row => ({
          name: definition.label?.(row.code) || definition.labels?.[row.code] || '其他或未知', value: row.count,
          color: definition.colors?.[row.code] || 'gray'
        })) };
      });
      Object.assign(state, { groups, total: result.total, loading: false });
    } catch (error) {
      if (active && own === sequence) fail(error);
    }
  }
  onBeforeUnmount(() => { active = false; sequence += 1; });
  return { state, begin, fail, load };
}
