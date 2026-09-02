<script>
const pageState = { tab: 'users', selectedId: null, keyword: '', auditModule: '全部模块' };
export default {};
</script>

<script setup>
import { computed, h, ref } from 'vue';
import { NInput, NSelect, NTabs, NTab } from 'naive-ui';
import { usePageChrome } from '../shell/usePageChrome.js';
import { toast } from '../ui/nv.js';
import { openModal, closeModal } from '../ui/modal.js';
import ControlledFormModal from '../ui/modals/ControlledFormModal.vue';

const M = window.MOCK, U = window.UI;
usePageChrome('users');

const bump = ref(0);
const tab = ref(pageState.tab);
const keyword = ref(pageState.keyword);
const auditModule = ref(pageState.auditModule);
const selectedId = ref(pageState.selectedId || M.users[0]?.id || null);
pageState.selectedId = selectedId.value;

const canAdmin = computed(() => { bump.value; return M.can('用户管理', 'auth'); });
const users = computed(() => {
  bump.value;
  const q = keyword.value.trim();
  return M.users.filter(u => !q || u.name.includes(q) || u.account.includes(q) || u.org.includes(q) || u.roleName.includes(q));
});
const selected = computed(() => { bump.value; return M.users.find(u => u.id === selectedId.value) || null; });
const auditModules = computed(() => ['全部模块', ...new Set(M.auditLogs.map(a => a.module))]);
const auditOptions = computed(() => auditModules.value.map(value => ({ label: value, value })));
const audits = computed(() => {
  bump.value;
  return M.auditLogs.filter(a => auditModule.value === '全部模块' || a.module === auditModule.value).slice().reverse();
});
const icon = name => U.icon(name);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function setTab(value) { pageState.tab = value; tab.value = value; }
function selectUser(id) { pageState.selectedId = id; selectedId.value = id; }
function tagRole(user) { return U.tag(esc(user.roleName), user.role === 'R1' ? 't-red' : user.role === 'R2' ? 't-orange' : user.role === 'R5' ? 't-gray' : 't-blue'); }
function tagStatus(user) { return U.tag(esc(user.status), user.status === '正常' ? 't-green' : 't-gray'); }
function userDetail() {
  const u = selected.value;
  if (!u) return '<div class="empty">请选择用户</div>';
  const recent = M.auditLogs.filter(a => a.user === u.name).slice(-5).reverse();
  return `${U.detailHero({ icon: 'user', variant: 'compact', subtitle: '用户管理', title: esc(u.name), id: '@' + esc(u.account),
    tags: [tagRole(u), tagStatus(u)], meta: [['单位', esc(u.org)]] })}
    ${U.metricStrip([
      { label: '账号状态', value: u.status, tone: u.status === '正常' ? 'good' : 'warn', icon: 'user' },
      { label: '双因子认证', value: u.mfa, tone: u.mfa === '已开启' ? 'good' : 'warn', icon: 'shield' },
      { label: '在线状态', value: u.online ? '在线' : '离线', tone: u.online ? 'good' : 'info', icon: 'mon' }
    ], { compact: true })}
    ${U.kv([['所属单位', esc(u.org)], ['联系电话', esc(u.phone)], ['创建时间', esc(u.createdAt)], ['最后登录', esc(u.lastLogin)],
      ['登录 IP', `<span class="mono">${esc(u.lastIp)}</span>`], ['当前角色', tagRole(u)],
      ['反制/干扰授权', M.canForRole(u.role, '反制/干扰授权', 'auth') ? '<span class="tag t-red">可授权（须双人确认）</span>' : '<span class="tag t-gray">无权限</span>']], { surface: true, density: 'compact' })}
    ${U.sect('近期操作（' + recent.length + '）', recent.length ? recent.map(a => `<div class="user-recent-row"><span>${esc(a.action)}</span><span class="mono">${esc(a.time.slice(5, 16))}</span></div>`).join('') : '<div class="empty" style="padding:8px">暂无操作记录</div>')}`;
}
function reviewerChoices() {
  const me = M.currentUser || {};
  return M.users.filter(u => u.id !== me.id && u.status === '正常' && ['R1', 'R2'].includes(u.role))
    .map(u => ({ value: u.id, label: `${u.name} · ${u.roleName} · ${u.org}` }));
}
function roleChoices() {
  return M.ROLES.map(r => ({ value: r.id, label: `${r.name}${r.builtin ? '（系统）' : '（自定义）'}` }));
}
function userForm(user = null) {
  if (!canAdmin.value) return toast('需要「用户管理」授权权限', 'err');
  const editing = !!user;
  openModal({
    title: editing ? '编辑用户' : '新增用户', width: '620px',
    footer: false,
    render: () => h(ControlledFormModal, {
      columns: 2,
      fields: [
        { key: 'account', label: '登录账号', required: true, placeholder: '请输入唯一登录账号' },
        { key: 'name', label: '姓名', required: true, placeholder: '请输入真实姓名' },
        { key: 'role', label: '角色', type: 'select', required: true, clearable: false, options: roleChoices() },
        { key: 'org', label: '所属单位', placeholder: '请输入单位全称' },
        { key: 'phone', label: '手机号', placeholder: '用于 MFA 与告警通知' },
        { key: 'reviewerId', label: '复核人', type: 'select', options: reviewerChoices(), placeholder: '请选择（处置授权人及以上，不可为本人）' }
      ],
      initial: { account: user?.account || '', name: user?.name || '', role: user?.role || M.ROLES[0]?.id || null,
        org: user?.org || '', phone: user?.phone || '', reviewerId: null },
      notice: '新增用户必须复核；编辑现有用户时，仅角色发生变化才要求选择复核人。',
      onCancel: closeModal,
      onSubmit: values => {
      const input = { account: values.account, name: values.name, role: values.role, org: values.org, phone: values.phone };
      const reviewerId = values.reviewerId;
      const result = editing ? M.updateUser(user.id, input, reviewerId) : M.createUser(input, reviewerId);
      if (!result.ok) return toast(result.msg, 'err');
      closeModal(); selectUser(result.user.id); bump.value++;
      toast(editing ? '用户信息已更新并记入审计' : '用户已创建并分配角色', 'ok');
      }
    })
  });
}
function toggleStatus(user) {
  const result = M.setUserStatus(user.id);
  if (!result.ok) return toast(result.msg, 'err');
  bump.value++;
  toast(`账号「${user.account}」已${user.status === '正常' ? '启用' : '停用'}，操作已记入审计`, user.status === '正常' ? 'ok' : 'err');
}
function resetPassword(user) {
  const result = M.resetUserPassword(user.id);
  if (!result.ok) return toast(result.msg, 'err');
  bump.value++;
  toast(`已向 ${user.phone} 下发临时密码，首次登录强制修改`, 'ok');
}
function exportAudit() {
  if (!M.can('日志归档', 'op')) return toast('需要「日志归档」操作权限', 'err');
  const count = audits.value.length;
  M.pushAudit('日志归档', `导出操作审计日志 ${count} 条`, 'AUDIT');
  bump.value++;
  toast(`已导出操作审计日志，共 ${count} 条（Demo）`, 'ok');
}
</script>

<template>
  <div class="view users-view">
    <section class="panel users-panel">
      <header class="ph users-toolbar">
        <n-tabs type="line" size="small" :value="tab" @update:value="setTab" style="width:auto" pane-style="display:none">
          <n-tab name="users">用户列表</n-tab><n-tab name="audit">操作审计</n-tab>
        </n-tabs>
        <span class="spacer"></span>
        <template v-if="tab === 'users'">
          <label class="sr-only" for="userKeyword">搜索用户</label>
          <n-input id="userKeyword" v-model:value="keyword" clearable placeholder="搜索姓名、账号、单位或角色" />
          <button class="btn pri" type="button" :disabled="!canAdmin" @click="userForm(null)" v-html="icon('plus') + ' 新增用户'"></button>
        </template>
        <template v-else>
          <label class="sr-only" for="auditModule">审计模块</label>
          <n-select id="auditModule" v-model:value="auditModule" :options="auditOptions" :clearable="false" />
          <button class="btn" type="button" @click="exportAudit" v-html="icon('download') + ' 导出审计日志'"></button>
        </template>
      </header>

      <div v-if="tab === 'users'" class="users-body">
        <div class="users-table-wrap scroll">
          <table class="tb users-table">
            <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>单位</th><th>状态</th><th>MFA</th><th>最后登录</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-if="!users.length"><td colspan="8"><div class="empty">没有匹配的用户</div></td></tr>
              <tr v-for="user in users" :key="user.id" :class="{ on: selectedId === user.id }" @click="selectUser(user.id)">
                <td class="mono">{{ user.account }}</td><td>{{ user.name }}</td><td v-html="tagRole(user)"></td><td>{{ user.org }}</td>
                <td><span v-html="tagStatus(user)"></span><small class="online-state">{{ user.online ? '在线' : '离线' }}</small></td>
                <td>{{ user.mfa }}</td><td class="mono">{{ user.lastLogin }}</td>
                <td class="user-actions">
                  <button type="button" :disabled="!canAdmin" @click.stop="resetPassword(user)">重置密码</button>
                  <button type="button" :disabled="!canAdmin || user.id === M.currentUser?.id" @click.stop="toggleStatus(user)">{{ user.status === '正常' ? '停用' : '启用' }}</button>
                  <button type="button" :disabled="!canAdmin" @click.stop="userForm(user)">编辑</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <aside class="user-detail" aria-live="polite" v-html="userDetail()"></aside>
      </div>

      <div v-else class="audit-body scroll">
        <table class="tb audit-table">
          <thead><tr><th>时间</th><th>用户</th><th>角色</th><th>模块</th><th>操作内容</th><th>对象</th><th>结果</th><th>IP</th><th>终端</th></tr></thead>
          <tbody>
            <tr v-if="!audits.length"><td colspan="9"><div class="empty">暂无审计记录</div></td></tr>
            <tr v-for="row in audits" :key="row.id"><td class="mono">{{ row.time }}</td><td>{{ row.user }}</td><td>{{ row.role }}</td><td>{{ row.module }}</td><td>{{ row.action }}</td><td class="mono">{{ row.target }}</td><td v-html="U.tag(row.result, row.result === '成功' ? 't-green' : 't-red')"></td><td class="mono">{{ row.ip }}</td><td>{{ row.term }}</td></tr>
          </tbody>
        </table>
        <footer class="audit-foot">审计日志不可修改、不可删除；当前筛选共 {{ audits.length }} 条。</footer>
      </div>
    </section>
  </div>
</template>
