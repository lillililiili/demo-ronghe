<script setup>
import { NSpin } from 'naive-ui';

defineProps({
  description: { type: String, default: '正在加载…' }
});
</script>

<template>
  <div class="page-chrome page-chrome--loading" role="status" aria-live="polite">
    <n-spin :show="true" :description="description" />
  </div>
</template>

<style scoped>
.page-chrome--loading {
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--txt-2);
}
</style>
