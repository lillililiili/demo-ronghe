<script setup>
/* 飞行任务列表（2026-10-16 用户确认设计二）：一行一个任务，带分组标题、问题标签、一句“下一步”和按钮；
   点一行选中它（右侧看详情），同时在这一行下面展开或收起完整处理说明；几种问题用 ①② 分条。 */
import { reactive, ref } from 'vue';
const MARKS = ['①', '②', '③', '④', '⑤'];
const expanded = reactive(new Set());
function toggle(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  emit('select', id);
}
const listHost = ref(null);
function scrollToSelected() {
  listHost.value?.querySelector('.plan-record.selected')?.scrollIntoView({ block: 'nearest' });
}
defineExpose({ scrollToSelected });
defineProps({
  items: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  label: { type: String, required: true }
});
const emit = defineEmits(['select', 'action']);
function onKey(event, id) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  toggle(id);
}
</script>

<template>
  <div ref="listHost" class="plan-record-list" :aria-label="label">
    <template v-for="item in items" :key="item.id">
      <div v-if="item.groupHeader" class="plan-group-head" :class="`group-${item.group}`">
        <b>{{ item.groupHeader.title }}</b><span>{{ item.groupHeader.note }}</span>
      </div>
      <div class="plan-record" :class="{ selected: item.id === selectedId, needs: item.needs, deviation: item.deviation }"
        role="button" tabindex="0" :aria-pressed="item.id === selectedId" :aria-expanded="item.details.length ? expanded.has(item.id) : undefined" @click="toggle(item.id)" @keydown="onKey($event, item.id)">
        <span class="pr-head"><b>{{ item.title }}</b><span class="tag" :class="item.statusClass">{{ item.status }}</span></span>
        <span class="pr-sub" :title="item.subtitleTitle">{{ item.subtitle }}</span>
        <span v-if="item.tags.length" class="pr-tags"><span v-for="tag in item.tags" :key="tag.text" class="tag" :class="tag.cls" :title="tag.title">{{ tag.text }}</span></span>
        <span v-if="item.next" class="pr-next"><small>下一步</small>{{ item.next }}</span>
        <div v-if="item.details.length && expanded.has(item.id)" class="pr-detail">
          <p v-for="(line, index) in item.details" :key="line">{{ item.details.length > 1 ? `${MARKS[index] || `${index + 1}.`} ` : '' }}{{ line }}</p>
        </div>
        <span class="pr-bottom">
          <button v-if="item.action" class="btn" :class="{ pri: item.action.primary }" type="button" @click.stop="emit('action', { id: item.id, key: item.action.key })">{{ item.action.label }}</button>
          <span v-else class="pr-open">{{ item.id === selectedId ? '正在查看' : '查看详情' }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plan-record-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }
.plan-group-head { flex: none; display: flex; align-items: baseline; gap: 8px; padding: 6px 2px 2px; font-size: 12px; color: var(--txt-2); }
.plan-group-head b { font-size: 13px; color: var(--txt); }
.plan-group-head span { font-size: 11px; color: var(--txt-3); }
.plan-group-head.group-needs b { color: var(--amber); }
.plan-record { flex: none; display: grid; gap: 5px; width: 100%; min-width: 0; text-align: left; padding: 9px 10px; background: var(--panel); color: var(--txt); border: 1px solid var(--line); border-radius: 7px; cursor: pointer; }
.plan-record:hover { border-color: var(--page-accent); }
.plan-record:focus-visible { outline: 2px solid var(--page-accent); outline-offset: -2px; }
.plan-record.needs { box-shadow: inset 3px 0 var(--amber); }
.plan-record.deviation { box-shadow: inset 3px 0 var(--red); border-color: color-mix(in srgb, var(--red) 45%, var(--line)); }
.plan-record.selected { border-color: var(--cyan); background: var(--surface-selected); box-shadow: inset 3px 0 var(--cyan); }
.plan-record.selected.deviation { box-shadow: inset 3px 0 var(--red); }
.pr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.pr-head b { flex: 1; min-width: 80px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.pr-head .tag,.pr-tags .tag { font-size: 11px; padding: 1px 7px; width: auto; }
.pr-sub { font-size: 11px; line-height: 1.5; color: var(--txt-3); overflow-wrap: anywhere; }
.pr-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.pr-next { font-size: 12px; line-height: 1.55; color: var(--txt); overflow-wrap: anywhere; }
.pr-next small { margin-right: 6px; font-size: 11px; color: var(--txt-3); }
.pr-detail { display: grid; gap: 4px; padding: 7px 9px; font-size: 12px; line-height: 1.6; color: var(--txt-2); background: var(--panel-2); border: 1px dashed color-mix(in srgb, var(--amber) 55%, var(--line)); border-radius: 6px; }
.deviation .pr-detail { border-color: color-mix(in srgb, var(--red) 55%, var(--line)); }
.pr-detail p { margin: 0; }
.pr-bottom { display: flex; justify-content: flex-end; align-items: center; }
.pr-bottom .btn { min-height: 26px; padding: 2px 10px; font-size: 12px; }
.pr-open { font-size: 11px; color: var(--blue); }
.selected .pr-open { color: var(--cyan); }
</style>
