<script setup>
import { computed, h, ref, watch } from 'vue';
import { NButton, NIcon, NTree } from 'naive-ui';
import { BusinessOutline, FolderOutline } from '@vicons/ionicons5';
import { UField } from '@/components/form/index.js';

const ALL_KEY = '__all__';
const props = defineProps({
  organizations: { type: Array, default: () => [] },
  selectedKey: { type: String, default: ALL_KEY },
  canOperate: { type: Boolean, default: false }
});
const emit = defineEmits(['select', 'create', 'edit', 'delete']);

const query = ref('');
const expandedKeys = ref([]);
const menuShow = ref(false);
const menuX = ref(0);
const menuY = ref(0);
const menuOrg = ref(null);

const treeData = computed(() => {
  const visible = props.organizations.filter(org => org.enabled);
  const byParent = new Map();
  visible.forEach(org => {
    const parent = org.parent_id || null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(org);
  });
  const seen = new Set();
  const toNode = org => {
    if (seen.has(org.org_id)) return null;
    seen.add(org.org_id);
    const children = (byParent.get(org.org_id) || []).map(toNode).filter(Boolean);
    return {
      key: org.org_id,
      label: org.name,
      org,
      children: children.length ? children : undefined
    };
  };
  const roots = (byParent.get(null) || []).map(toNode).filter(Boolean);
  visible.filter(org => !seen.has(org.org_id)).forEach(org => {
    const node = toNode(org);
    if (node) roots.push(node);
  });
  return [{ key: ALL_KEY, label: '全部组织', children: roots.length ? roots : undefined }];
});

watch(() => props.organizations, () => {
  if (!props.organizations.length) return;
  const keys = [];
  const walk = nodes => (nodes || []).forEach(node => {
    if (node.children?.length) { keys.push(node.key); walk(node.children); }
  });
  walk(treeData.value);
  if (!expandedKeys.value.length) expandedKeys.value = keys;
  else {
    const seen = new Set(expandedKeys.value);
    const added = keys.filter(key => !seen.has(key));
    if (added.length) expandedKeys.value = [...expandedKeys.value, ...added];
  }
}, { immediate: true });

function filterOrg(pattern, node) {
  const q = pattern.trim().toLowerCase();
  if (!q) return true;
  if (node.key === ALL_KEY) return false;
  return (node.label || '').toLowerCase().includes(q)
    || String(node.org?.org_code || '').toLowerCase().includes(q);
}

function openMenu(event, org) {
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  menuOrg.value = org;
  menuX.value = Math.round(rect.right);
  menuY.value = Math.round(rect.bottom + 4);
  menuShow.value = true;
}

function closeMenu() {
  menuShow.value = false;
  menuOrg.value = null;
}

function onMenuSelect(key) {
  const org = menuOrg.value;
  closeMenu();
  if (!org) return;
  if (key === 'create-child') emit('create', org);
  else if (key === 'edit') emit('edit', org);
  else if (key === 'delete') emit('delete', org);
}

function renderPrefix({ option }) {
  return h(NIcon, { size: 15 }, { default: () => h(option.key === ALL_KEY ? BusinessOutline : FolderOutline) });
}

function renderSuffix({ option }) {
  if (option.key === ALL_KEY || !option.org) return null;
  return h('button', {
    type: 'button',
    class: 'org-node-more',
    'aria-label': `维护组织 ${option.org.name}`,
    'aria-haspopup': 'menu',
    onMousedown: event => event.stopPropagation(),
    onClick: event => openMenu(event, option.org)
  }, [
    h('span', { class: 'org-node-more-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'org-node-more-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'org-node-more-dot', 'aria-hidden': 'true' })
  ]);
}

function onSelect(keys) {
  if (!keys.length) return;
  menuShow.value = false;
  emit('select', keys[0] === ALL_KEY ? null : keys[0]);
}
</script>

<template>
  <aside class="org-pane" aria-label="组织树">
    <header class="org-pane-head">
      <div>
        <h2>组织机构</h2>
        <p>点击组织查看对应用户</p>
      </div>
      <n-button type="primary" size="small" :disabled="!canOperate" @click="emit('create', null)">新增</n-button>
    </header>
    <div class="org-pane-search">
      <UField v-model="query" variant="toolbar" label="搜索组织" sr-only clearable placeholder="请输入组织名称" />
    </div>
    <div class="org-pane-tree">
      <n-tree
        block-line
        selectable
        :indent="16"
        :cancelable="false"
        :data="treeData"
        :pattern="query.trim()"
        :filter="filterOrg"
        :show-irrelevant-nodes="false"
        :selected-keys="[selectedKey || ALL_KEY]"
        :expanded-keys="expandedKeys"
        :render-prefix="renderPrefix"
        :render-suffix="renderSuffix"
        @update:selected-keys="onSelect"
        @update:expanded-keys="expandedKeys = $event"
      />
      <p v-if="!organizations.length" class="org-empty">暂无组织，请先新增。</p>
    </div>
    <teleport to="body">
      <div v-if="menuShow" class="org-tree-menu-mask" @mousedown="closeMenu">
        <div
          class="org-tree-menu"
          role="menu"
          :style="{ left: `${menuX}px`, top: `${menuY}px` }"
          @mousedown.stop
        >
          <button type="button" role="menuitem" :disabled="!canOperate" @click="onMenuSelect('create-child')">新增下级</button>
          <button type="button" role="menuitem" :disabled="!canOperate" @click="onMenuSelect('edit')">编辑</button>
          <hr>
          <button type="button" role="menuitem" class="is-danger" :disabled="!canOperate" @click="onMenuSelect('delete')">删除</button>
        </div>
      </div>
    </teleport>
  </aside>
</template>

<style scoped>
.org-pane { display:flex; flex:0 0 280px; flex-direction:column; min-width:220px; width:280px; max-width:420px; resize:horizontal; overflow:hidden; border-right:1px solid var(--line); background:var(--surface-2); }
.org-pane-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; flex:none; padding:14px 14px 10px; }
.org-pane-head h2, .org-pane-head p { margin:0; }
.org-pane-head h2 { font-size:15px; }
.org-pane-head p { margin-top:4px; color:var(--txt-3); font-size:12px; line-height:1.5; }
.org-pane-search { flex:none; padding:0 12px 10px; }
.org-pane-search :deep(.u-field) { width:100%; }
.org-pane-tree { flex:1; min-height:0; overflow:auto; padding:2px 6px 12px; }
.org-empty { margin:12px 8px; color:var(--txt-3); font-size:13px; }
:deep(.n-tree) { width:100%; background:transparent; color:var(--txt); }
:deep(.n-tree-node) { align-items:center; }
:deep(.n-tree-node-content) { min-height:32px; padding:0 2px 0 2px; border-radius:6px; }
:deep(.n-tree-node-content:hover) { background:color-mix(in srgb, var(--blue) 10%, transparent); }
:deep(.n-tree-node--selected > .n-tree-node-content) { color:var(--txt); background:color-mix(in srgb, var(--blue) 18%, transparent); }
:deep(.n-tree-node-content__text) { min-width:0; overflow:hidden; color:inherit; text-overflow:ellipsis; }
:deep(.n-tree-node-content__suffix) { position:relative; z-index:2; display:flex; flex:none; align-items:center; margin-left:4px; pointer-events:auto; }
</style>

<style>
.org-node-more { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; width:24px; height:24px; padding:0; color:var(--txt-3); border:0; border-radius:4px; background:transparent; cursor:pointer; opacity:.4; }
.org-node-more-dot { width:3px; height:3px; border-radius:50%; background:currentColor; }
.org-node-more:hover, .org-node-more:focus-visible { opacity:1; color:var(--txt); background:color-mix(in srgb, var(--blue) 18%, transparent); }
.org-node-more:focus-visible { outline:2px solid var(--cyan); outline-offset:1px; }
.n-tree-node-content:hover .org-node-more,
.n-tree-node--selected .org-node-more,
.n-tree-node-content:focus-within .org-node-more { opacity:1; }
.org-tree-menu-mask { position:fixed; inset:0; z-index:400; }
.org-tree-menu { position:fixed; z-index:401; display:grid; min-width:118px; padding:4px; transform:translateX(-100%); border:1px solid var(--line); border-radius:8px; background:var(--surface-1); box-shadow:var(--shadow); }
.org-tree-menu button { display:block; width:100%; padding:7px 10px; color:var(--txt); font:inherit; font-size:13px; text-align:left; border:0; border-radius:5px; background:transparent; cursor:pointer; }
.org-tree-menu button:hover:not(:disabled) { background:color-mix(in srgb, var(--blue) 14%, transparent); }
.org-tree-menu button:disabled { color:var(--txt-3); cursor:not-allowed; }
.org-tree-menu button.is-danger { color:var(--red); }
.org-tree-menu button.is-danger:hover:not(:disabled) { background:color-mix(in srgb, var(--red) 12%, transparent); }
.org-tree-menu hr { margin:4px 6px; border:0; border-top:1px solid var(--line); }
</style>
