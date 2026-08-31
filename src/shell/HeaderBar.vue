<script setup>
/* 顶栏：logo / 时钟 / 天气 / 大屏按钮 / 告警铃铛 / 用户菜单。
   逻辑逐字移植旧 app.js 的 clock() 与 bindBigScreen()；用户菜单 Teleport 到 body
   （旧版就是 append 到 body 的 .usermenu，CSS 上下文保持一致）。 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '../stores/app.js';
import { carouselDlg } from './useCarousel.js';
import { toast } from '../ui/nv.js';
import { openModal, closeModal } from '../ui/modal.js';

const store = useAppStore();
const M = window.MOCK, U = window.UI;

/* ---------- 时钟（平台当前时刻只有一个来源：M.now()） ---------- */
let clkTimer = null;
const tick = () => { store.timeStr = M.nowStr(); };
tick();
const clkHtml = computed(() => `${U.icon('clock')} ${store.timeStr}`);
const weaHtml = `${M.CONF.city} ${U.icon('cloud')} ${M.CONF.weather.tempLo}℃ ~ ${M.CONF.weather.tempHi}℃ ${M.CONF.weather.text}`;
const bellN = M.todayStats.pendingAlarm + M.todayStats.disposing;

/* ---------- 大屏展示（监控预览专版，bigscreen.html 单独窗口）----------
   入口是 <a target="dy-bigscreen"> 而非 window.open：用户手点的链接不吃弹窗拦截，
   命名 target 让反复点击复用同一个窗口。 */
const screenLabel = `${U.icon('mon')} 大屏展示`;

/* ---------- 大屏模式 ---------- */
const bigLabel = computed(() => `${U.icon('fullscreen')} ${store.bigscreen ? '退出大屏' : '大屏'}`);
function toggleBig() {
  const on = document.body.classList.toggle('bigscreen');
  store.bigscreen = on;
  if (on && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => { });
  } else if (!on && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => { });
  }
  window.dispatchEvent(new Event('resize'));
  toast(on ? '已进入大屏模式（字号放大，适配指挥大厅）' : '已退出大屏模式', 'ok');
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
  else if (k === 'carousel') carouselDlg();
  else if (k === 'me') openModal({
    title: '个人信息', width: '440px',
    body: U.kv([['账号', 'admin'], ['姓名', '系统管理员'], ['角色', '超级管理员'],
    ['所属单位', '东营市低空安全管理中心'], ['双因子认证', '已开启'],
    ['最后登录', M.util.fmtDT(M.CONF.demoTime)], ['登录 IP', '10.20.1.15']])
  });
  else toast('已退出登录(Demo 环境不跳转登录页)', 'ok');
}

onMounted(() => {
  clkTimer = setInterval(tick, 1000);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('click', closeMenu);
});
onBeforeUnmount(() => {
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
      <span class="it" id="wea" v-html="weaHtml"></span>
      <span class="it"><a class="btn ghost" id="btnScreen" href="bigscreen.html" target="dy-bigscreen" title="监控预览专版大屏：单独窗口打开，可拖至大屏独立部署显示" v-html="screenLabel"></a></span>
      <span class="it"><button class="btn ghost" id="btnBig" title="大屏模式：放大字号与行距，适配指挥大厅显示" v-html="bigLabel" @click="toggleBig"></button></span>
      <button class="it bell icon-btn" id="bell" type="button" aria-label="查看告警" @click="goAlarms">
        <svg class="hdr-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        <span class="dot" id="bellN">{{ bellN }}</span>
      </button>
      <button class="user icon-btn" type="button" aria-haspopup="menu" :aria-expanded="String(menuOpen)" @click="toggleMenu"><span class="av">管</span><span>管理员</span><svg class="chev-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>
    </div>
  </header>
  <Teleport to="body">
    <div class="usermenu" :class="{ open: menuOpen }" @click.stop>
      <div class="mi" data-um="me" @click="onMenu('me')" v-html="U.icon('user') + ' 个人信息'"></div>
      <div class="mi" data-um="ops" @click="onMenu('ops')" v-html="U.icon('settings') + ' 运维管理'"></div>
      <div class="mi" data-um="users" @click="onMenu('users')" v-html="U.icon('shield') + ' 用户与权限'"></div>
      <div class="mi" data-um="carousel" @click="onMenu('carousel')" v-html="U.icon('play') + ' 大屏轮播'"></div>
      <div class="sep"></div>
      <div class="mi" data-um="logout" @click="onMenu('logout')" v-html="U.icon('logout') + ' 退出登录'"></div>
    </div>
  </Teleport>
</template>
