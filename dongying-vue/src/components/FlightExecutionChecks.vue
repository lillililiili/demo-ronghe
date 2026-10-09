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
const tones = { MATCH: 'green', MISMATCH: 'red', UNDETERMINED: 'amber', NOT_APPLICABLE: 'gray' };
const sourceLabels = { live: '在线事实', mock: '模拟事实 · 非真实核验', replay: '回放事实' };
const rows = computed(() => dimensions.map(([code, name]) => {
  const hit = props.hits.find(item => item.rule_code === code);
  const state = hit?.facts?.comparison;
  const label = !hit ? '未执行核对' : labels[state] || pendingLabels[hit.reason_code] || '暂无核对结论';
  return { code, name, hit, state, label };
}));
function time(value) { return value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function tone(state) { return tones[state] || 'gray'; }
function sourceLabel(mode) { return sourceLabels[mode] || '事实来源未知'; }
function sourceTone(mode) { return mode === 'live' ? 'cyan' : mode === 'mock' || mode === 'replay' ? 'amber' : 'gray'; }
function evidenceLabel(kind) { return kind === 'flight_execution_fact' ? '执行事实' : '计划资料'; }
</script>

<template>
  <section class="execution-checks" aria-label="独立执行事实核对">
    <div class="execution-heading">
      <div>
        <h4>独立执行事实核对</h4>
        <p>基础计划关联仅核对时间、走廊和无人机身份；以下项目依据独立执行事实。</p>
      </div>
      <span class="tag t-cyan">4 项核对</span>
    </div>
    <div class="execution-cards">
      <article v-for="row in rows" :key="row.code" class="execution-card" :class="`is-${tone(row.state)}`">
        <header class="execution-card-head">
          <div class="execution-card-title"><span class="execution-index">{{ row.code }}</span><b>{{ row.name }}</b></div>
          <div class="execution-card-tags">
            <span class="tag" :class="`t-${tone(row.state)}`">{{ row.label }}</span>
            <span v-if="row.hit?.facts?.source_mode" class="tag" :class="`t-${sourceTone(row.hit.facts.source_mode)}`">{{ sourceLabel(row.hit.facts.source_mode) }}</span>
          </div>
        </header>
        <p class="execution-message">{{ row.hit?.message || (row.hit ? '本次核对未提供详细说明。' : '本次研判未执行该项核对，暂无核对结果。') }}</p>
        <div v-if="row.hit?.facts?.received_at || row.hit?.facts?.occurred_at" class="execution-meta">
          <span v-if="row.hit?.facts?.received_at"><i>事实接收</i>{{ time(row.hit.facts.received_at) }}</span>
          <span v-if="row.hit?.facts?.occurred_at"><i>事件发生</i>{{ time(row.hit.facts.occurred_at) }}</span>
        </div>
        <details v-if="row.hit" class="execution-details">
          <summary>查看依据与参数</summary>
          <div class="execution-detail-grid">
            <div v-for="ref in row.hit.evidence || []" :key="`${ref.kind}:${ref.id}`" class="execution-detail-item">
              <span class="tag t-blue">{{ evidenceLabel(ref.kind) }}</span><span>{{ ref.id }}</span>
            </div>
            <div v-for="param in row.hit.params || []" :key="param.key" class="execution-detail-item">
              <span class="tag t-purple">{{ ({ required: '必需依据', mismatch_status: '不符策略', tolerance_m: '容差（米）', max_accuracy_m: '最大误差（米）' })[param.key] || param.key }}</span>
              <span>{{ param.value }} · {{ param.status === 'CONFIRMED' ? '已确认' : '未正式确认' }}</span>
            </div>
          </div>
        </details>
      </article>
    </div>
  </section>
</template>

<style scoped>
.execution-checks { margin-top:16px; font-size:12px; overflow-wrap:anywhere; }
.execution-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:10px; }
.execution-heading h4 { margin:0; color:var(--txt); font-size:14px; }
.execution-heading p { margin:5px 0 0; color:var(--txt-2); line-height:1.6; }
.execution-heading > .tag { flex:none; margin-top:1px; }
.execution-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
.execution-card { position:relative; min-width:0; padding:11px 12px 10px 14px; border:1px solid var(--line-2); border-radius:8px; background:linear-gradient(135deg,color-mix(in srgb,var(--surface-3) 86%,transparent),color-mix(in srgb,var(--surface-1) 82%,transparent)); overflow:hidden; }
.execution-card::before { content:""; position:absolute; inset:0 auto 0 0; width:3px; background:var(--gray); }
.execution-card.is-green::before { background:var(--green); }.execution-card.is-red::before { background:var(--red); }.execution-card.is-amber::before { background:var(--amber); }.execution-card.is-gray::before { background:var(--gray); }
.execution-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.execution-card-title { display:flex; align-items:center; gap:7px; min-width:0; color:var(--txt); }
.execution-card-title b { font-size:13px; line-height:1.5; }
.execution-index { flex:none; color:var(--cyan); font:11px/1.4 Consolas,monospace; }
.execution-card-tags { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px; }
.execution-card .tag { margin:0; max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.execution-message { margin:8px 0 0; color:var(--txt-2); line-height:1.65; }
.execution-meta { display:flex; flex-wrap:wrap; gap:6px 10px; margin-top:8px; color:var(--txt-3); font-size:11px; }
.execution-meta span { display:inline-flex; flex-wrap:wrap; gap:4px; }
.execution-meta i { color:var(--txt-3); font-style:normal; }
.execution-details { margin-top:9px; padding-top:8px; border-top:1px solid var(--line-2); }
.execution-details summary { display:inline-flex; align-items:center; gap:5px; cursor:pointer; color:var(--blue); list-style:none; }
.execution-details summary::-webkit-details-marker { display:none; }
.execution-details summary::before { content:"＋"; color:var(--cyan); font-size:14px; line-height:1; }
.execution-details[open] summary::before { content:"－"; }
.execution-detail-grid { display:grid; gap:6px; margin-top:8px; }
.execution-detail-item { display:flex; align-items:flex-start; gap:6px; color:var(--txt-3); line-height:1.55; }
.execution-detail-item .tag { flex:none; padding:2px 6px; font-size:10px; }
@media(max-width:700px){ .execution-cards { grid-template-columns:1fr; } }
</style>
