<script setup>
/* PageHost —— 页面切换器：已转换为真 Vue 组件的页面走 VUE_PAGES 注册表，
   其余走 LegacyHost（命令式宿主）。
   Vue patch 对不同类型/不同 key 的节点是先卸旧再挂新（patch() 中
   isSameVNodeType 不同 → 先 unmount(n1)），因此转换页在 onUnmounted 里
   CH.disposeAll() 不会误杀下一页的图表。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { routeKey } from './navModel.js';
import { useAppStore } from '../stores/app.js';
import { VUE_PAGES } from '../pages/registry.js';
import LegacyHost from './LegacyHost.vue';

const route = useRoute();
const store = useAppStore();
const k = computed(() => routeKey(route));
const vueComp = computed(() => VUE_PAGES[k.value] || null);
</script>

<template>
  <component v-if="vueComp" :is="vueComp" :key="k + ':' + store.remountKey" />
  <LegacyHost v-else />
</template>
