<script setup>
defineProps({
  items: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  label: { type: String, required: true },
  compact: Boolean
});
const emit = defineEmits(['select']);
</script>

<template>
  <div class="flight-record-list" :class="{ compact }" :aria-label="label">
    <button v-for="item in items" :key="item.id" class="flight-record" :class="{ selected: item.id === selectedId }"
      type="button" :aria-pressed="item.id === selectedId" @click="emit('select', item.id)">
      <span class="record-heading"><b>{{ item.title }}</b><span v-if="compact && item.severity" class="tag" :class="item.severityClass">{{ item.severity }}</span><span class="tag" :class="item.statusClass">{{ item.status }}</span></span>
      <span v-if="item.subtitle" class="record-subtitle">{{ item.subtitle }}</span>
      <span v-if="item.summary" class="record-summary">{{ item.summary }}</span>
      <span v-if="!compact" class="record-facts"><span v-for="fact in item.facts" :key="fact.label"><small>{{ fact.label }}</small><span :class="fact.className">{{ fact.value }}</span></span></span>
      <span class="record-bottom"><span>{{ item.note }}</span><span class="record-open">{{ item.id === selectedId ? '正在查看' : '查看详情' }}</span></span>
    </button>
  </div>
</template>

<style scoped>
.flight-record-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.flight-record { flex: none; display: grid; gap: 7px; width: 100%; min-width: 0; text-align: left; padding: 11px; background: var(--surface-gradient); color: var(--txt); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.flight-record:hover { border-color: var(--page-accent); }
.flight-record.selected { border-color: var(--page-accent); background: var(--surface-selected); box-shadow: inset 3px 0 var(--page-accent); }
.flight-record:focus-visible { outline: 2px solid var(--page-accent); outline-offset: -2px; }
.record-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 7px; }
.record-heading b { flex: 1; min-width: 100px; line-height: 1.5; font-size: 14px; overflow-wrap: anywhere; }
.record-subtitle,.record-summary,.record-bottom { font-size: 11px; line-height: 1.6; color: var(--txt-3); overflow-wrap: anywhere; }
.record-summary { color: var(--txt-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.record-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.record-facts > span { display: grid; gap: 3px; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
.record-facts small { font-size: 10px; color: var(--txt-3); }
.record-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--line); padding-top: 7px; }
.record-open { flex: none; color: var(--page-accent); }
.compact { gap: 5px; padding: 7px; }
.compact .flight-record { padding: 10px; gap: 5px; border-radius: 6px; }
.compact .record-heading { align-items: center; gap: 5px; }
.compact .record-heading b { font-size: 12px; min-width: 60px; }
.compact .record-heading .tag { font-size: 10px; padding: 1px 6px; width: auto; }
.compact .record-summary { -webkit-line-clamp: 1; }
.compact .record-bottom { border: 0; padding-top: 0; font-size: 10px; }
</style>
