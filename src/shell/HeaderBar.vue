<script setup>
/* 顶栏：logo / 时钟 / 天气 / 大屏按钮 / 告警铃铛 / 用户菜单。
   逻辑逐字移植旧 app.js 的 clock() 与 bindBigScreen()；用户菜单 Teleport 到 body
   （旧版就是 append 到 body 的 .usermenu，CSS 上下文保持一致）。 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '../stores/app.js';
import { carouselDlg } from './useCarousel.js';
import { toast } from '../ui/nv.js';
import { openModal, closeModal } from '../ui/modal.js';
import { refreshWeather, weatherState } from '../services/weather.js';

const store = useAppStore();
const M = window.MOCK, U = window.UI;
const currentUser = computed(() => { store.accessRevision; return M.currentUser || { name: '用户', account: '—', roleName: '—', org: '—' }; });
const avatarText = computed(() => currentUser.value.name.slice(-1));
const canBigscreen = computed(() => { store.accessRevision; return M.canMenu('bigscreen'); });
const canAlarms = computed(() => { store.accessRevision; return M.canMenu('alarms'); });
const canUsers = computed(() => { store.accessRevision; return M.canMenu('users'); });
const canRoles = computed(() => { store.accessRevision; return M.canMenu('roles'); });

/* ---------- 时钟：系统当前时间与 Mock 数据统计时间分离 ---------- */
let clkTimer = null, weatherTimer = null;
const tick = () => {
  store.timeStr = M.systemNowStr();
  store.dataTimeStr = M.nowStr();
};
tick();
const clkHtml = computed(() => `${U.icon('clock')} ${store.timeStr}`);
const weaHtml = computed(() => {
  const w = weatherState;
  const temp = w.temperature == null ? `${w.tempLo}℃ ~ ${w.tempHi}℃` : `${w.temperature}℃`;
  const wind = w.windDirection ? ` ${w.windDirection}风${w.windPower ? `${w.windPower}级` : ''}` : '';
  return `${w.city} ${U.icon('cloud')} ${temp} ${w.text}${wind}`;
});
const weatherTitle = computed(() => {
  const w = weatherState;
  const detail = [w.source, w.reportTime && `发布 ${w.reportTime}`, w.humidity && `湿度 ${w.humidity}%`].filter(Boolean).join(' · ');
  return w.error ? `${detail || '本地天气'} · ${w.error}` : detail;
});
const bellN = M.todayStats.pendingAlarm + M.todayStats.disposing;

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

/* ---------- 用户菜单 ---------- */
const menuOpen = ref(false);
function toggleMenu(e) {
  e.stopPropagation();
  menuOpen.value = !menuOpen.value;
}
function closeMenu() { menuOpen.value = false; }
function goAlarms() { location.hash = '#/alarms'; }
function onMenu(k) {
  closeMenu();
  if (k === 'users') location.hash = '#/users';
  else if (k === 'roles') location.hash = '#/roles';
  else if (k === 'carousel') carouselDlg();
  else if (k === 'me') openModal({
    title: '个人信息', width: '440px',
    body: U.kv([['账号', currentUser.value.account], ['姓名', currentUser.value.name], ['角色', currentUser.value.roleName],
    ['所属单位', currentUser.value.org], ['双因子认证', currentUser.value.mfa],
    ['最后登录', currentUser.value.lastLogin], ['登录 IP', currentUser.value.lastIp]])
  });
  else toast('已退出登录(Demo 环境不跳转登录页)', 'ok');
}

onMounted(() => {
  clkTimer = setInterval(tick, 1000);
  refreshWeather();
  weatherTimer = setInterval(refreshWeather, 30 * 60 * 1000);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('click', closeMenu);
});
onBeforeUnmount(() => {
  clearInterval(clkTimer);
  clearInterval(weatherTimer);
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
      <span class="it" id="wea" :title="weatherTitle" v-html="weaHtml"></span>
      <span v-if="canBigscreen" class="it"><router-link class="btn ghost" id="btnScreen" to="/bigscreen" title="进入低空安全数据大屏" v-html="screenLabel"></router-link></span>
      <span class="it"><button class="btn ghost" id="btnBig" title="全屏模式：放大字号与行距，适配指挥大厅显示" v-html="bigLabel" @click="toggleBig"></button></span>
      <button v-if="canAlarms" class="it bell icon-btn" id="bell" type="button" aria-label="查看告警" @click="goAlarms">
        <svg class="hdr-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        <span class="dot" id="bellN">{{ bellN }}</span>
      </button>
      <button class="user icon-btn" type="button" aria-haspopup="menu" :aria-expanded="String(menuOpen)" @click="toggleMenu"><span class="av">{{ avatarText }}</span><span>{{ currentUser.name }}</span><svg class="chev-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>
    </div>
  </header>
  <Teleport to="body">
    <div class="usermenu" :class="{ open: menuOpen }" @click.stop>
      <div class="mi" data-um="me" @click="onMenu('me')" v-html="U.icon('user') + ' 个人信息'"></div>
      <div class="mi" data-um="ops" @click="onMenu('ops')" v-html="U.icon('settings') + ' 运维管理'"></div>
      <div v-if="canUsers" class="mi" data-um="users" @click="onMenu('users')" v-html="U.icon('user') + ' 用户管理'"></div>
      <div v-if="canRoles" class="mi" data-um="roles" @click="onMenu('roles')" v-html="U.icon('shield') + ' 角色管理'"></div>
      <div class="mi" data-um="carousel" @click="onMenu('carousel')" v-html="U.icon('play') + ' 大屏轮播'"></div>
      <div class="sep"></div>
      <div class="mi" data-um="logout" @click="onMenu('logout')" v-html="U.icon('logout') + ' 退出登录'"></div>
    </div>
  </Teleport>
</template>
