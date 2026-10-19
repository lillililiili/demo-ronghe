<script setup>
/* 每个问题常驻显示自己的下一步和入口；查看详情与业务动作分开。 */
import { ref } from 'vue';
const listHost = ref(null);
function scrollToSelected() {
  listHost.value?.querySelector('.plan-record.selected')?.scrollIntoView({ block: 'nearest' });
}
defineExpose({ scrollToSelected });
defineProps({ items: { type: Array, default: () => [] }, selectedId: { type: String, default: null }, label: { type: String, required: true } });
const emit = defineEmits(['select', 'action']);
</script>

<template>
  <div ref="listHost" class="plan-record-list" :aria-label="label">
    <template v-for="item in items" :key="item.id">
      <div v-if="item.groupHeader" class="plan-group-head" :class="`group-${item.group}`">
        <b>{{ item.groupHeader.title }}</b><span>{{ item.groupHeader.note }}</span>
      </div>
      <article class="plan-record" :aria-label="`${item.title} ${item.subtitle}`"
        :class="{ selected: item.id === selectedId, needs: item.needs }">
        <button class="pr-select" type="button" :aria-pressed="item.id === selectedId" @click="emit('select', item.id)">
          <span class="pr-head"><b>{{ item.title }}</b><span class="tag" :class="item.statusClass">{{ item.status }}</span></span>
          <span class="pr-sub" :title="item.subtitleTitle">{{ item.subtitle }}</span>
          <span class="pr-open">{{ item.id === selectedId ? '正在查看任务详情' : '查看任务详情' }}</span>
        </button>
        <div v-if="item.issues.length" class="pr-issues" aria-label="逐项处理">
          <p v-if="item.issues.length > 1" class="pr-issue-count">有 {{ item.issues.length }} 类问题，请分别处理</p>
          <section v-for="(issue, index) in item.issues" :key="issue.kind" class="pr-issue" :aria-label="issue.tag">
            <div class="pr-issue-heading"><span v-if="item.issues.length > 1" class="pr-number">{{ index + 1 }}</span><span class="tag" :class="issue.tagClass">{{ issue.tag }}</span></div>
            <p class="pr-next"><b>下一步</b>{{ issue.next }}</p>
            <div class="pr-actions">
              <div v-for="action in issue.actions" :key="action.key" class="pr-action">
                <button class="btn" :class="{ pri: action.primary }" type="button" :disabled="!!action.blockedReason"
                  @click="emit('action', { id: item.id, key: action.key })">{{ action.label }} →</button>
                <small v-if="action.blockedReason" class="pr-blocker">{{ action.blockedReason }}</small>
              </div>
            </div>
            <details class="pr-explanation"><summary>处理说明</summary><p>{{ issue.detail }}</p></details>
          </section>
        </div>
        <template v-else>
          <span v-if="item.tags.length" class="pr-tags"><span v-for="tag in item.tags" :key="tag.text" class="tag" :class="tag.cls" :title="tag.title">{{ tag.text }}</span></span>
          <span v-if="item.next" class="pr-next">{{ item.next }}</span>
        </template>
        <div v-if="item.handlingAction" class="pr-actions" aria-label="关联研判与告警">
          <button class="btn" type="button" :disabled="item.handlingAction.disabled"
            @click="emit('action', { id: item.id, key: item.handlingAction.key })">{{ item.handlingAction.label }} →</button>
        </div>
      </article>
    </template>
  </div>
</template>

<style scoped>
.plan-record-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 10px; }
.plan-group-head { flex: none; display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 8px; font-size: 12px; color: var(--txt-2); }
.plan-group-head span { font-size: 11px; color: var(--txt-3); }
.plan-group-head.group-needs b { color: var(--amber); }
.plan-record { flex: none; min-width: 0; display: grid; gap: 8px; padding: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 7px; }
.plan-record.needs { box-shadow: inset 3px 0 var(--amber); }
.plan-record.selected { border-color: var(--cyan); background: var(--surface-selected); }
.pr-select { display: grid; gap: 5px; width: 100%; min-width: 0; padding: 0; border: 0; background: none; color: var(--txt); font: inherit; text-align: left; cursor: pointer; }
.pr-select:focus-visible,.pr-explanation summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.pr-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 6px; }
.pr-head b { flex: 1; min-width: 100px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.pr-head .tag,.pr-tags .tag,.pr-issue .tag { font-size: 11px; padding: 1px 7px; width: auto; white-space: normal; overflow-wrap: anywhere; }
.pr-sub,.pr-open { font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.pr-sub { color: var(--txt-3); }
.pr-open { color: var(--blue); }
.pr-issues { display: grid; gap: 9px; }
.pr-issue-count { margin: 0; color: var(--txt-2); font-size: 11px; }
.pr-issue { min-width: 0; padding-top: 9px; border-top: 1px solid var(--line); }
.pr-issue-heading,.pr-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pr-number { color: var(--txt-3); font-size: 11px; }
.pr-next { margin: 6px 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; color: var(--txt); }
.pr-next b { margin-right: 6px; font-size: 11px; color: var(--txt-3); font-weight: normal; }
.pr-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.pr-action { max-width: 100%; }
.pr-action .btn { min-height: 30px; max-width: 100%; height: auto; padding: 4px 9px; font-size: 12px; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.pr-blocker { display: block; margin-top: 4px; color: var(--amber); line-height: 1.5; }
.pr-explanation { margin-top: 6px; color: var(--txt-3); font-size: 11px; line-height: 1.6; }
.pr-explanation summary { width: fit-content; cursor: pointer; }
.pr-explanation p { margin: 5px 0 0; overflow-wrap: anywhere; color: var(--txt-2); }
</style>
