<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { NButton, NDataTable, NDropdown, NSpin, NTag } from 'naive-ui';
import { UField } from '@/components/form/index.js';
import UPagination from '@/components/UPagination.vue';
import ControlledFormModal from '@/components/modals/ControlledFormModal.vue';
import OrgTreePanel from './system/OrgTreePanel.vue';
import UserEditorModal from './system/UserEditorModal.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { hasPermission } from '@/services/accessControl.js';
import { validateTemporaryPassword } from '@/services/passwordPolicy.js';
import { systemApi } from '@/services/systemAdmin.js';
import { closeModal, openModal } from '@/ui/modal.js';
import { dialog, toast } from '@/ui/nv.js';

usePageChrome('users');
const ALL_KEY = '__all__';
const loading = ref(false);
const error = ref('');
const keyword = ref('');
const statusFilter = ref(null);
const roleFilter = ref(null);
const users = ref([]);
const roles = ref([]);
const organizations = ref([]);
const selectedOrgId = ref(null);
const page = ref(1);
const size = ref(20);
const total = ref(0);
const canOperate = computed(() => hasPermission('users.op'));
const roleOptions = computed(() => roles.value.map(x => ({ value: x.role_code, label: x.name })));
const statusOptions = [{ value: 'ACTIVE', label: '启用' }, { value: 'DISABLED', label: '停用' }];
const selectedOrg = computed(() => organizations.value.find(x => x.org_id === selectedOrgId.value) || null);
const selectedOrgKey = computed(() => selectedOrgId.value || ALL_KEY);
const createOrgId = computed(() => {
  const org = selectedOrg.value;
  return org?.enabled ? org.org_id : null;
});

function newOrgCode() {
  const raw = globalThis.crypto?.randomUUID?.() || `${Date.now()}`;
  return `ORG-${raw.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
function dt(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未登录'; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function statusText(value) { return value === 'ACTIVE' ? '启用' : '停用'; }
function isAdmin(user) { return user?.role_code === 'ROLE-ADMIN'; }

async function loadCatalog() {
  const [roleRows, orgRows] = await Promise.all([systemApi.roles(), systemApi.organizations()]);
  roles.value = roleRows;
  organizations.value = orgRows;
  if (selectedOrgId.value && !organizations.value.some(x => x.org_id === selectedOrgId.value)) selectedOrgId.value = null;
}

async function loadUsers() {
  loading.value = true;
  error.value = '';
  try {
    const result = await systemApi.users({
      keyword: keyword.value.trim(),
      status: statusFilter.value,
      roleCode: roleFilter.value,
      orgId: selectedOrgId.value,
      page: page.value,
      size: size.value
    });
    users.value = result.items;
    total.value = result.total;
  } catch (e) { error.value = e.message || '用户列表加载失败。'; }
  finally { loading.value = false; }
}

async function refreshAll() {
  loading.value = true;
  error.value = '';
  try { await loadCatalog(); await loadUsers(); }
  catch (e) { error.value = e.message || '系统管理数据加载失败。'; loading.value = false; }
}

function queryUsers() { page.value = 1; loadUsers(); }
function resetQuery() {
  keyword.value = '';
  statusFilter.value = null;
  roleFilter.value = null;
  page.value = 1;
  loadUsers();
}
watch(selectedOrgId, () => { page.value = 1; loadUsers(); });

function openUser(mode, user = null) {
  openModal({
    title: mode === 'create' ? '新增用户' : `编辑资料 · ${esc(user.name)}`,
    width: '600px', footer: false,
    render: () => h(UserEditorModal, {
      mode, user, roles: roles.value, organizations: organizations.value, defaultOrgId: createOrgId.value,
      onCancel: closeModal,
      onSubmit: async payload => {
        if (mode === 'create') await systemApi.createUser(payload);
        else await systemApi.updateUser(user.user_id, payload);
        closeModal();
        await loadUsers();
        const roleChanged = mode === 'profile' && payload.role_code && payload.role_code !== user.role_code;
        toast(mode === 'create' ? '用户已创建并立即生效'
          : roleChanged ? '用户资料已保存，角色已更新并撤销旧会话'
          : '用户资料已保存', 'ok');
      }
    })
  });
}

function resetPassword(user) {
  openModal({
    title: `重置密码 · ${esc(user.account)}`, width: '520px', footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'temporary_password', label: '临时密码', type: 'password', required: true,
        help: '6–32 位，包含大小写字母、数字和特殊字符。', inputProps: { minlength: 6, maxlength: 32, autocomplete: 'new-password' } }],
      initial: { temporary_password: '' }, warning: '重置后该用户的所有会话立即失效，下次登录必须修改密码。',
      confirmText: '重置密码', onCancel: closeModal,
      validate: values => validateTemporaryPassword(values.temporary_password, user.account),
      onSubmit: async values => {
        await systemApi.resetPassword(user.user_id, { ...values, expected_version: user.version });
        closeModal(); await loadUsers(); toast('临时密码已设置，请通过安全渠道交付给用户。', 'ok');
      }
    })
  });
}

function toggleUser(user) {
  const enabling = user.status !== 'ACTIVE';
  dialog.warning({
    title: enabling ? '启用账号' : '停用账号',
    content: enabling ? `确认启用账号“${user.account}”？` : `停用后“${user.account}”的现有会话将立即失效。`,
    positiveText: '确认', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await systemApi.setUserStatus(user.user_id, { status: enabling ? 'ACTIVE' : 'DISABLED', expected_version: user.version });
        await loadUsers(); toast(`账号已${enabling ? '启用' : '停用'}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
  });
}

function deleteUser(user) {
  if (!user || isAdmin(user)) return;
  openModal({
    title: `删除用户 · ${esc(user.name)}`,
    width: '540px',
    footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'reason', label: '删除原因', type: 'textarea', required: true, minRows: 4 }],
      initial: { reason: '' },
      warning: `账号“${user.account}”将被逻辑删除并立即退出登录。旧用户及历史审计仍会保留；之后可用相同登录账号重新创建一个新用户。`,
      danger: true,
      confirmText: '确认逻辑删除',
      onCancel: closeModal,
      onSubmit: async ({ reason }) => {
        await systemApi.deleteUser(user.user_id, user.version, reason);
        closeModal();
        await loadUsers();
        await loadCatalog();
        toast('用户已逻辑删除，相关会话已撤销', 'ok');
      }
    })
  });
}

function moreOptions(user) {
  const locked = !canOperate.value || isAdmin(user);
  return [
    { label: '重置密码', key: 'reset', disabled: locked },
    { label: user.status === 'ACTIVE' ? '停用' : '启用', key: 'toggle', disabled: locked }
  ];
}

function onMore(key, user) {
  if (key === 'reset') resetPassword(user);
  else if (key === 'toggle') toggleUser(user);
}

function openOrgModal(row = null, parent = null) {
  const addingChild = !row && !!parent;
  const parentId = row ? row.parent_id : parent?.org_id || null;
  const parentField = {
    key: 'parent_id', label: '上级组织', type: 'select', clearable: true,
    options: organizations.value.filter(x => x.org_id !== row?.org_id && x.enabled)
      .map(x => ({ value: x.org_id, label: x.name }))
  };
  openModal({
    title: row ? '编辑组织' : addingChild ? `新增下级组织 · ${esc(parent.name)}` : '新增组织',
    width: '520px', footer: false,
    render: () => h(ControlledFormModal, {
      fields: [
        { key: 'name', label: '组织名称', required: true },
        ...(addingChild ? [] : [parentField])
      ],
      initial: { name: row?.name || '', parent_id: parentId },
      onCancel: closeModal,
      onSubmit: async values => {
        const nextParentId = addingChild ? parent.org_id : values.parent_id;
        if (row) await systemApi.updateOrganization(row.org_id, {
          name: values.name, parent_id: nextParentId, expected_version: row.version
        });
        else await systemApi.createOrganization({
          name: values.name, parent_id: nextParentId, org_code: newOrgCode()
        });
        closeModal();
        await loadCatalog();
        await loadUsers();
        toast('组织已保存', 'ok');
      }
    })
  });
}

function deleteOrg(row) {
  if (!row || !canOperate.value) return;
  dialog.warning({
    title: '删除组织',
    content: `确认删除组织“${row.name}”？仍被用户或下级组织引用时不能删除。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await systemApi.setOrganizationStatus(row.org_id, { enabled: false, expected_version: row.version });
        if (selectedOrgId.value === row.org_id) selectedOrgId.value = null;
        await loadCatalog();
        toast('组织已删除', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
  });
}

function onPageSize(value) {
  size.value = value;
  page.value = 1;
  loadUsers();
}

const userColumns = computed(() => [
  { title: '账号', key: 'account', width: 140, ellipsis: { tooltip: true }, render: row => h('span', { class: 'mono' }, row.account) },
  { title: '姓名', key: 'name', width: 110, ellipsis: { tooltip: true } },
  { title: '角色', key: 'role_name', width: 130, ellipsis: { tooltip: true } },
  { title: '组织', key: 'org_name', width: 160, ellipsis: { tooltip: true }, render: row => row.org_name || '—' },
  { title: '状态', key: 'status', width: 88, render: row => h(NTag, { size: 'small', type: row.status === 'ACTIVE' ? 'success' : 'default', bordered: false }, { default: () => statusText(row.status) }) },
  { title: '最后登录', key: 'last_login_at', width: 170, render: row => h('span', { class: 'mono' }, dt(row.last_login_at)) },
  { title: '操作', key: 'actions', width: 210, render: row => h('div', { class: 'table-actions' }, [
    h(NButton, { text: true, type: 'primary', disabled: !canOperate.value, onClick: () => openUser('profile', row) }, { default: () => '修改' }),
    h(NButton, { text: true, type: 'error', disabled: !canOperate.value || isAdmin(row), title: isAdmin(row) ? '唯一超级管理员不能删除' : '逻辑删除该用户', onClick: () => deleteUser(row) }, { default: () => '删除' }),
    h(NDropdown, { trigger: 'click', options: moreOptions(row), onSelect: key => onMore(key, row) }, {
      default: () => h(NButton, { text: true, disabled: !canOperate.value || isAdmin(row) }, { default: () => '更多' })
    })
  ]) }
]);

onMounted(refreshAll);
</script>

<template>
  <div class="view users-api-view">
    <section class="panel users-manage-panel">
      <p v-if="error" class="system-error" role="alert">{{ error }} <button type="button" @click="refreshAll">重试</button></p>
      <div class="users-manage">
        <OrgTreePanel
          :organizations="organizations"
          :selected-key="selectedOrgKey"
          :can-operate="canOperate"
          @select="selectedOrgId = $event"
          @create="parent => openOrgModal(null, parent)"
          @edit="openOrgModal"
          @delete="deleteOrg"
        />
        <div class="user-pane">
          <form class="users-filter" @submit.prevent="queryUsers">
            <UField v-model="keyword" variant="toolbar" label="用户" clearable placeholder="账号、姓名或联系电话" />
            <UField v-model="roleFilter" variant="toolbar" label="角色" type="select" clearable :options="roleOptions" placeholder="请选择角色" />
            <UField v-model="statusFilter" variant="toolbar" label="状态" type="select" clearable :options="statusOptions" placeholder="全部状态" />
            <n-button type="primary" attr-type="submit">查询</n-button>
            <n-button attr-type="button" @click="resetQuery">重置</n-button>
          </form>
          <div class="users-actions">
            <n-button type="primary" :disabled="!canOperate" @click="openUser('create')">新增用户</n-button>
            <span class="users-scope">{{ selectedOrg ? `当前组织：${selectedOrg.name}` : '当前范围：全部组织' }}</span>
            <n-button quaternary @click="refreshAll">刷新</n-button>
          </div>
          <n-spin class="users-table-spin" :show="loading">
            <div class="naive-table-fill">
              <n-data-table :columns="userColumns" :data="users" :row-key="row => row.user_id" :bordered="false" :single-line="true" size="small" flex-height :scroll-x="1000" />
            </div>
            <footer class="pager-row">
              <span>共 {{ total }} 条</span>
              <UPagination v-model:page="page" v-model:page-size="size" :item-count="total" @update:page="loadUsers" @update:page-size="onPageSize" />
            </footer>
          </n-spin>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.users-api-view { display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.users-manage-panel { display:flex; flex:1; min-height:0; flex-direction:column; overflow:hidden; }
.users-manage { display:flex; flex:1; min-height:0; }
.users-manage :deep(.org-pane) { flex:0 0 280px; }
.user-pane { display:flex; flex:1; min-width:0; flex-direction:column; }
.users-filter { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; padding:14px 16px 10px; border-bottom:1px solid var(--line); }
.users-filter .u-field { width:min(240px, 100%); }
.users-actions { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); }
.users-scope { margin-right:auto; color:var(--txt-3); font-size:13px; }
.users-table-spin { display:flex; flex:1; min-height:0; flex-direction:column; }
.users-table-spin :deep(.n-spin-container), .users-table-spin :deep(.n-spin-content) { display:flex; flex:1; min-height:0; flex-direction:column; overflow:hidden; }
.system-error { margin:12px 16px 0; padding:11px 13px; border:1px solid var(--red); border-radius:6px; color:var(--red); background:color-mix(in srgb, var(--red) 10%, transparent); }
.system-error button { margin-left:8px; }
@media (max-width:900px) {
  .users-manage { flex-direction:column; overflow:auto; }
  .users-manage :deep(.org-pane) { flex:none; width:100%; max-width:none; resize:none; border-right:0; border-bottom:1px solid var(--line); max-height:240px; }
}
</style>
