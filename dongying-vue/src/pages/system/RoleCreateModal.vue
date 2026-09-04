<script setup>
import { computed, h, nextTick, reactive, ref } from 'vue';
import { NCheckbox, NDataTable, NForm } from 'naive-ui';
import { UField, UFormFooter } from '@/components/form/index.js';
import { menuLabelOf, withSystemPermissionsLast } from './permissionOrder.js';

const props = defineProps({
  catalog: { type: Array, default: () => [] },
  onSubmit: { type: Function, required: true },
  onCancel: { type: Function, required: true }
});

const protectedCodes = new Set(['users', 'roles', 'audit', 'countermeasure']);
const levels = [
  { value: 'NONE', label: '无权限' }, { value: 'READ', label: '查看' },
  { value: 'OP', label: '操作' }, { value: 'AUTH', label: '授权' }
];
const model = reactive({ name: '', description: '' });
const permissions = reactive(props.catalog.map(item => ({ ...item, level: 'NONE', menu_enabled: false })));
const busy = ref(false);
const error = ref('');
const errorBox = ref(null);
const visiblePermissions = computed(() => withSystemPermissionsLast(permissions.filter(item => Boolean(item.route_key))));
const hasConfigurablePermissions = computed(() => visiblePermissions.value.some(item => !protectedCodes.has(item.permission_code)));

function locked(item) { return protectedCodes.has(item.permission_code); }
function setLevel(item, value) { item.level = value; if (value === 'NONE') item.menu_enabled = false; }
function setMenu(item, value) { item.menu_enabled = value; if (value && item.level === 'NONE') item.level = 'READ'; }
const permissionColumns = computed(() => [
  { title: '菜单入口', key: 'route_key', minWidth: 180, render: row => h('div', [
    h(NCheckbox, { checked: row.menu_enabled, disabled: busy.value || locked(row), 'onUpdate:checked': value => setMenu(row, value) }, { default: () => menuLabelOf(row.route_key) }),
    h('small', { class: 'mono' }, row.permission_code)
  ]) },
  { title: '权限等级', key: 'level', width: 150, render: row => h(UField, {
    modelValue: row.level, type: 'select', label: '权限等级', srOnly: true, options: levels,
    disabled: busy.value || locked(row), 'onUpdate:modelValue': value => setLevel(row, value)
  }) },
  { title: '限制', key: 'limit', width: 130, render: row => locked(row) ? h('span', { class: 'locked-note' }, '仅超级管理员') : '可配置' }
]);
async function fail(message) { error.value = message; await nextTick(); errorBox.value?.focus(); }
async function submit() {
  if (busy.value) return;
  error.value = '';
  if (!model.name.trim()) return fail('角色名称为必填项。');
  busy.value = true;
  try {
    await props.onSubmit({
      name: model.name.trim(), description: model.description.trim(), reason: '超级管理员直接创建角色',
      permissions: permissions.map(item => ({ permission_code: item.permission_code, level: item.level, menu_enabled: item.menu_enabled }))
    });
  } catch (e) { await fail(e.message || '角色创建失败，请重试。'); }
  finally { busy.value = false; }
}
</script>

<template>
  <n-form class="role-create" :show-feedback="false" @submit.prevent="submit">
    <p v-if="error" ref="errorBox" class="warnbox" tabindex="-1" role="alert">{{ error }}</p>
    <div class="role-create-fields">
      <UField v-model="model.name" label="角色名称" required :disabled="busy" />
      <UField v-model="model.description" label="角色说明" type="textarea" :disabled="busy" :wide="true" />
    </div>
    <section v-if="hasConfigurablePermissions" class="role-create-permissions">
      <header><div><strong>初始权限</strong><small>角色与权限会在本次保存中一并创建并立即生效。</small></div></header>
      <div class="naive-table-fill role-create-table-wrap">
        <n-data-table :columns="permissionColumns" :data="visiblePermissions" :row-key="row => row.permission_code" :bordered="false" :single-line="true" size="small" flex-height :scroll-x="640" />
      </div>
    </section>
    <UFormFooter :loading="busy" :confirm-text="busy ? '正在创建…' : '创建并立即生效'" @cancel="onCancel" @confirm="submit" />
  </n-form>
</template>

<style scoped>
.role-create { display:flex; flex-direction:column; gap:18px; min-height:0; max-height:calc(100vh - 160px); overflow:hidden; }
.role-create-fields { display:grid; grid-template-columns:1fr 1fr; gap:14px; flex:none; }
.role-create-permissions { display:flex; flex-direction:column; gap:10px; min-height:0; flex:1 1 auto; }
.role-create-permissions header div { display:grid; gap:4px; }
.role-create-permissions small { color:var(--txt-3); font-weight:400; }
.role-create-table-wrap { min-height:180px; overflow:hidden; border:1px solid var(--line); border-radius:7px; }
.role-create-table-wrap :deep(.u-field) { min-width:120px; }
.role-create-table-wrap :deep(small) { display:block; margin-top:3px; }
.locked-note { color:var(--txt-3); }
@media (max-width:680px) { .role-create-fields { grid-template-columns:1fr; } }
</style>
