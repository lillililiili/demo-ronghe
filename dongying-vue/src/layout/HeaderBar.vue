<script setup>
/* 顶栏：logo / 时钟 / 大屏按钮 / 用户菜单。
   逻辑逐字移植旧 app.js 的 clock() 与 bindBigScreen()；用户菜单 Teleport 到 body
   （旧版就是 append 到 body 的 .usermenu，CSS 上下文保持一致）。 */
import { h, ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '@/stores/app.js';
import { useRouter } from 'vue-router';
import { authUser, logout } from '@/services/auth.js';
import { canAccessRoute } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { openModal, closeModal } from '@/ui/modal.js';

const store = useAppStore();
const router = useRouter();
const U = window.UI;
const currentUser = computed(() => authUser.value || { name: '用户', account: '—', role_name: '—', org_name: '—' });
const avatarText = computed(() => currentUser.value.name.slice(-1));
const canBigscreen = computed(() => canAccessRoute('bigscreen'));

/* ---------- 时钟：本地墙钟，不再使用 Mock 演示基准时刻 ---------- */
function formatClock(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
let clkTimer = null;
const tick = () => {
  store.timeStr = formatClock(new Date());
};
tick();
const clkHtml = computed(() => `${U.icon('clock')} ${store.timeStr}`);
/* ---------- 大屏展示：进入 Vue Router 管理的监控大屏页面 ---------- */
const screenLabel = `${U.icon('mon')} 数据大屏`;

/* ---------- 全屏模式 ---------- */
const bigLabel = computed(() => `${U.icon('fullscreen')} ${store.bigscreen ? '退出全屏' : '全屏'}`);
async function toggleBig() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen unavailable');
      await document.documentElement.requestFullscreen();
    }
  } catch {
    toast('未能切换全屏，请检查浏览器是否允许全屏显示', 'warn');
  }
  const on = Boolean(document.fullscreenElement);
  document.body.classList.toggle('bigscreen', on);
  store.bigscreen = on;
  window.dispatchEvent(new Event('resize'));
}
function onFsChange() {
  if (!document.fullscreenElement && document.body.classList.contains('bigscreen')) {
    document.body.classList.remove('bigscreen');
    store.bigscreen = false;
    window.dispatchEvent(new Event('resize'));
  }
}

/* ---------- 用户菜单：仅保留个人信息与退出登录 ---------- */
const menuOpen = ref(false);
function toggleMenu(e) {
  e.stopPropagation();
  menuOpen.value = !menuOpen.value;
}
function closeMenu() { menuOpen.value = false; }
async function onMenu(k) {
  closeMenu();
  if (k === 'me') openModal({
    title: '个人信息', width: '440px',
    render: () => h('dl', { class: 'kv' }, [
      ['账号', currentUser.value.account], ['姓名', currentUser.value.name], ['角色', currentUser.value.role_name],
      ['所属单位', currentUser.value.org_name || '未设置']
    ].flatMap(([label, value]) => [h('dt', label), h('dd', String(value || '—'))]))
  });
  else if (k === 'logout') {
    // 阶段 12：轮播组件已删除，登出时不再需要停它。
    closeModal();
    document.body.classList.remove('bigscreen');
    store.bigscreen = false;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    await logout();
    router.replace('/login');
    toast('已退出登录', 'ok');
  }
}

onMounted(() => {
  clkTimer = setInterval(tick, 1000);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('click', closeMenu);
});
onBeforeUnmount(() => {
  // 阶段 12：search.js 已删除，window.SEARCH 不再存在，这行随之移除。
  clearInterval(clkTimer);
  document.removeEventListener('fullscreenchange', onFsChange);
  document.removeEventListener('click', closeMenu);
});
</script>

<template>
  <header class="hdr">
    <div class="logo">
      <img src="/assets/img/brand/logo-mark.png" alt="平台 Logo" width="36" height="36">
      <b>无人机融合感知与低空安全管理平台</b>
    </div>
    <div class="spacer"></div>
    <div class="meta">
      <span class="it" id="clk" v-html="clkHtml"></span>
      <span v-if="canBigscreen" class="it"><router-link class="btn ghost" id="btnScreen" to="/bigscreen" title="进入低空安全数据大屏" v-html="screenLabel"></router-link></span>
      <span class="it"><button class="btn ghost" id="btnBig" title="全屏模式：放大字号与行距，适配指挥大厅显示" v-html="bigLabel" @click="toggleBig"></button></span>
      <button class="user icon-btn" type="button" aria-haspopup="menu" :aria-expanded="String(menuOpen)" @click="toggleMenu"><span class="av">{{ avatarText }}</span><span>{{ currentUser.name }}</span><svg class="chev-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>
    </div>
  </header>
  <Teleport to="body">
    <div class="usermenu" :class="{ open: menuOpen }" @click.stop>
      <div class="mi" data-um="me" @click="onMenu('me')" v-html="U.icon('user') + ' 个人信息'"></div>
      <div class="sep"></div>
      <div class="mi" data-um="logout" @click="onMenu('logout')" v-html="U.icon('logout') + ' 退出登录'"></div>
    </div>
  </Teleport>
</template>
