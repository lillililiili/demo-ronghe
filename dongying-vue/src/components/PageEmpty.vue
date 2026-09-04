<script setup>
// 统一无数据表达，并预留可选操作插槽，避免各页面自行拼装不一致的空态。
defineProps({
  title: { type: String, default: '暂无数据' },
  description: { type: String, default: '当前没有可显示的记录' }
});
</script>

<template>
  <div class="empty page-chrome page-chrome--empty" role="status">
    <strong>{{ title }}</strong>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.action" class="page-chrome__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.page-chrome--empty {
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.page-chrome--empty strong {
  color: var(--txt);
  font-size: 14px;
  font-weight: 600;
}
.page-chrome--empty p {
  margin: 0;
  color: var(--txt-3);
  font-size: 13px;
}
</style>
