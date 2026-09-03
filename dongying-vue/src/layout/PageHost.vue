<script setup>
/* PageHost —— 页面切换器：已转换为真 Vue 组件的页面走 VUE_PAGES 注册表，
   其余走 LegacyHost（命令式宿主）。
   Vue patch 对不同类型/不同 key 的节点是先卸旧再挂新（patch() 中
   isSameVNodeType 不同 → 先 unmount(n1)），因此转换页在 onUnmounted 里
   CH.disposeAll() 不会误杀下一页的图表。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { routeKey } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';
import { VUE_PAGES } from '@/pages/registry.js';
import LegacyHost from './LegacyHost.vue';
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
  <LegacyHost v-else />
</template>
