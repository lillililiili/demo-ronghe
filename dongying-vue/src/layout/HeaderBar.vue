<script setup>
/* 顶栏：logo / 时钟 / 大屏按钮 / 用户菜单。
   逻辑逐字移植旧 app.js 的 clock() 与 bindBigScreen()；用户菜单 Teleport 到 body
   （旧版就是 append 到 body 的 .usermenu，CSS 上下文保持一致）。 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useAppStore } from '@/stores/app.js';
import { businessDateTime } from '@/services/businessTime.js';
import { useRouter } from 'vue-router';
import { authUser, changePassword, logout } from '@/services/auth.js';
import { canAccessRoute, hasPermission } from '@/services/accessControl.js';
import { disposalApi } from '@/services/disposalApi.js';
import { readSessionToken } from '@/services/apiClient.js';
import { canSeePendingApprovals, countPendingApprovals, pendingApprovalText } from '@/services/pendingApprovals.js';
import { onDataChange } from '@/services/realtime.js';
import { validatePassword } from '@/services/passwordPolicy.js';
import { toast } from '@/ui/nv.js';
import { closeModal, openModal } from '@/ui/modal.js';
import { openFormModal } from '@/ui/formModal.js';
import { DATA_SCOPE_LABEL } from '@/ui/labels.js';

const store = useAppStore();
const router = useRouter();
const U = window.UI;
const currentUser = computed(() => authUser.value || { name: '用户', account: '—', role_name: '—', org_name: '—' });
const avatarText = computed(() => currentUser.value.name.slice(-1));
const canBigscreen = computed(() => canAccessRoute('bigscreen'));

/* ---------- 时钟：本地墙钟，不再使用 Mock 演示基准时刻 ---------- */
function formatClock(date) {
  return businessDateTime(date);
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
  onFsChange();
}
function onFsChange() {
  // 视频自己的全屏不改变整页布局；退出视频后也按浏览器实际元素恢复。
  const on = document.fullscreenElement === document.documentElement;
  const changed = store.bigscreen !== on || document.body.classList.contains('bigscreen') !== on;
  document.body.classList.toggle('bigscreen', on);
  store.bigscreen = on;
  if (changed) window.dispatchEvent(new Event('resize'));
}

/* ---------- 待我审批：有审批权限的账号在顶栏看到待审批数量，点开直达“反制办理 → 待我处理” ---------- */
const approvalVisible = computed(() => !!authUser.value && canSeePendingApprovals(hasPermission, canAccessRoute));
const approvals = ref(null);
const approvalLabel = computed(() => pendingApprovalText(approvals.value));
const APPROVAL_POLL_MS = 15_000;
let approvalTimer = null, approvalSeq = 0, approvalRunning = false, stopApprovalSignal = null;
async function refreshApprovals() {
  if (!approvalVisible.value) { approvals.value = null; return; }
  if (approvalRunning || document.hidden) return;
  const seq = ++approvalSeq, token = readSessionToken(), userId = authUser.value?.user_id;
  approvalRunning = true;
  try {
    const result = await countPendingApprovals(disposalApi.list, userId,
      () => seq === approvalSeq && token === readSessionToken() && userId === authUser.value?.user_id);
    if (result) approvals.value = result;
  } catch { /* 读取失败保留上次数字，下次定时再读；不弹错误打扰值班。 */ }
  finally { approvalRunning = false; }
}
function openApprovals() {
  router.push({ path: '/alarms', query: { tab: 'authorizations', view: 'pending', at: String(Date.now()) } });
}
function onVisible() { if (!document.hidden) void refreshApprovals(); }

/* ---------- 用户菜单：个人信息、修改密码与退出登录 ---------- */
const menuOpen = ref(false);
function toggleMenu(e) {
  e.stopPropagation();
  menuOpen.value = !menuOpen.value;
}
function closeMenu() { menuOpen.value = false; }

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
/* 个人信息只读展示，不在业务前台填写或保存资料。 */
function openProfile() {
  const u = currentUser.value;
  const info = [['账号', u.account], ['姓名', u.name], ['联系电话', u.phone || '未设置'],
    ['角色', u.role_name], ['所属单位', u.org_name || '未设置'], ['数据范围', DATA_SCOPE_LABEL[u.data_scope]]]
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value || '—')}</dd>`).join('');
  openModal({
    title: '个人信息', width: '480px',
    body: `<dl class="kv">${info}</dl>`
  });
}
/* 主动修改密码。当前密码输错由服务端按表单错误返回，留在弹窗里提示，不会退出登录（ZT-28）。 */
function openPasswordChange() {
  openFormModal({
    title: '修改密码', width: '480px',
    fields: [
      { key: 'current', label: '当前密码', type: 'password', required: true, inputProps: { autocomplete: 'current-password', maxlength: 128 } },
      { key: 'next', label: '新密码', type: 'password', required: true, help: '6–32 位，包含大小写字母、数字和特殊字符，且不能包含账号。',
        inputProps: { autocomplete: 'new-password', maxlength: 32 } },
      { key: 'confirm', label: '确认新密码', type: 'password', required: true, inputProps: { autocomplete: 'new-password', maxlength: 32 } }
    ],
    initial: { current: '', next: '', confirm: '' },
    notice: '修改成功后，这个账号在所有地方的登录都会失效，需要用新密码重新登录。',
    confirmText: '修改密码',
    validate: ({ next, confirm }) => next !== confirm ? '两次输入的新密码不一致。' : validatePassword(next, currentUser.value.account, '新密码'),
    onSubmit: async ({ current, next }) => {
      try { await changePassword(current, next); }
      catch (error) {
        if (error.status === 401) throw new Error('登录已过期，这次修改没有保存。重新登录后请再提交一次。');
        throw error;
      }
      closeModal();
      await router.replace('/login');
      toast('密码已修改，请用新密码重新登录', 'ok');
    }
  });
}
async function onMenu(k) {
  closeMenu();
  if (k === 'me') openProfile();
  else if (k === 'password') openPasswordChange();
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
  onFsChange();
  document.addEventListener('click', closeMenu);
  approvalTimer = setInterval(() => { void refreshApprovals(); }, APPROVAL_POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
});
// 有人申请或审批后服务端会推送 disposal 变化，顶栏立即重数；只有能审批的账号才订阅。
watch(approvalVisible, visible => {
  ++approvalSeq; approvals.value = null;
  if (typeof stopApprovalSignal === 'function') stopApprovalSignal();
  stopApprovalSignal = visible ? onDataChange(['disposal'], () => { void refreshApprovals(); }) : null;
  void refreshApprovals();
}, { immediate: true });
onBeforeUnmount(() => {
  // 阶段 12：search.js 已删除，window.SEARCH 不再存在，这行随之移除。
  clearInterval(clkTimer);
  clearInterval(approvalTimer);
  ++approvalSeq;
  document.removeEventListener('visibilitychange', onVisible);
  if (typeof stopApprovalSignal === 'function') stopApprovalSignal();
  document.removeEventListener('fullscreenchange', onFsChange);
  document.removeEventListener('click', closeMenu);
  document.body.classList.remove('bigscreen');
  store.bigscreen = false;
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
      <span v-if="approvalVisible && approvalLabel" class="it"><button class="btn pending-approval" type="button" title="有反制申请等你审批，点击打开“告警事件 → 反制办理 → 待我处理”" @click="openApprovals"><span class="pending-dot" aria-hidden="true"></span>{{ approvalLabel }}</button></span>
      <span class="it" id="clk" v-html="clkHtml"></span>
      <span v-if="canBigscreen" class="it"><router-link class="btn ghost" id="btnScreen" to="/bigscreen" title="进入低空安全数据大屏" v-html="screenLabel"></router-link></span>
      <span class="it"><button class="btn ghost" id="btnBig" title="全屏模式：放大字号与行距，适配指挥大厅显示" v-html="bigLabel" @click="toggleBig"></button></span>
      <button class="user icon-btn" type="button" aria-haspopup="menu" :aria-expanded="String(menuOpen)" @click="toggleMenu"><span class="av">{{ avatarText }}</span><span>{{ currentUser.name }}</span><svg class="chev-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg></button>
    </div>
  </header>
  <Teleport to="body">
    <div class="usermenu" :class="{ open: menuOpen }" @click.stop>
      <div class="mi" data-um="me" @click="onMenu('me')" v-html="U.icon('user') + ' 个人信息'"></div>
      <div class="mi" data-um="password" @click="onMenu('password')" v-html="U.icon('lock') + ' 修改密码'"></div>
      <div class="sep"></div>
      <div class="mi" data-um="logout" @click="onMenu('logout')" v-html="U.icon('logout') + ' 退出登录'"></div>
    </div>
  </Teleport>
</template>

<style scoped>
.pending-approval{display:inline-flex;align-items:center;gap:7px;border-color:var(--amber,#ffb020);color:var(--amber,#ffb020);background:rgba(255,176,32,.12);font-weight:600}
.pending-approval:hover{background:rgba(255,176,32,.22)}
.pending-approval:focus-visible{outline:2px solid var(--amber,#ffb020);outline-offset:2px}
.pending-dot{width:8px;height:8px;border-radius:50%;background:var(--amber,#ffb020);box-shadow:0 0 0 0 rgba(255,176,32,.6);animation:pending-pulse 1.6s ease-out infinite}
@keyframes pending-pulse{0%{box-shadow:0 0 0 0 rgba(255,176,32,.6)}100%{box-shadow:0 0 0 8px rgba(255,176,32,0)}}
@media (prefers-reduced-motion:reduce){.pending-dot{animation:none}}
</style>
