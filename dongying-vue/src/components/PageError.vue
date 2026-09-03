<script setup>
import { NButton } from 'naive-ui';

defineProps({
  title: { type: String, default: '接口请求失败' },
  message: { type: String, default: '请稍后重试。失败时不会改用演示数据。' }
});
const emit = defineEmits(['retry']);
</script>

<template>
  <div class="page-chrome page-chrome--error" role="alert">
    <strong>{{ title }}</strong>
    <p>{{ message }}</p>
    <n-button type="primary" size="small" @click="emit('retry')">重试</n-button>
  </div>
</template>

<style scoped>
.page-chrome--error {
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  padding: 30px;
}
.page-chrome--error strong {
  color: var(--txt);
  font-size: 14px;
  font-weight: 600;
}
.page-chrome--error p {
  margin: 0;
  max-width: 36em;
  color: var(--txt-3);
  font-size: 13px;
  line-height: 1.65;
}
</style>
