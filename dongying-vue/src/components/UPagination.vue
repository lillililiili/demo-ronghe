<script setup>
import { computed } from 'vue';
import { NPagination } from 'naive-ui';

const page = defineModel('page', { type: Number, required: true });
const pageSize = defineModel('pageSize', { type: Number, default: 20 });
const props = defineProps({
  itemCount: { type: Number, default: 0 },
  prefix: { type: String, default: '' },
  suffix: { type: String, default: '' },
  size: { type: String, default: 'medium' }
});

const pageSizes = [
  { value: 10, label: '10 条/页' },
  { value: 20, label: '20 条/页' },
  { value: 50, label: '50 条/页' }
];
const pageCount = computed(() => Math.max(1, Math.ceil((props.itemCount || 0) / (pageSize.value || 1))));
const suffixText = computed(() => props.suffix || `共 ${pageCount.value} 页`);
</script>

<template>
  <n-pagination
    v-model:page="page"
    v-model:page-size="pageSize"
    :item-count="itemCount"
    :size="size"
    :page-slot="5"
    show-size-picker
    :page-sizes="pageSizes"
  >
    <template v-if="prefix" #prefix>{{ prefix }}</template>
    <template #suffix>{{ suffixText }}</template>
  </n-pagination>
</template>
