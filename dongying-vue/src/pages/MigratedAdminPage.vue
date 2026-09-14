<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { pageTitle } from '@/config/navModel.js';

const props = defineProps({ pageKey: { type: String, required: true } });
const router = useRouter();
const title = computed(() => pageTitle(props.pageKey));
</script>

<template>
  <div class="view migrated-admin-page">
    <section class="panel migrated-card">
      <span class="migrated-label">后台功能迁移</span>
      <h1>{{ title }}已迁移至后台管理系统</h1>
      <p>业务前台不再提供该管理页面。请在独立后台管理系统中完成相关操作，本页不会自动跳转。</p>
      <button class="btn primary" type="button" @click="router.push('/situation')">返回融合感知首页</button>
    </section>
  </div>
</template>

<style scoped>
.migrated-admin-page{display:grid;min-height:calc(100vh - 116px);place-items:center;padding:24px}.migrated-card{width:min(620px,100%);padding:42px;text-align:center}.migrated-label{display:inline-block;padding:4px 10px;border:1px solid color-mix(in srgb,var(--blue) 44%,transparent);border-radius:999px;color:var(--blue);background:color-mix(in srgb,var(--blue) 10%,transparent);font-size:12px}.migrated-card h1{margin:18px 0 10px;font-size:24px}.migrated-card p{margin:0 auto 24px;max-width:480px;color:var(--txt-2);line-height:1.8}.migrated-card .btn{min-width:150px}
</style>
