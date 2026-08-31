<script setup>
/* 外壳骨架 —— 与旧 index.html 的 #app 内部结构逐字对应：
   header.hdr + div.body ( nav.nav + main.main ( .crumb + .view ) )。
   n-config-provider 是 Naive UI 主题入口（darkTheme + app.css token 映射，
   见 src/ui/theme.js）；它渲染为一个 div，加 display:contents 使其不参与布局。 */
import { computed, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';
import { NConfigProvider } from 'naive-ui';
import { theme, themeOverrides } from '../ui/theme.js';
import { routeKey } from './navModel.js';
import HeaderBar from './HeaderBar.vue';
import NavSidebar from './NavSidebar.vue';
import Breadcrumb from './Breadcrumb.vue';
import PageHost from './PageHost.vue';

const route = useRoute();
const isBigScreen = computed(() => routeKey(route) === 'bigscreen');
const BigScreenApp = defineAsyncComponent(() => import('../bigscreen/BigScreenApp.vue'));
</script>

<template>
  <BigScreenApp v-if="isBigScreen" />
  <n-config-provider v-else :theme="theme" :theme-overrides="themeOverrides" style="display:contents">
    <HeaderBar />
    <div class="body">
      <NavSidebar />
      <main class="main">
        <Breadcrumb />
        <PageHost />
      </main>
    </div>
  </n-config-provider>
</template>
