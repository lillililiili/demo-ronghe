<script setup>
/* 外壳骨架 —— 与旧 index.html 的 #app 内部结构逐字对应：
   header.hdr + div.body ( nav.nav + main.main ( .crumb + .view ) )。
   n-config-provider 是 Naive UI 主题入口（darkTheme + tokens.css 映射，
   见 src/ui/theme.js）；它渲染为一个 div，加 display:contents 使其不参与布局。 */
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { NConfigProvider } from 'naive-ui';
import { theme, themeOverrides } from '@/ui/theme.js';
import { routeKey } from '@/config/navModel.js';
import HeaderBar from './HeaderBar.vue';
import NavSidebar from './NavSidebar.vue';
import Breadcrumb from './Breadcrumb.vue';
import PageHost from './PageHost.vue';
import { useAppStore } from '@/stores/app.js';
import { canAccessRoute } from '@/services/accessControl.js';
import { installLegacyControlObserver } from '@/ui/legacyControls.js';
import { authSession, isAuthenticated } from '@/services/auth.js';
import LoginPage from '@/pages/login/LoginPage.vue';

const route = useRoute();
const store = useAppStore();
const showLogin = computed(() => {
  authSession.value;
  store.accessRevision;
  return routeKey(route) === 'login' || !isAuthenticated();
});
const isBigScreen = computed(() => routeKey(route) === 'bigscreen');
const bigScreenAllowed = computed(() => {
  store.accessRevision;
  return isBigScreen.value && canAccessRoute('bigscreen');
});
const BigScreenApp = defineAsyncComponent(() => import('@/pages/bigscreen/BigScreenApp.vue'));
const refreshAccess = () => { store.accessRevision++; };
let stopLegacyControlObserver = null;
onMounted(() => {
  window.addEventListener('mock-access-change', refreshAccess);
  stopLegacyControlObserver = installLegacyControlObserver(document.body);
});
onBeforeUnmount(() => {
  window.removeEventListener('mock-access-change', refreshAccess);
  stopLegacyControlObserver?.();
});
</script>

<template>
  <n-config-provider v-if="showLogin" :theme="theme" :theme-overrides="themeOverrides" style="display:contents">
    <LoginPage />
  </n-config-provider>
  <BigScreenApp v-else-if="bigScreenAllowed" />
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
