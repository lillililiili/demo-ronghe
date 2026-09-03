import { computed, ref } from 'vue';
import {
  PAGE_DEFAULT,
  normalizePage,
  normalizeSize,
  parsePagedPayload
} from '@/hooks/pagedList.js';

/* 跨页列表查询状态。status: idle | loading | empty | error | ready
   接口失败走 setError，不得在这里改写为 Mock 成功。 */
export function usePagedList(initial = {}) {
  const page = ref(normalizePage(initial.page));
  const size = ref(normalizeSize(initial.size ?? PAGE_DEFAULT));
  const items = ref([]);
  const total = ref(0);
  const status = ref('idle');
  const errorMessage = ref('');

  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / size.value) || 1));

  function applyPayload(data) {
    try {
      const parsed = parsePagedPayload(data);
      page.value = parsed.page;
      size.value = parsed.size;
      items.value = parsed.items;
      total.value = parsed.total;
      errorMessage.value = '';
      status.value = parsed.total === 0 ? 'empty' : 'ready';
      return parsed;
    } catch (err) {
      items.value = [];
      total.value = 0;
      status.value = 'error';
      errorMessage.value = err instanceof Error ? err.message : '分页载荷无效';
      return null;
    }
  }

  function setLoading() {
    status.value = 'loading';
    errorMessage.value = '';
  }

  function setError(err) {
    status.value = 'error';
    errorMessage.value = err instanceof Error ? err.message : String(err || '接口请求失败');
  }

  function setPage(next) {
    page.value = normalizePage(next);
  }

  function setSize(next) {
    size.value = normalizeSize(next);
    page.value = 1;
  }

  return {
    page,
    size,
    items,
    total,
    status,
    errorMessage,
    pageCount,
    applyPayload,
    setLoading,
    setError,
    setPage,
    setSize
  };
}
