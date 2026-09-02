<script>
const pageState = { selectedId: 'R1', query: '', tab: 'menu', drafts: {} };
export default {};
</script>

<script setup>
import { computed, h, ref } from 'vue';
import { NCheckbox, NInput, NTabs, NTab } from 'naive-ui';
import { NAV } from '@/config/navModel.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { toast } from '@/ui/nv.js';
import { openModal, closeModal } from '@/ui/modal.js';
import ControlledFormModal from '@/components/modals/ControlledFormModal.vue';

const M = window.MOCK, U = window.UI;
usePageChrome('roles');

const bump = ref(0);
const query = ref(pageState.query);
const tab = ref(pageState.tab);
const selectedId = ref(pageState.selectedId);
const levelLabels = { '—': '无权限', READ: '查看', OP: '操作', AUTH: '授权' };
const levelOrder = ['—', 'READ', 'OP', 'AUTH'];
const icon = name => U.icon(name);

const roleList = computed(() => {
  bump.value;
  const q = query.value.trim();
  return M.ROLES.filter(r => !q || r.name.includes(q) || r.desc.includes(q) || r.id.toLowerCase().includes(q.toLowerCase()));
});
const selectedRole = computed(() => {
  bump.value;
  return M.ROLES.find(r => r.id === selectedId.value) || null;
});
const isLocked = computed(() => selectedRole.value?.id === 'R1');

const menuGroups = computed(() => {
  const groups = [];
  NAV.forEach(n => {
    if (n.k) groups.push({ title: '固定入口', items: [{ k: n.k, t: n.t, fixed: n.k === 'workbench' }] });
    else groups.push({ title: n.t, items: n.kids.map(x => ({ k: x.k, t: x.t })) });
  });
  const sensing = groups.find(g => g.title === '感知监测');
  if (sensing) sensing.items.push({ k: 'bigscreen', t: '数据大屏' });
  return groups;
});

function ensureDraft(id = selectedRole.value?.id) {
  if (!id) return null;
  if (!pageState.drafts[id]) {
    pageState.drafts[id] = {
      menu: Object.assign({}, M.MENU_PERM[id]),
      perm: M.PERM[id].slice()
    };
  }
  return pageState.drafts[id];
}
function draftOf() { return ensureDraft(selectedRole.value?.id); }
function menuChecked(key) { bump.value; return !!draftOf()?.menu[key]; }
function permValue(i) { bump.value; return draftOf()?.perm[i] || '—'; }
function isDirty(id = selectedRole.value?.id) {
  bump.value;
  const d = pageState.drafts[id];
  if (!d || !M.PERM[id] || !M.MENU_PERM[id]) return false;
  return JSON.stringify(d.perm) !== JSON.stringify(M.PERM[id]) || JSON.stringify(d.menu) !== JSON.stringify(M.MENU_PERM[id]);
}
function dirtyCount(id = selectedRole.value?.id) {
  const d = pageState.drafts[id];
  if (!d || !M.PERM[id] || !M.MENU_PERM[id]) return 0;
  let n = d.perm.filter((v, i) => v !== M.PERM[id][i]).length;
  M.MENU_KEYS.forEach(k => { if (!!d.menu[k] !== !!M.MENU_PERM[id][k]) n++; });
  return n;
}
function setSelected(id) {
  pageState.selectedId = id;
  selectedId.value = id;
  ensureDraft(id);
}
function setTab(value) { pageState.tab = value; tab.value = value; }
function setQuery(value) { pageState.query = value || ''; query.value = pageState.query; }

function setMenu(key, checked) {
  if (isLocked.value || key === 'workbench') return;
  const d = draftOf();
  d.menu[key] = checked;
  const moduleName = M.ROUTE_MODULES[key];
  const mi = M.PERM_MODULES.indexOf(moduleName);
  if (mi >= 0) d.perm[mi] = checked && d.perm[mi] === '—' ? 'READ' : (!checked ? '—' : d.perm[mi]);
  bump.value++;
}
function groupState(group) {
  const editable = group.items.filter(x => !x.fixed);
  const checked = editable.filter(x => menuChecked(x.k)).length;
  return { checked: editable.length > 0 && checked === editable.length, indeterminate: checked > 0 && checked < editable.length };
}
function setGroup(group, checked) {
  group.items.filter(x => !x.fixed).forEach(x => setMenu(x.k, checked));
}
function permissionLocked(moduleName) {
  return isLocked.value || moduleName === '反制/干扰授权';
}
function setPermission(i, value) {
  const role = selectedRole.value, moduleName = M.PERM_MODULES[i];
  if (!role || permissionLocked(moduleName)) return;
  const d = draftOf();
  d.perm[i] = value;
  if (value === '—') {
    Object.entries(M.ROUTE_MODULES).forEach(([key, module]) => { if (module === moduleName && M.MENU_KEYS.includes(key)) d.menu[key] = false; });
  }
  bump.value++;
}
function discardDraft() {
  const id = selectedRole.value?.id;
  if (!id) return;
  delete pageState.drafts[id];
  ensureDraft(id);
  bump.value++;
  toast('已放弃当前角色的改动', 'ok');
}
function reviewers() {
  const me = M.currentUser || {};
  return M.users.filter(u => u.id !== me.id && u.status === '正常' && ['R1', 'R2'].includes(u.role));
}
function reviewerChoices() {
  return reviewers().map(u => ({ value: u.id, label: `${u.name} · ${u.roleName} · ${u.org}` }));
}
function saveAccess() {
  const role = selectedRole.value, count = dirtyCount();
  if (!role || !count) return toast('暂无权限改动', 'err');
  openModal({
    title: `权限变更双人复核（${count} 项）`, width: '600px',
    footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'reviewerId', label: '复核人', type: 'select', required: true, clearable: false, options: reviewerChoices(), placeholder: '请选择（处置授权人及以上，不可为本人）' }],
      initial: { reviewerId: null },
      warning: `角色「${role.name}」的菜单与操作权限将原子生效，并写入不可修改的操作审计。`,
      confirmText: '复核通过并生效',
      onCancel: closeModal,
      onSubmit: ({ reviewerId }) => {
      const d = draftOf();
      const result = M.applyRoleAccess(role.id, d.menu, d.perm, reviewerId);
      if (!result.ok) return toast(result.msg, 'err');
      delete pageState.drafts[role.id]; ensureDraft(role.id); bump.value++;
      closeModal(); toast(`角色「${role.name}」权限已生效，共 ${result.changes.length} 项`, 'ok');
      }
    })
  });
}
function roleForm(role) {
  const editing = !!role;
  openModal({
    title: editing ? '编辑角色' : '新增角色', width: '520px',
    footer: false,
    render: () => h(ControlledFormModal, {
      fields: [
        { key: 'name', label: '角色名称', required: true, disabled: !!role?.builtin, placeholder: '请输入角色名称' },
        { key: 'desc', label: '角色说明', type: 'textarea', placeholder: '说明该角色的职责边界', minRows: 4 }
      ],
      initial: { name: role?.name || '', desc: role?.desc || '' },
      notice: role?.builtin ? '系统内置角色的编号、名称和删除操作已锁定，仅允许维护说明。' : '',
      onCancel: closeModal,
      onSubmit: input => {
      const result = editing ? M.updateRole(role.id, input) : M.createRole(input);
      if (!result.ok) return toast(result.msg, 'err');
      closeModal();
      if (!editing) setSelected(result.role.id);
      delete pageState.drafts[result.role.id]; ensureDraft(result.role.id); bump.value++;
      toast(editing ? '角色信息已更新' : '自定义角色已创建', 'ok');
      }
    })
  });
}
function deleteSelected() {
  const role = selectedRole.value;
  if (!role || role.builtin) return;
  if (role.users) return toast(`该角色仍有 ${role.users} 名用户，不能删除`, 'err');
  openModal({
    title: '删除角色双人复核', width: '560px',
    footer: false,
    render: () => h(ControlledFormModal, {
      fields: [{ key: 'reviewerId', label: '复核人', type: 'select', required: true, clearable: false, options: reviewerChoices(), placeholder: '请选择（处置授权人及以上，不可为本人）' }],
      initial: { reviewerId: null },
      warning: `删除角色「${role.name}」将同时移除其菜单与操作权限，此操作不可撤销并会写入审计。`,
      confirmText: '确认删除', danger: true,
      onCancel: closeModal,
      onSubmit: ({ reviewerId }) => {
      const result = M.deleteRole(role.id, reviewerId);
      if (!result.ok) return toast(result.msg, 'err');
      closeModal(); delete pageState.drafts[role.id]; setSelected(M.ROLES[0]?.id); bump.value++;
      toast(`角色「${role.name}」已删除`, 'ok');
      }
    })
  });
}

ensureDraft(selectedId.value);
</script>

<template>
  <div class="view roles-view">
    <section class="role-manager" aria-label="角色管理">
      <aside class="role-list-panel">
        <header class="role-list-head">
          <div><h2>角色列表</h2><span>共 {{ M.ROLES.length }} 个角色</span></div>
          <button class="btn pri" type="button" @click="roleForm(null)" v-html="icon('plus') + ' 新增角色'"></button>
        </header>
        <div class="role-search">
          <label class="sr-only" for="roleSearch">搜索角色</label>
          <n-input id="roleSearch" :value="query" clearable placeholder="搜索角色名称、说明或编号" @update:value="setQuery" />
        </div>
        <div class="role-list" role="list" aria-label="角色列表">
          <div v-if="!roleList.length" class="empty">没有匹配的角色</div>
          <div v-for="role in roleList" :key="role.id" class="role-card" :class="{ on: selectedId === role.id }" role="listitem">
            <button type="button" class="role-card-select" :aria-pressed="selectedId === role.id" @click="setSelected(role.id)">
              <span class="role-card-main">
              <span class="role-card-title"><b>{{ role.name }}</b><em>{{ role.id }}</em><i v-if="role.builtin">系统</i></span>
              <small>{{ role.desc || '暂无角色说明' }}</small>
              <span class="role-card-meta">成员 <b>{{ role.users }}</b> 人</span>
              </span>
            </button>
            <span class="role-card-actions">
              <button type="button" class="role-icon-btn" :aria-label="`编辑角色 ${role.name}`" title="编辑角色" @click.stop="roleForm(role)" v-html="icon('pen')"></button>
              <button type="button" class="role-icon-btn danger" :aria-label="`删除角色 ${role.name}`" :title="role.builtin ? '系统角色不可删除' : role.users ? '有成员的角色不可删除' : '删除角色'"
                :disabled="role.builtin || role.users > 0" @click.stop="setSelected(role.id); deleteSelected()" v-html="icon('trash')"></button>
            </span>
          </div>
        </div>
      </aside>

      <main v-if="selectedRole" class="role-permission-panel">
        <header class="role-permission-head">
          <div>
            <span class="eyebrow">当前角色 · {{ selectedRole.id }}</span>
            <h2>{{ selectedRole.name }}</h2>
            <p>{{ selectedRole.desc || '暂无角色说明' }} · {{ selectedRole.users }} 名成员</p>
          </div>
          <span v-if="selectedRole.builtin" class="tag t-blue">系统内置</span>
          <span v-else class="tag t-green">自定义角色</span>
        </header>

        <n-tabs type="line" size="small" :value="tab" @update:value="setTab" class="role-tabs" pane-style="display:none">
          <n-tab name="menu">菜单权限</n-tab>
          <n-tab name="operation">操作权限</n-tab>
        </n-tabs>

        <div v-if="tab === 'menu'" class="role-permission-scroll">
          <div class="role-help">菜单权限决定侧栏和直达地址是否可访问；开启菜单会自动补足对应模块的查看权限。</div>
          <section v-for="group in menuGroups" :key="group.title" class="permission-group">
            <header>
              <label class="permission-check group-check">
                <n-checkbox :checked="groupState(group).checked" :indeterminate="groupState(group).indeterminate"
                  :disabled="isLocked || group.items.every(x => x.fixed)" @update:checked="checked => setGroup(group, checked)" />
                <b>{{ group.title }}</b>
              </label>
              <span>{{ group.items.filter(x => menuChecked(x.k)).length }}/{{ group.items.length }}</span>
            </header>
            <div class="permission-items">
              <label v-for="item in group.items" :key="item.k" class="permission-check">
                <n-checkbox :checked="menuChecked(item.k)" :disabled="isLocked || item.fixed" @update:checked="checked => setMenu(item.k, checked)" />
                <span>{{ item.t }}</span><small v-if="item.fixed">固定入口</small>
              </label>
            </div>
          </section>
        </div>

        <div v-else class="role-permission-scroll">
          <div class="role-help">权限等级依次为查看、操作、授权；页面按钮和数据变更会再次校验，不能只靠界面隐藏。</div>
          <div class="operation-grid">
            <section v-for="(moduleName, i) in M.PERM_MODULES" :key="moduleName" class="operation-card" :class="{ critical: moduleName === '反制/干扰授权' }">
              <header><b>{{ moduleName }}</b><span v-if="permissionLocked(moduleName)">已锁定</span></header>
              <div class="permission-levels" role="group" :aria-label="`${moduleName}权限等级`">
                <button v-for="level in levelOrder" :key="level" type="button" :aria-pressed="permValue(i) === level"
                  :class="{ on: permValue(i) === level, auth: level === 'AUTH' }" :disabled="permissionLocked(moduleName)"
                  @click="setPermission(i, level)">{{ levelLabels[level] }}</button>
              </div>
            </section>
          </div>
        </div>

        <footer class="role-savebar">
          <span v-if="isLocked">超级管理员拥有全部权限，不能降级。</span>
          <span v-else-if="isDirty()">当前角色有 <b>{{ dirtyCount() }}</b> 项待提交改动，保存后需双人复核。</span>
          <span v-else>当前配置已保存。</span>
          <div>
            <button v-if="isDirty()" class="btn" type="button" @click="discardDraft">放弃更改</button>
            <button class="btn pri" type="button" :disabled="isLocked || !isDirty()" @click="saveAccess" v-html="icon('save') + ' 保存权限'"></button>
          </div>
        </footer>
      </main>
    </section>
  </div>
</template>
