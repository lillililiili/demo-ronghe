<script setup>
/* PageHost —— 页面切换器：所有业务页都是真 Vue 组件，走 VUE_PAGES 注册表。
   未注册的键（拼错的 hash、被删掉的旧路由）一律显示"无权访问/页面不存在"，
   不再有 legacy 宿主兜底（决策 12-5）——那个兜底会让"给角色分配一个不存在的页"
   看起来像是配置成功了。
   Vue patch 对不同类型/不同 key 的节点是先卸旧再挂新（patch() 中
   isSameVNodeType 不同 → 先 unmount(n1)），因此转换页在 onUnmounted 里
   CH.disposeAll() 不会误杀下一页的图表。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { routeKey } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';
import { VUE_PAGES } from '@/pages/registry.js';
import AccessDeniedPage from '@/pages/AccessDeniedPage.vue';
import { canAccessRoute } from '@/services/accessControl.js';

const route = useRoute();
const store = useAppStore();
const k = computed(() => routeKey(route));
const allowed = computed(() => { store.accessRevision; return canAccessRoute(k.value); });
const vueComp = computed(() => VUE_PAGES[k.value] || null);
</script>

<template>
  <AccessDeniedPage v-if="!allowed" />
  <component v-else-if="vueComp" :is="vueComp" :key="k + ':' + store.remountKey" />
  <AccessDeniedPage v-else />
</template>
