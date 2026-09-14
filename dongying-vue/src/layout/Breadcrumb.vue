<script setup>
/* 面包屑：首页 › 一级模块 › 当前页 › [业务上下文]。
   结构对应旧 renderCrumb() 的路径段。 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { HOME_KEY, ROUTES, routeKey } from '@/config/navModel.js';
import { useAppStore } from '@/stores/app.js';

const route = useRoute();
const store = useAppStore();
const cur = computed(() => routeKey(route));

const cbsHtml = computed(() => {
  const k = cur.value, r = ROUTES[k] || { t: k };
  const parts = [`<a href="#/${HOME_KEY}">首页</a>`];
  if (r.p) parts.push(`<a href="#/${r.ph}">${r.p}</a>`);
  parts.push(`<span class="c on">${r.t}</span>`);
  if (store.crumbCtx) parts.push(`<span class="c ctx">${store.crumbCtx}</span>`);
  return parts.join('<b>›</b>');
});
</script>

<template>
  <div class="crumb" id="crumb">
    <div class="cbs" v-html="cbsHtml"></div>
  </div>
</template>
