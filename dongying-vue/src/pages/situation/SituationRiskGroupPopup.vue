<script setup>
import { RISK_STATE_LABEL, labelOf } from '@/ui/labels.js';
import { riskMatchesPlan, routeRiskIsActive } from '@/services/situationData.js';

const props = defineProps({ group: { type: Object, required: true }, plans: { type: Array, default: () => [] } });
const U = window.UI;
defineEmits(['close', 'view-plan', 'action']);
const planFor = risk => props.plans.find(plan => riskMatchesPlan(risk, plan));
</script>

<template>
  <section class="sit-map-pop sit-risk-group-pop">
    <header>
      <span class="sit-map-pop-icon" v-html="U.icon('plan')"></span>
      <span><b>{{ group.spaceFact?.subtypeName || '航线' }}风险</b><small>关联 {{ group.planCount }} 条任务</small></span>
      <button type="button" aria-label="关闭风险详情" @click="$emit('close')" v-html="U.icon('close')"></button>
    </header>
    <p>{{ group.reasonText || '风险依据未提供' }}</p>
    <p v-if="group.currentReason" class="group-note">{{ group.currentReason }}</p>
    <p v-if="group.members.length > 1" class="group-note">同一观测合并展示，各任务处理状态分别保留。</p>
    <article v-for="risk in group.members" :key="risk.riskId" class="group-plan">
      <b>{{ planFor(risk)?.planNo || risk.planNo || '关联任务资料未取得' }}</b>
      <span>{{ labelOf(RISK_STATE_LABEL, risk.state) }}</span>
      <small v-if="planFor(risk)?.uavId">无人机：{{ planFor(risk).uavId }}</small>
      <div class="sit-map-pop-actions">
        <button v-if="planFor(risk)" type="button" @click="$emit('view-plan', risk)">查看任务</button>
        <template v-if="routeRiskIsActive(risk)">
          <button type="button" class="is-danger" @click="$emit('action', risk, 'exclude')">排除此任务风险</button>
          <button type="button" @click="$emit('action', risk, 'notify')">通知上级</button>
        </template>
      </div>
    </article>
  </section>
</template>

<style scoped>
.sit-risk-group-pop{padding:12px;overflow-wrap:anywhere}
small,.group-note{color:var(--txt-2);font-size:12px}
p{line-height:1.6}
.group-plan{display:grid;gap:6px;padding:12px 0;border-top:1px solid var(--sit-line)}
.group-plan>b{font-size:13px}
.group-plan>span{font-size:12px;color:var(--txt-2)}
.sit-map-pop-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
button{min-height:32px;padding:4px 8px;border:1px solid var(--sit-line);border-radius:6px;background:var(--surface-2);color:var(--cyan);font:inherit;font-size:12px;cursor:pointer}
button.is-danger{color:var(--red)}
button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
</style>
