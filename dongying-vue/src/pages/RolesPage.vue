<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { NButton, NCheckbox, NDataTable, NSpin } from 'naive-ui';
import { UField } from '@/components/form/index.js';
import ControlledFormModal from '@/components/modals/ControlledFormModal.vue';
import RoleCreateModal from './system/RoleCreateModal.vue';
import { menuLabelOf, withSystemPermissionsLast } from './system/permissionOrder.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { hasPermission } from '@/services/accessControl.js';
import { systemApi } from '@/services/systemAdmin.js';
import { closeModal, openModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';

usePageChrome('roles');
const loading = ref(false);
const error = ref('');
const query = ref('');
const roles = ref([]);
const catalog = ref([]);
const selectedCode = ref(null);
const roleDetail = ref(null);
const draft = ref([]);
const canOperate = computed(() => hasPermission('roles.auth'));
const protectedCodes = new Set(['users', 'roles', 'audit', 'countermeasure']);
const roleList = computed(() => {
  const q = query.value.trim().toLowerCase();
  return roles.value.filter(item => !q || item.name.toLowerCase().includes(q)
    || item.role_code.toLowerCase().includes(q) || (item.description || '').toLowerCase().includes(q));
});
const visibleDraft = computed(() => withSystemPermissionsLast(draft.value.filter(item => Boolean(item.route_key))));
const isLocked = computed(() => roleDetail.value?.role_code === 'ROLE-ADMIN');
const isDirty = computed(() => roleDetail.value && JSON.stringify(draft.value) !== JSON.stringify(roleDetail.value.permissions));
const levelOptions = [
  { value: 'NONE', label: '无权限' }, { value: 'READ', label: '查看' },
  { value: 'OP', label: '操作' }, { value: 'AUTH', label: '授权' }
];

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function permissionLocked(item) { return isLocked.value || protectedCodes.has(item.permission_code); }
function setLevel(item, value) { item.level = value; if (value === 'NONE') item.menu_enabled = false; }
function setMenu(item, value) { item.menu_enabled = value; if (value && item.level === 'NONE') item.level = 'READ'; }
function discard() { draft.value = roleDetail.value.permissions.map(item => ({ ...item })); toast('已放弃未保存的权限改动', 'ok'); }
function limitText(item) {
  if (!isLocked.value && protectedCodes.has(item.permission_code)) return '仅超级管理员';
  return isLocked.value ? '固定权限' : '可配置';
}
const permissionColumns = computed(() => [
  { title: '权限编码', key: 'permission_code', width: 150, render: row => h('span', { class: 'mono' }, row.permission_code) },
  { title: '菜单入口', key: 'route_key', width: 180, render: row => h(NCheckbox, {
    checked: row.menu_enabled, disabled: permissionLocked(row), 'onUpdate:checked': value => setMenu(row, value)
  }, { default: () => menuLabelOf(row.route_key) }) },
  { title: '权限等级', key: 'level', width: 150, render: row => h(UField, {
    modelValue: row.level, type: 'select', label: '权限等级', srOnly: true, options: levelOptions,
    disabled: permissionLocked(row), 'onUpdate:modelValue': value => setLevel(row, value)
  }) },
  { title: '限制', key: 'limit', width: 130, render: row => (!isLocked.value && protectedCodes.has(row.permission_code)
    ? h('span', { class: 'locked-note' }, '仅超级管理员') : limitText(row)) }
]);

async function loadRoles() {
  roles.value = await systemApi.roles();
  if (!roles.value.some(item => item.role_code === selectedCode.value)) {
    selectedCode.value = roles.value.find(item => item.role_code === 'ROLE-ADMIN')?.role_code || roles.value[0]?.role_code || null;
  }
}
async function loadRole(code = selectedCode.value) {
  if (!code) { roleDetail.value = null; draft.value = []; return; }
  loading.value = true;
  error.value = '';
  try {
    roleDetail.value = await systemApi.role(code);
    draft.value = roleDetail.value.permissions.map(item => ({ ...item }));
  } catch (e) { error.value = e.message || '角色详情加载失败。'; }
  finally { loading.value = false; }
}
async function loadAll() {
  loading.value = true;
  error.value = '';
  try { [catalog.value] = await Promise.all([systemApi.permissions(), loadRoles()]); await loadRole(); }
  catch (e) { error.value = e.message || '角色管理数据加载失败。'; }
  finally { loading.value = false; }
}
watch(selectedCode, code => { if (code) loadRole(code); });

function savePermissions() {
  if (!isDirty.value) return toast('没有需要保存的权限改动', 'err');
  openModal({
    title: `保存权限 · ${esc(roleDetail.value.name)}`, width: '560px', footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'reason', label: '操作原因', type: 'textarea', required: true, minRows: 4 }],
      initial: { reason: '' },
      warning: '权限保存后立即生效；该角色下所有用户的旧会话会被撤销，需要重新登录。',
      confirmText: '保存并立即生效', onCancel: closeModal,
      onSubmit: async ({ reason }) => {
        const saved = await systemApi.updateRolePermissions(roleDetail.value.role_code, {
          expected_version: roleDetail.value.version, reason,
          permissions: draft.value.map(item => ({ permission_code: item.permission_code, level: item.level, menu_enabled: item.menu_enabled }))
        });
        closeModal(); roleDetail.value = saved; draft.value = saved.permissions.map(item => ({ ...item }));
        await loadRoles(); toast('角色权限已立即生效，相关旧会话已撤销', 'ok');
      }
    })
  });
}

function createRole() {
  openModal({
    title: '新增自定义角色', width: '900px', footer: false,
    render: () => h(RoleCreateModal, {
      catalog: catalog.value, onCancel: closeModal,
      onSubmit: async payload => {
        const saved = await systemApi.createRole(payload);
        closeModal(); await loadRoles(); selectedCode.value = saved.role_code; await loadRole(saved.role_code);
        toast('角色及初始权限已创建并立即生效', 'ok');
      }
    })
  });
}

function editDescription() {
  const role = roleDetail.value;
  if (!role || role.builtin) return;
  openModal({
    title: `编辑角色说明 · ${esc(role.name)}`, width: '540px', footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'description', label: '角色说明', type: 'textarea', minRows: 4 }],
      initial: { description: role.description || '' }, onCancel: closeModal,
      onSubmit: async values => {
        const saved = await systemApi.updateRole(role.role_code, { description: values.description, expected_version: role.version });
        closeModal(); await loadRoles(); await loadRole(saved.role_code); toast('角色说明已保存', 'ok');
      }
    })
  });
}

function deleteRole() {
  const role = roleDetail.value;
  if (!role || role.builtin) return;
  openModal({
    title: `删除角色 · ${esc(role.name)}`, width: '540px', footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'reason', label: '删除原因', type: 'textarea', required: true, minRows: 4 }],
      initial: { reason: '' },
      warning: role.user_count ? `该角色仍有 ${role.user_count} 名用户，必须先调整用户角色。` : '删除会立即生效并记录审计日志，此操作不可撤销。',
      danger: true, confirmText: '确认删除', submitEnabled: () => role.user_count === 0, onCancel: closeModal,
      onSubmit: async ({ reason }) => {
        await systemApi.deleteRole(role.role_code, role.version, reason);
        closeModal(); selectedCode.value = 'ROLE-ADMIN'; await loadRoles(); await loadRole(); toast('角色已删除', 'ok');
      }
    })
  });
}

onMounted(loadAll);
</script>

<template>
  <div class="view roles-api-view">
    <section class="panel roles-api-panel">
      <header class="ph roles-api-header">
        <div><h2>角色与权限</h2><p>超级管理员固定拥有全部权限；其他角色按业务需要即时配置。</p></div>
        <span class="spacer"></span><n-button type="primary" :disabled="!canOperate" @click="createRole">新增角色</n-button>
      </header>
      <p v-if="error" class="system-error" role="alert">{{ error }} <button type="button" @click="loadAll">重试</button></p>
      <n-spin :show="loading">
        <div class="role-api-body">
          <aside class="role-api-list">
            <UField v-model="query" variant="toolbar" label="搜索角色" sr-only clearable placeholder="搜索名称、编码或说明" />
            <button v-for="role in roleList" :key="role.role_code" type="button" :class="{ on: selectedCode === role.role_code }" @click="selectedCode = role.role_code">
              <strong>{{ role.name }}</strong><span class="mono">{{ role.role_code }}</span><small>{{ role.user_count }} 名用户 · {{ role.builtin ? '内置' : '自定义' }}</small>
            </button>
          </aside>
          <main v-if="roleDetail" class="role-api-detail">
            <header class="role-summary">
              <div><h2>{{ roleDetail.name }} <span v-if="roleDetail.builtin" class="tag t-blue">唯一内置</span></h2><p>{{ roleDetail.description || '暂无角色说明' }}</p></div>
              <div v-if="!roleDetail.builtin" class="role-summary-actions">
                <div><n-button :disabled="!canOperate" @click="editDescription">编辑说明</n-button><n-button type="error" ghost :disabled="!canOperate || roleDetail.user_count > 0" :title="roleDetail.user_count > 0 ? `仍有 ${roleDetail.user_count} 名用户，需先调整其角色` : '删除该自定义角色'" @click="deleteRole">删除角色</n-button></div>
                <small v-if="roleDetail.user_count > 0" class="delete-note">仍有 {{ roleDetail.user_count }} 名用户，需先调整其角色才能删除</small>
              </div>
            </header>
            <div class="naive-table-fill permission-table-wrap">
              <n-data-table :columns="permissionColumns" :data="visibleDraft" :row-key="row => row.permission_code" :bordered="false" :single-line="true" size="small" flex-height :scroll-x="720" />
            </div>
            <footer class="permission-footer"><span>{{ isDirty ? '有尚未保存的权限改动' : '当前显示已生效权限' }}</span><n-button :disabled="!isDirty" @click="discard">放弃改动</n-button><n-button type="primary" :disabled="!canOperate || !isDirty || isLocked" @click="savePermissions">保存并立即生效</n-button></footer>
          </main>
          <div v-else class="empty">请选择角色</div>
        </div>
      </n-spin>
    </section>
  </div>
</template>

<style scoped>
.roles-api-view { display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.roles-api-panel { display:flex; flex:1; min-height:0; flex-direction:column; overflow:hidden; }
.roles-api-header, .role-summary, .permission-footer { display:flex; flex:none; align-items:center; gap:12px; }
.roles-api-header h1, .roles-api-header p { margin:0; }.roles-api-header p { margin-top:5px; color:var(--txt-3); }
.roles-api-panel :deep(.n-spin-container), .roles-api-panel :deep(.n-spin-content) { display:flex; flex:1; min-height:0; flex-direction:column; overflow:hidden; }
.role-api-body { display:grid; grid-template-columns:270px minmax(0, 1fr); flex:1; min-height:0; overflow:hidden; }
.role-api-list { display:flex; flex-direction:column; gap:8px; min-height:0; overflow:auto; padding:14px; border-right:1px solid var(--line); }
.role-api-list > button { display:grid; gap:5px; width:100%; padding:12px; border:1px solid transparent; border-radius:7px; text-align:left; color:var(--txt); background:transparent; cursor:pointer; }
.role-api-list > button:hover, .role-api-list > button.on { border-color:var(--blue); background:color-mix(in srgb, var(--blue) 12%, transparent); }
.role-api-list span, .role-api-list small, .locked-note { color:var(--txt-3); }
.role-api-detail { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; padding:18px; }
.role-summary { justify-content:space-between; align-items:flex-start; }
.role-summary h2, .role-summary p { margin:0; }.role-summary p { margin-top:7px; color:var(--txt-3); }
.role-summary-actions { display:grid; justify-items:end; gap:6px; }.role-summary-actions > div { display:flex; gap:8px; }
.delete-note { color:var(--orange, #f4a261); }
.permission-table-wrap { margin-top:14px; border:1px solid var(--line); border-radius:7px; overflow:hidden; }
.permission-table-wrap :deep(.u-field) { min-width:130px; }
.permission-footer { justify-content:flex-end; margin-top:16px; }.permission-footer > span { margin-right:auto; color:var(--txt-3); }
.system-error { flex:none; margin:12px 16px; padding:11px 13px; border:1px solid var(--red); border-radius:6px; color:var(--red); background:color-mix(in srgb, var(--red) 10%, transparent); }
@media (max-width:900px) { .role-api-body { grid-template-columns:1fr; }.role-api-list { max-height:220px; border-right:0; border-bottom:1px solid var(--line); }.role-summary { flex-direction:column; } }
</style>
