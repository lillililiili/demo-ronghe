<script setup>
import { computed } from 'vue';
const props = defineProps({ hits: { type: Array, default: () => [] } });
const dimensions = [['C02-9', '起飞点'], ['C02-10', '降落点'], ['C02-11', '飞手身份'], ['C02-12', '报送单位']];
const labels = { MATCH: '符合', MISMATCH: '不符', NOT_APPLICABLE: '不适用' };
const pendingLabels = {
  EXECUTION_PLAN_ASSOCIATION_UNKNOWN: '计划关联不足',
  EXECUTION_RULE_PARAMETERS_MISSING: '规则待配置',
  EXECUTION_RULE_PARAMETERS_UNCONFIRMED: '规则待确认',
  EXECUTION_RULE_PARAMETERS_INVALID: '规则配置异常',
  EXECUTION_FACTS_UNAVAILABLE: '暂无执行资料',
  EXECUTION_FACTS_EXPIRED: '执行资料已过期',
  EXECUTION_FACTS_CONFLICT: '执行资料冲突',
  EXECUTION_POSITION_UNAVAILABLE: '起降资料不足',
  EXECUTION_POSITION_ACCURACY_UNKNOWN: '定位精度不足',
  EXECUTION_POSITION_DISTANCE_UNKNOWN: '暂无距离结果',
  EXECUTION_POSITION_BOUNDARY_UNKNOWN: '位置边界待核实',
  EXECUTION_PILOT_IDENTITY_UNKNOWN: '身份资料不足',
  EXECUTION_REPORTING_UNIT_UNKNOWN: '单位资料不足',
};
const rows = computed(() => dimensions.map(([code, name]) => {
  const hit = props.hits.find(item => item.rule_code === code);
  const state = hit?.facts?.comparison;
  const label = !hit ? '未执行核对' : labels[state] || pendingLabels[hit.reason_code] || '暂无核对结论';
  return { code, name, hit, state, label };
}));
function time(value) { return value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
</script>

<template>
  <section class="execution-checks" aria-label="独立执行事实核对">
    <h4>独立执行事实核对</h4>
    <p>基础计划关联仅核对时间、走廊和无人机身份；以下项目依据独立执行事实。</p>
    <article v-for="row in rows" :key="row.code">
      <b>{{ row.name }}</b><span class="tag" :class="row.state === 'MATCH' ? 't-green' : row.state === 'MISMATCH' ? 't-red' : 't-gray'">{{ row.label }}</span>
      <span v-if="['mock', 'replay'].includes(row.hit?.facts?.source_mode)" class="tag t-amber">模拟事实 · 非真实核验</span>
      <p>{{ row.hit?.message || (row.hit ? '本次核对未提供详细说明。' : '本次研判未执行该项核对，暂无核对结果。') }}</p>
      <p v-if="row.hit?.facts?.received_at">事实接收：{{ time(row.hit.facts.received_at) }}<template v-if="row.hit.facts.occurred_at"> · 事件发生：{{ time(row.hit.facts.occurred_at) }}</template></p>
      <details v-if="row.hit"><summary>查看依据与参数</summary>
        <p v-for="ref in row.hit.evidence || []" :key="`${ref.kind}:${ref.id}`">{{ ref.kind === 'flight_execution_fact' ? '执行事实' : '计划资料' }}：{{ ref.id }}</p>
        <p v-for="param in row.hit.params || []" :key="param.key">{{ ({ required: '必需依据', mismatch_status: '不符策略', tolerance_m: '容差（米）', max_accuracy_m: '最大误差（米）' })[param.key] || param.key }}：{{ param.value }} · {{ param.status === 'CONFIRMED' ? '已确认' : '未正式确认' }}</p>
      </details>
    </article>
  </section>
</template>

<style scoped>
.execution-checks { margin-top:12px; font-size:12px; overflow-wrap:anywhere; }
.execution-checks article { border-top:1px solid var(--line-2); padding:10px 0; }
.execution-checks b { margin-right:12px; }
.execution-checks p { margin:6px 0; color:var(--txt-2); line-height:1.6; }
.execution-checks .tag { margin-right:6px; }
.execution-checks summary { cursor:pointer; }
</style>
