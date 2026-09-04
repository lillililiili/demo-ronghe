<script setup>
/* 外壳骨架 —— 与旧 index.html 的 #app 内部结构逐字对应：
   header.hdr + div.body ( nav.nav + main.main ( .crumb + .view ) )。
   n-config-provider 是 Naive UI 主题入口（darkTheme + tokens.css 映射，
   见 src/ui/theme.js）；它渲染为一个 div，加 display:contents 使其不参与布局。 */
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NConfigProvider } from 'naive-ui';
import { dateZhCN, theme, themeOverrides, zhCN } from '@/ui/theme.js';
import { routeKey } from '@/config/navModel.js';
import HeaderBar from './HeaderBar.vue';
import NavSidebar from './NavSidebar.vue';
import Breadcrumb from './Breadcrumb.vue';
import PageHost from './PageHost.vue';
import { useAppStore } from '@/stores/app.js';
import { canAccessRoute } from '@/services/accessControl.js';
import { installLegacyControlObserver } from '@/ui/legacyControls.js';
import { authRestoreError, authSession, isAuthenticated, restoreSession } from '@/services/auth.js';
import LoginPage from '@/pages/login/LoginPage.vue';
import PasswordChangePage from '@/pages/login/PasswordChangePage.vue';

const route = useRoute();
const router = useRouter();
const store = useAppStore();
const restoreBusy = ref(false);
const showRestoreFailure = computed(() => !!authSession.value && !!authRestoreError.value && !isAuthenticated());
const showLogin = computed(() => {
  authSession.value;
  store.accessRevision;
  return routeKey(route) === 'login' || !isAuthenticated();
});
async function retryRestore() {
  if (restoreBusy.value) return;
  restoreBusy.value = true;
  try { await restoreSession(); }
  finally { restoreBusy.value = false; }
}
const showPasswordChange = computed(() => routeKey(route) === 'change-password' && isAuthenticated());
const isBigScreen = computed(() => routeKey(route) === 'bigscreen');
const bigScreenAllowed = computed(() => {
  store.accessRevision;
  return isBigScreen.value && canAccessRoute('bigscreen');
});
const BigScreenApp = defineAsyncComponent(() => import('@/pages/bigscreen/BigScreenApp.vue'));
const refreshAccess = () => { store.accessRevision++; };
const handleUnauthorized = () => {
  const key = routeKey(route);
  if (key !== 'login') router.replace({ path: '/login', query: { redirect: route.fullPath } });
};
let stopLegacyControlObserver = null;
onMounted(() => {
  window.addEventListener('mock-access-change', refreshAccess);
  window.addEventListener('api:unauthorized', handleUnauthorized);
  stopLegacyControlObserver = installLegacyControlObserver(document.body);
});
onBeforeUnmount(() => {
  window.removeEventListener('mock-access-change', refreshAccess);
  window.removeEventListener('api:unauthorized', handleUnauthorized);
  stopLegacyControlObserver?.();
});
</script>

<template>
  <n-config-provider v-if="showRestoreFailure" :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN" style="display:contents">
    <main class="session-outage" role="alert">
      <section>
        <span>服务连接中断</span>
        <h1>暂时无法连接后端服务</h1>
        <p>{{ authRestoreError?.message || '请确认后端服务已启动后重试。' }}</p>
        <small>当前会话已保留；仅收到明确的 401 响应时才会退出登录。</small>
        <NButton type="primary" :loading="restoreBusy" @click="retryRestore">重试连接</NButton>
      </section>
    </main>
  </n-config-provider>
  <n-config-provider v-else-if="showPasswordChange" :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN" style="display:contents">
    <PasswordChangePage />
  </n-config-provider>
  <n-config-provider v-else-if="showLogin" :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN" style="display:contents">
    <LoginPage />
  </n-config-provider>
  <BigScreenApp v-else-if="bigScreenAllowed" />
  <n-config-provider v-else :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN" style="display:contents">
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

<style scoped>
.session-outage{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 20%,color-mix(in srgb,var(--blue) 18%,transparent),transparent 42%),var(--bg)}
.session-outage section{width:min(480px,100%);display:grid;gap:14px;padding:30px;border:1px solid var(--line-2);border-radius:10px;background:var(--panel);box-shadow:0 22px 70px rgba(0,0,0,.32)}
.session-outage span{width:max-content;padding:4px 9px;border-radius:999px;background:color-mix(in srgb,var(--amber) 16%,transparent);color:var(--amber);font-size:12px}
.session-outage h1{margin:0;font-size:24px}.session-outage p{margin:0;color:var(--txt-2);line-height:1.7}.session-outage small{color:var(--txt-3);line-height:1.6}
.session-outage :deep(.n-button){justify-self:start}
</style>
