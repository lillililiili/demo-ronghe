<script setup>
import { computed } from 'vue';
import UControl from '@/components/form/UControl.vue';
const props = defineProps({ page: Number, pageSize: Number, total: Number, loading: Boolean });
const emit = defineEmits(['update:page', 'update:page-size']);
const pages = computed(() => Math.max(1, Math.ceil((props.total || 0) / (props.pageSize || 20))));
const sizes = [10, 20, 50].map(value => ({ label: `${value} 条/页`, value }));
</script>

<template>
  <div class="flight-list-pager">
    <div class="pager-summary"><span>共 {{ total || 0 }} 条</span><UControl :model-value="pageSize" type="select" :options="sizes" :disabled="loading" size="small" aria-label="每页条数" @update:model-value="emit('update:page-size', $event)" /></div>
    <div class="pager-navigation"><button class="btn ghost" type="button" :disabled="loading || page <= 1" @click="emit('update:page', page - 1)">上一页</button><span>{{ page }} / {{ pages }}</span><button class="btn ghost" type="button" :disabled="loading || page >= pages" @click="emit('update:page', page + 1)">下一页</button></div>
  </div>
</template>

<style scoped>
.flight-list-pager { flex: none; padding: 9px 12px; border-top: 1px solid var(--line); font-size: 11px; color: var(--txt-3); }
.pager-summary,.pager-navigation { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.pager-summary { margin-bottom: 7px; }
.pager-summary :deep(.n-select) { width: 105px; }
.pager-navigation .btn { font-size: 11px; padding: 4px 8px; }
.pager-navigation .btn:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
</style>
