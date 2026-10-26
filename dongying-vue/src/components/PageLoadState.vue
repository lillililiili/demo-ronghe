<script setup>
defineProps({ error: { type: Error, default: null } });
const reload = () => window.location.reload();
</script>

<template>
  <section class="view" :aria-busy="!error">
    <div class="empty" :role="error ? 'alert' : 'status'">
      <template v-if="error">
        <p>页面资源加载失败，请检查网络后重新加载。</p>
        <button type="button" class="btn" @click="reload">重新加载</button>
      </template>
      <span v-else>正在加载页面</span>
    </div>
  </section>
</template>
