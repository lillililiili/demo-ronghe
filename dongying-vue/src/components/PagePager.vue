<script setup>
import { computed } from 'vue';
import { NPagination } from 'naive-ui';
import { PAGE_DEFAULT, PAGE_MAX, normalizePage, normalizeSize } from '@/hooks/pagedList.js';

const props = defineProps({
  page: { type: [Number, String], default: 1 },
  size: { type: [Number, String], default: PAGE_DEFAULT },
  total: { type: [Number, String], default: 0 },
  pageSizes: { type: Array, default: () => [20, 50, 100] }
});
const emit = defineEmits(['update:page', 'update:size']);

const safePage = computed(() => normalizePage(props.page));
const safeSize = computed(() => normalizeSize(props.size));
const itemCount = computed(() => {
  const n = Number(props.total);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
});
const pageCount = computed(() => Math.max(1, Math.ceil(itemCount.value / safeSize.value) || 1));
const sizes = computed(() => {
  const raw = Array.isArray(props.pageSizes) ? props.pageSizes : [20, 50, 100];
  const uniq = [];
  raw.forEach(value => {
    const n = normalizeSize(value);
    if (n >= 1 && n <= PAGE_MAX && !uniq.includes(n)) uniq.push(n);
  });
  return uniq.map(value => ({ value, label: `${value}条/页` }));
});

function onPage(next) { emit('update:page', normalizePage(next)); }
function onSize(next) { emit('update:size', normalizeSize(next)); }
</script>

<template>
  <div class="pager">
    <n-pagination
      :page="safePage"
      :page-size="safeSize"
      :item-count="itemCount"
      size="small"
      :page-slot="5"
      show-size-picker
      :page-sizes="sizes"
      @update:page="onPage"
      @update:page-size="onSize">
      <template #prefix>共 {{ itemCount.toLocaleString() }} 条</template>
      <template #suffix>共 {{ pageCount }} 页</template>
    </n-pagination>
  </div>
</template>
