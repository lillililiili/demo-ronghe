<script setup>
import PageLoading from '@/components/PageLoading.vue';
import PageEmpty from '@/components/PageEmpty.vue';
import PageError from '@/components/PageError.vue';

defineProps({
  status: { type: String, default: 'ready' },
  loadingText: { type: String, default: '正在加载…' },
  emptyTitle: { type: String, default: '暂无数据' },
  emptyDescription: { type: String, default: '当前没有可显示的记录' },
  errorTitle: { type: String, default: '接口请求失败' },
  errorMessage: { type: String, default: '请稍后重试。失败时不会改用演示数据。' }
});
defineEmits(['retry']);
</script>

<template>
  <PageLoading v-if="status === 'loading'" :description="loadingText" />
  <PageError
    v-else-if="status === 'error'"
    :title="errorTitle"
    :message="errorMessage"
    @retry="$emit('retry')"
  />
  <PageEmpty
    v-else-if="status === 'empty'"
    :title="emptyTitle"
    :description="emptyDescription"
  >
    <template v-if="$slots.emptyAction" #action>
      <slot name="emptyAction" />
    </template>
  </PageEmpty>
  <slot v-else />
</template>
