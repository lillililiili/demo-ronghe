<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { airspaceApi } from '@/services/airspaceApi.js';
const props = defineProps({ airspaceId: { type: String, required: true } });
const groups = ref([]), loading = ref(false), error = ref('');
const activeCategory = ref('verify');
const categories = [
  { key: 'verify', label: '核实' },
  { key: 'counter', label: '反制' },
  { key: 'dispose', label: '处置' }
];
let sequence = 0;
const relatedGroups = computed(() => groups.value.filter(group => group.rules.length && (
  group.settings.scope_mode === 'ALL' ||
  (group.settings.scope_mode === 'AIRSPACES' && group.settings.airspace_ids.includes(props.airspaceId))
)));
// safe-default: 当前分类无关联规则时选中首个有效页签，选中状态可见且用户可切换，不替换规则实体。
const activeGroup = computed(() => relatedGroups.value.find(group => group.category === activeCategory.value) || relatedGroups.value[0]);
const displayedRules = computed(() => (activeGroup.value?.rules || []).map(rule => {
  const simulated = rule.name.startsWith('模拟·');
  const name = simulated ? rule.name.slice(3) : rule.name;
  return { ...rule, name, simulated, condition: condition(rule, activeGroup.value.catalog, name) };
}));
function tabId(category) { return `airspace-${props.airspaceId}-rule-${category}`; }
function selectTabByKey(event, index) {
  const count = relatedGroups.value.length;
  const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  activeCategory.value = relatedGroups.value[next].category;
  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]?.focus();
}
function condition(rule, catalog, name) {
  const item = catalog.find(entry => entry.code === rule.item_code);
  if (!item) return { text: rule.value };
  if (item.kind === 'NUMBER') {
    const operator = { '不低于': '≥', '不少于': '≥', '不超过': '≤' }[item.operator] || item.operator;
    return { text: `${name.includes(item.label) ? '' : item.label + ' '}${operator} `, value: `${rule.value}${item.unit === '%' ? '' : ' '}${item.unit}` };
  }
  if (item.kind === 'SELECT') return { text: `${item.label}：${rule.value}` };
  return { text: item.fixed_value || rule.value };
}
function schedule(settings) {
  if (settings.schedule_mode === 'ALL_DAY') return '全天';
  return `${settings.start_time} 至 ${settings.end_time}${settings.end_time < settings.start_time ? '（次日）' : ''} · 北京时间`;
}
async function load() {
  const seq = ++sequence;
  groups.value = []; error.value = ''; loading.value = true;
  try {
    const results = await Promise.all(categories.map(async category => {
      const group = await airspaceApi.ruleGroup(category.key);
      if (group?.category !== category.key || !Array.isArray(group.rules) || !Array.isArray(group.catalog) ||
          !['ALL', 'AIRSPACES'].includes(group.settings?.scope_mode) || !Array.isArray(group.settings.airspace_ids)) {
        throw new Error('规则数据不完整，请重试');
      }
      return { ...group, label: category.label };
    }));
    if (seq === sequence) groups.value = results;
  } catch (e) {
    if (seq === sequence) error.value = e.status === 403 ? '无权查看关联规则' : e.status === 401 ? '登录已失效，请重新登录' : '规则读取失败，请重试';
  } finally { if (seq === sequence) loading.value = false; }
}
watch(() => props.airspaceId, () => { activeCategory.value = 'verify'; load(); }, { immediate: true });
onBeforeUnmount(() => { sequence += 1; });
</script>
<template>
  <section v-if="loading || error || relatedGroups.length" class="response-plan" aria-label="本空域关联规则" :aria-busy="loading">
    <div class="heading"><b>关联规则</b><button class="refresh-rules" type="button" :disabled="loading" @click="load">刷新</button></div>
    <p v-if="loading" role="status">正在读取规则</p>
    <p v-else-if="error" class="warnbox" role="alert">{{ error }}</p>
    <template v-else>
      <div class="rule-tabs" role="tablist" aria-label="关联规则分类">
        <button v-for="(group, index) in relatedGroups" :id="tabId(group.category)" :key="group.category" type="button" role="tab"
          :aria-selected="activeGroup?.category === group.category" :aria-controls="`${tabId(group.category)}-panel`"
          :tabindex="activeGroup?.category === group.category ? 0 : -1" class="rule-tab"
          @click="activeCategory = group.category" @keydown="selectTabByKey($event, index)">
          {{ group.label }}<span class="rule-count">{{ group.rules.length }}</span>
        </button>
      </div>
      <section v-if="activeGroup" :id="`${tabId(activeGroup.category)}-panel`" :key="activeGroup.category" class="rule-group"
        role="tabpanel" :aria-labelledby="tabId(activeGroup.category)" tabindex="0">
        <p class="schedule">{{ schedule(activeGroup.settings) }}</p>
        <article v-for="rule in displayedRules" :key="rule.rule_id" class="rule-item">
          <div class="rule-title"><h4>{{ rule.name }}</h4><span class="rule-status" :class="{ enabled: rule.enabled }">{{ rule.enabled ? '已启用' : '已停用' }}</span></div>
          <div class="rule-detail"><span v-if="rule.simulated" class="source-label">模拟</span><p>{{ rule.condition.text }}<strong v-if="rule.condition.value">{{ rule.condition.value }}</strong><span v-if="rule.hold_seconds"> · 持续 {{ rule.hold_seconds }} 秒</span></p></div>
        </article>
      </section>
    </template>
  </section>
</template>
<style scoped>
.response-plan { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 16px; color: var(--txt); }
.heading { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.heading b { font-size: 14px; font-weight: 600; }
.refresh-rules { border: 0; background: transparent; color: var(--txt-2); padding: 5px 0 5px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.refresh-rules:hover { color: var(--cyan); }
.refresh-rules:disabled { opacity: .5; cursor: wait; }
.rule-tabs { display: flex; gap: 4px; margin-top: 10px; border-bottom: 1px solid color-mix(in srgb, var(--txt-3) 20%, transparent); }
.rule-tab { display: flex; flex: 1; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; min-width: 0; border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 8px 4px; color: var(--txt-2); font: inherit; font-size: 13px; cursor: pointer; }
.rule-tab:hover { color: var(--txt); }
.rule-tab[aria-selected="true"] { border-bottom-color: var(--cyan); color: var(--cyan); background: color-mix(in srgb, var(--cyan) 5%, transparent); }
.rule-count { font-size: 11px; font-variant-numeric: tabular-nums; opacity: .8; }
.schedule { margin: 10px 0 2px; font-size: 11px; color: var(--txt-3); }
.rule-item { padding: 11px 0; }
.rule-item + .rule-item { border-top: 1px solid color-mix(in srgb, var(--txt-3) 16%, transparent); }
.rule-title { display: flex; align-items: baseline; gap: 12px; }
.rule-title h4 { flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 500; }
.rule-status { flex: none; color: var(--txt-3); font-size: 11px; }
.rule-status.enabled { color: var(--green); }
.rule-detail { display: flex; align-items: baseline; gap: 7px; margin-top: 5px; }
.rule-detail p { flex: 1; min-width: 0; margin: 0; font-size: 12px; color: var(--txt-2); }
.rule-detail strong { font-weight: 600; color: var(--txt); font-variant-numeric: tabular-nums; }
.source-label { flex: none; border-radius: 3px; padding: 0 4px; font-size: 10px; line-height: 1.6; color: var(--txt-2); background: color-mix(in srgb, var(--txt-3) 12%, transparent); }
h4, p, b, button, .rule-status { overflow-wrap: anywhere; white-space: normal; line-height: 1.6; }
button:focus-visible, .rule-group:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
</style>
