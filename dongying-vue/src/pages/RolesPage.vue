<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { NButton, NCheckbox, NDataTable, NSpin } from 'naive-ui';
import { UField } from '@/components/form/index.js';
import { ACTION_CODE_LABEL, ACTION_MODULE_LABEL } from '@/ui/labels.js';
import ControlledFormModal from '@/components/modals/ControlledFormModal.vue';
import RoleCreateModal from './system/RoleCreateModal.vue';
import { menuLabelOf, withSystemPermissionsLast } from './system/permissionOrder.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { hasPermission } from '@/services/accessControl.js';
import { systemApi } from '@/services/systemAdmin.js';
import { closeModal, openModal } from '@/ui/modal.js';
import { dialog, toast } from '@/ui/nv.js';

usePageChrome('roles');
const loading = ref(false);
const error = ref('');
const query = ref('');
const roles = ref([]);
const catalog = ref([]);
/* 动作权限（阶段 15）：与菜单级权限是两张表——菜单级决定"能不能进这一页"，
   动作级决定"能不能做这件事"。契约语义：actions 缺省表示不动，所以只在改过时才提交。 */
const actionCatalog = ref([]);
const actionCatalogError = ref('');
const actionDraft = ref({});
const actionBaseline = ref({});
const actionLevelOptions = [{ value: 'NONE', label: '无' }, { value: 'READ', label: '查看' }, { value: 'OP', label: '操作' }];
const actionsDirty = computed(() => JSON.stringify(actionDraft.value) !== JSON.stringify(actionBaseline.value));

function resetActionDraft(detail) {
  const granted = {};
  (detail?.actions || []).forEach(a => { granted[a.permission_code] = a.level; });
  const draftMap = {};
  actionCatalog.value.forEach(group => group.actions.forEach(a => { draftMap[a.permission_code] = granted[a.permission_code] || 'NONE'; }));
  actionDraft.value = draftMap;
  actionBaseline.value = { ...draftMap };
}
/* 目录里的 module_name/name 目前是英文开发描述，先用共享字典的中文；服务端将来给中文了自然优先用它。 */
const isChinese = text => /[\u4e00-\u9fa5]/.test(String(text || ''));
function moduleLabel(group) {
  return isChinese(group.module_name) ? group.module_name : (ACTION_MODULE_LABEL[group.module_code] || group.module_code);
}
function actionLabel(action) {
  return isChinese(action.name) ? action.name : (ACTION_CODE_LABEL[action.permission_code] || action.permission_code);
}
function actionLevelOf(action) { return actionDraft.value[action.permission_code] || 'NONE'; }
/* 授权级不在本分区的可选范围（契约只收 NONE/READ/OP）：升级前的库里可能还有 AUTH 的历史动作行，
   如实显示并锁住，不把它悄悄降成"操作"，也不显示成裸的 AUTH；提交时从 actions 里过滤掉，
   服务端整组替换会把它清除（15-29）。分支保留：0105 之后这类行本不该再出现。 */
/* 超级管理员这一列固定显示"全部"：服务端对它一律按最高等级放行（AccessService 判到 ROLE-ADMIN
   就直接取最高等级，并给它整份动作目录），而库里存的行可能只是"查看"。照库里显示会让人以为
   超管只能看不能做——那是页面在说假话。 */
function actionOptionsFor(action) {
  const level = actionLevelOf(action);
  if (isLocked.value) return [{ value: level, label: '全部' }];
  return level === 'AUTH'
    ? [...actionLevelOptions, { value: 'AUTH', label: '授权' }]
    : actionLevelOptions;
}
function actionLockNoteOf(action) {
  if (actionLevelOf(action) === 'AUTH') return '历史遗留等级，保存后将被清除';
  return actionLockNote(action);
}
function actionLocked(action) { return isLocked.value || protectedCodes.has(action.permission_code); }
function actionLockNote(action) {
  if (isLocked.value) return '超级管理员固定拥有全部权限，不能在此调整';
  if (protectedCodes.has(action.permission_code)) return '该动作仅超级管理员可用';
  return '';
}
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
const isDirty = computed(() => !!roleDetail.value
  && (JSON.stringify(draft.value) !== JSON.stringify(roleDetail.value.permissions) || actionsDirty.value));
const levelOptions = [
  { value: 'NONE', label: '无权限' }, { value: 'READ', label: '查看' },
  { value: 'OP', label: '操作' }, { value: 'AUTH', label: '授权' }
];

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function permissionLocked(item) { return isLocked.value || protectedCodes.has(item.permission_code); }
function setLevel(item, value) { item.level = value; if (value === 'NONE') item.menu_enabled = false; }
function setMenu(item, value) { item.menu_enabled = value; if (value && item.level === 'NONE') item.level = 'READ'; }
function discard() {
  draft.value = roleDetail.value.permissions.map(item => ({ ...item }));
  resetActionDraft(roleDetail.value);
  toast('已放弃未保存的权限改动', 'ok');
}
function limitText(item) {
  if (!isLocked.value && protectedCodes.has(item.permission_code)) return '仅超级管理员';
  return isLocked.value ? '固定权限' : '可配置';
}
const permissionColumns = computed(() => [
  { title: '菜单入口', key: 'route_key', width: 180, render: row => h(NCheckbox, {
    checked: row.menu_enabled, disabled: permissionLocked(row), 'onUpdate:checked': value => setMenu(row, value)
  }, { default: () => menuLabelOf(row.route_key) }) },
  { title: '权限等级', key: 'level', width: 150, render: row => (isLocked.value ? h('span', '全部') : h(UField, {
    modelValue: row.level, type: 'select', label: '权限等级', srOnly: true, options: levelOptions,
    disabled: permissionLocked(row), 'onUpdate:modelValue': value => setLevel(row, value)
  })) },
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
    resetActionDraft(roleDetail.value);
  } catch (e) { error.value = e.message || '角色详情加载失败。'; }
  finally { loading.value = false; }
}
async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [permissionCatalog, , actions] = await Promise.all([
      systemApi.permissions(), loadRoles(),
      systemApi.permissionActions().catch(error => { actionCatalogError.value = error?.message || '动作权限目录读取失败'; return []; })
    ]);
    catalog.value = permissionCatalog;
    actionCatalog.value = Array.isArray(actions) ? actions : (actions?.items || []);
    await loadRole();
  }
  catch (e) { error.value = e.message || '角色管理数据加载失败。'; }
  finally { loading.value = false; }
}
watch(selectedCode, code => { if (code) loadRole(code); });

function savePermissions() {
  if (!isDirty.value) return toast('没有需要保存的权限改动', 'err');
  const role = roleDetail.value;
  dialog.warning({
    title: `保存权限 · ${role.name}`,
    content: '权限保存后立即生效；该角色下所有用户的旧会话会被撤销，需要重新登录。',
    positiveText: '保存并立即生效',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const body = {
          expected_version: role.version,
          permissions: draft.value.map(item => ({
            permission_code: item.permission_code, level: item.level, menu_enabled: item.menu_enabled
          }))
        };
        // actions 缺省 = 动作行不动；没改过就不提交，避免把没碰过的行覆盖成 NONE。
        // AUTH 历史行不在写接口的取值范围内（15-29）：从提交体过滤，整组替换后即被清除。
        if (actionsDirty.value) {
          body.actions = Object.keys(actionDraft.value)
            .filter(code => actionDraft.value[code] !== 'AUTH')
            .map(code => ({ permission_code: code, level: actionDraft.value[code] }));
        }
        const saved = await systemApi.updateRolePermissions(role.role_code, body);
        roleDetail.value = saved;
        draft.value = saved.permissions.map(item => ({ ...item }));
        resetActionDraft(saved);
        await loadRoles();
        toast('角色权限已立即生效，相关旧会话已撤销', 'ok');
      } catch (e) { toast(e.message || '保存失败，请重试', 'err'); }
    }
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
            <section class="action-perm">
              <h3>动作权限</h3>
              <p class="action-perm-note">菜单权限决定能不能进这一页；动作权限决定能不能做这件事。两者分开配置。</p>
              <div v-if="actionCatalogError" class="empty">{{ actionCatalogError }}</div>
              <div v-else-if="!actionCatalog.length" class="empty">当前没有可配置的动作权限。</div>
              <div v-else class="action-perm-grid">
                <div v-for="group in actionCatalog" :key="group.module_code" class="action-perm-group">
                  <div class="action-perm-module" :title="group.module_code">{{ moduleLabel(group) }}</div>
                  <div v-for="action in group.actions" :key="action.permission_code" class="action-perm-row">
                    <span class="action-perm-name" :title="action.permission_code">{{ actionLabel(action) }}</span>
                    <UField :model-value="actionLevelOf(action)" type="select" label="等级" sr-only
                      :options="actionOptionsFor(action)" :disabled="actionLocked(action) || actionLevelOf(action) === 'AUTH'" :title="actionLockNoteOf(action)"
                      @update:model-value="value => (actionDraft[action.permission_code] = value)" />
                  </div>
                </div>
              </div>
            </section>
            <footer class="permission-footer"><span>{{ isDirty ? '有尚未保存的权限改动' : '当前显示已生效权限' }}</span><n-button :disabled="!isDirty" @click="discard">放弃改动</n-button><n-button type="primary" :disabled="!canOperate || !isDirty || isLocked" @click="savePermissions">保存并立即生效</n-button></footer>
          </main>
          <div v-else class="empty">请选择角色</div>
        </div>
      </n-spin>
    </section>
  </div>
</template>

<style scoped>
.action-perm { flex: none; margin-top: 12px; }
.action-perm h3 { margin: 0 0 4px; font-size: 13px; }
.action-perm-note { margin: 0 0 8px; font-size: 11.5px; color: var(--txt-3); }
.action-perm-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.action-perm-group { flex: 1 1 260px; min-width: 240px; }
.action-perm-module { font-size: 12px; color: var(--txt-2); margin-bottom: 4px; }
.action-perm-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }
.action-perm-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
.role-api-detail { display:flex; min-width:0; min-height:0; flex-direction:column; overflow:auto; padding:18px; }
.role-summary { justify-content:space-between; align-items:flex-start; }
.role-summary h2, .role-summary p { margin:0; }.role-summary p { margin-top:7px; color:var(--txt-3); }
.role-summary-actions { display:grid; justify-items:end; gap:6px; }.role-summary-actions > div { display:flex; gap:8px; }
.delete-note { color:var(--orange, #f4a261); }
.permission-table-wrap { flex:none; height:220px; margin-top:14px; border:1px solid var(--line); border-radius:7px; overflow:hidden; }
.permission-table-wrap :deep(.u-field) { min-width:130px; }
.permission-footer { flex:none; justify-content:flex-end; margin-top:16px; padding-bottom:8px; }.permission-footer > span { margin-right:auto; color:var(--txt-3); }
.system-error { flex:none; margin:12px 16px; padding:11px 13px; border:1px solid var(--red); border-radius:6px; color:var(--red); background:color-mix(in srgb, var(--red) 10%, transparent); }
@media (max-width:900px) { .role-api-body { grid-template-columns:1fr; }.role-api-list { max-height:220px; border-right:0; border-bottom:1px solid var(--line); }.role-summary { flex-direction:column; } }
</style>
