<script setup>
/* 顶栏：logo / 时钟 / 大屏按钮 / 告警铃铛 / 用户菜单。
   逻辑逐字移植旧 app.js 的 clock() 与 bindBigScreen()；用户菜单 Teleport 到 body
   （旧版就是 append 到 body 的 .usermenu，CSS 上下文保持一致）。 */
import { h, ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '@/stores/app.js';
import { stopCarousel } from '@/hooks/useCarousel.js';
import { useRouter } from 'vue-router';
import { authUser, logout } from '@/services/auth.js';
import { canAccessRoute } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { openModal, closeModal } from '@/ui/modal.js';
import { listAlarms } from '@/services/alarmApi.js';

const store = useAppStore();
const router = useRouter();
const M = window.MOCK, U = window.UI;
const currentUser = computed(() => authUser.value || { name: '用户', account: '—', role_name: '—', org_name: '—' });
const avatarText = computed(() => currentUser.value.name.slice(-1));
const canBigscreen = computed(() => canAccessRoute('bigscreen'));
const canAlarms = computed(() => canAccessRoute('alarms'));

/* ---------- 时钟：系统当前时间 ---------- */
let clkTimer = null;
let stopBellRoute = null;
const tick = () => {
  store.timeStr = M.systemNowStr();
};
tick();
const clkHtml = computed(() => `${U.icon('clock')} ${store.timeStr}`);
/* ---------- 告警铃铛：未处理数来自服务端告警列表 ----------
   铃铛与告警页共用同一条件：同一个 alarm:read 权限、同一范围谓词、同一状态过滤。
   原因：铃铛数字是“点进去能看到几条待办”的承诺。若这里另算一套（例如读 Mock 或
   自己数状态），就会出现顶栏显示 3 条、告警页却是空列表或 403 的矛盾。
   因此只向 listAlarms 各取 state=PENDING_VERIFICATION / EVIDENCE_REQUIRED 的 size=1 页，
   用服务端 total 求和；无权限（403）或任何失败都清空数字，不回退旧 Mock 计数。 */
const bellN = ref(null);
let bellSeq = 0;
async function refreshBell() {
  const seq = ++bellSeq;
  if (!canAlarms.value) { bellN.value = null; return; }
  try {
    const [pending, evidence] = await Promise.all([
      listAlarms({ state: 'PENDING_VERIFICATION', page: 1, size: 1 }),
      listAlarms({ state: 'EVIDENCE_REQUIRED', page: 1, size: 1 })
    ]);
    if (seq !== bellSeq) return;
    bellN.value = (pending?.total || 0) + (evidence?.total || 0);
  } catch {
    // 403 表示无 alarm:read；其余失败同样是结果未知。两种情况都不显示数字，避免用旧值冒充事实。
    if (seq === bellSeq) bellN.value = null;
  }
}
const bellText = computed(() => (bellN.value === null ? '' : String(bellN.value)));

/* ---------- 大屏展示：进入 Vue Router 管理的监控大屏页面 ---------- */
const screenLabel = `${U.icon('mon')} 数据大屏`;

/* ---------- 全屏模式 ---------- */
const bigLabel = computed(() => `${U.icon('fullscreen')} ${store.bigscreen ? '退出全屏' : '全屏'}`);
function toggleBig() {
  const on = document.body.classList.toggle('bigscreen');
  store.bigscreen = on;
  if (on && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => { });
  } else if (!on && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => { });
  }
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
function goAlarms() { location.hash = '#/alarms'; }
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
    stopCarousel();
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
  // 登录/退出/权限刷新会触发 mock-access-change；路由切换后重取，核实完成回到其他页也能看到新数。
  window.addEventListener('mock-access-change', refreshBell);
  stopBellRoute = router.afterEach(() => { refreshBell(); });
  refreshBell();
});
onBeforeUnmount(() => {
  window.SEARCH?.destroy();
  clearInterval(clkTimer);
  document.removeEventListener('fullscreenchange', onFsChange);
  document.removeEventListener('click', closeMenu);
  window.removeEventListener('mock-access-change', refreshBell);
  stopBellRoute?.(); stopBellRoute = null;
  bellSeq++;
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
      <button v-if="canAlarms" class="it bell icon-btn" id="bell" type="button" aria-label="查看告警" @click="goAlarms">
        <svg class="hdr-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        <span class="dot" id="bellN" v-show="bellN !== null">{{ bellText }}</span>
      </button>
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
