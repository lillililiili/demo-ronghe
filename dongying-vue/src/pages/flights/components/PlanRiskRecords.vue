<script setup>
import { computed } from 'vue';

const props = defineProps({
  records: { type: Array, default: () => [] },
  loading: Boolean,
  error: { type: String, default: '' },
  total: { type: Number, default: 0 },
  currentTotal: { type: Number, default: 0 },
  uncertainTotal: { type: Number, default: 0 },
  asOf: { type: String, default: '' },
  page: { type: Number, default: 1 },
  size: { type: Number, default: 50 }
});
const emit = defineEmits(['select', 'notify', 'retry', 'page']);
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.size)));
const groups = computed(() => [
  { title: '当前仍存在', records: props.records.filter(record => record.currentStatus === 'CURRENT') },
  { title: '状态待确认', records: props.records.filter(record => record.currentStatus !== 'CURRENT') }
].filter(group => group.records.length));
</script>

<template>
  <section class="plan-risk-records" aria-label="本计划当前风险" :aria-busy="loading">
    <header class="risk-section-head">
      <h3>本计划当前风险</h3>
      <p v-if="!loading && !error">当前 <strong>{{ currentTotal }}</strong> 起<span v-if="uncertainTotal"> · 状态待确认 <strong>{{ uncertainTotal }}</strong> 起</span></p>
      <button v-if="!error" class="btn" type="button" :disabled="loading" @click="emit('retry')">刷新</button>
    </header>

    <div v-if="loading" class="risk-list-message" role="status">正在读取本计划当前风险</div>
    <div v-else-if="error" class="risk-list-message risk-list-error" role="alert">
      <strong>当前风险读取失败</strong>
      <p>{{ error }}</p>
      <button class="btn" type="button" @click="emit('retry')">重新读取</button>
    </div>
    <div v-else-if="!records.length" class="risk-list-message" role="status">
      <strong>暂无已确认仍存在的关联风险</strong>
      <p>没有记录不代表当前飞行条件已确认安全。</p>
    </div>
    <template v-else>
      <section v-for="group in groups" :key="group.title" class="risk-presence-group" :aria-label="group.title">
      <h4 class="risk-group-title">{{ group.title }}</h4>
      <ul class="plan-risk-list">
        <li v-for="record in group.records" :key="record.id" class="plan-risk-record" :class="record.severityClass || 't-gray'">
          <div class="risk-record-main">
            <span class="risk-severity">{{ record.severityLabel || record.severity || '等级未判定' }}</span>
            <h4>{{ record.title || '风险记录' }}</h4>
            <span v-if="record.stateLabel" class="tag risk-state" :class="record.stateClass || 't-gray'">{{ record.stateLabel }}</span>
          </div>
          <div class="risk-record-facts">
            <span v-if="record.sourceLabel" class="risk-source">{{ record.sourceLabel }}</span>
            <span v-if="record.occurredAt">发生时间：{{ record.occurredAt }}</span>
            <span v-if="record.relationText">{{ record.relationText }}</span>
            <span v-if="record.positionText">{{ record.positionText }}</span>
          </div>
          <p v-if="record.reason" class="risk-record-reason">{{ record.reason }}</p>
          <p v-if="record.currentStatus !== 'CURRENT'" class="risk-presence-reason">{{ record.currentReason || '缺少当前风险依据' }}</p>
          <div class="risk-record-actions">
            <button class="risk-detail-button" type="button" :aria-label="`查看${record.title || '风险'}详情`" @click="emit('select', record.id)">查看风险详情</button>
            <button v-if="record.canNotify" class="btn risk-notify-button" type="button" :aria-label="`${record.title || '风险'}，通知上级`" @click="emit('notify', record.id)">通知上级</button>
          </div>
        </li>
      </ul>
      </section>
      <nav v-if="pages > 1" class="risk-pagination" aria-label="当前风险分页">
        <button class="btn" type="button" :disabled="page <= 1" @click="emit('page', page - 1)">上一页</button>
        <span>第 {{ page }} / {{ pages }} 页</span>
        <button class="btn" type="button" :disabled="page >= pages" @click="emit('page', page + 1)">下一页</button>
      </nav>
    </template>
    <p v-if="!loading && !error && asOf" class="risk-list-more">更新于 {{ asOf }}</p>
  </section>
</template>

<style scoped>
.plan-risk-records { min-width: 0; color: var(--txt); }
.risk-section-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 5px 12px; padding: 0 0 11px; border-bottom: 1px solid var(--line-2); }
.risk-section-head h3 { margin: 0; color: var(--txt); font-size: 14px; font-weight: 600; line-height: 1.6; }
.risk-section-head p { margin: 0; color: var(--txt-3); font-size: 12px; line-height: 1.6; }
.risk-section-head strong { color: var(--txt-2); font-weight: 600; font-variant-numeric: tabular-nums; }
.plan-risk-list { list-style: none; padding: 0; margin: 0; }
.risk-group-title { margin: 14px 0 0; color: var(--txt-2); font-size: 13px; font-weight: 500; }
.risk-presence-reason { margin: 0; color: var(--amber); font-size: 12px; line-height: 1.8; }
.risk-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-top: 12px; font-size: 12px; }
.plan-risk-record { position: relative; display: grid; gap: 8px; min-width: 0; padding: 15px 0 15px 14px; border-bottom: 1px solid var(--line-2); }
.plan-risk-record::before { content: ''; position: absolute; top: 18px; bottom: 18px; left: 0; width: 3px; border-radius: 2px; background: var(--tag-c, var(--gray)); }
.plan-risk-record:last-child { border-bottom: 0; }
.risk-record-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 8px; min-width: 0; }
.risk-severity { color: var(--tag-c, var(--gray)); font-size: 12px; font-weight: 600; line-height: 1.7; }
.risk-record-main h4 { flex: 1 1 130px; margin: 0; min-width: 0; color: var(--txt); font-size: 14px; font-weight: 600; line-height: 1.65; }
.risk-state { max-width: 100%; padding: 1px 7px; border: 0; border-radius: 4px; color: var(--tag-c, var(--gray)); background: color-mix(in srgb, var(--tag-c, var(--gray)) 12%, transparent); box-shadow: none; font-size: 12px; line-height: 1.7; }
.risk-record-facts { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 12px; min-width: 0; color: var(--txt-3); font-size: 12px; line-height: 1.7; }
.risk-source { color: var(--txt-2); }
.risk-record-reason { margin: 0; color: var(--txt-2); font-size: 13px; line-height: 1.8; }
.risk-record-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; min-width: 0; padding-top: 1px; }
.risk-detail-button { min-height: 30px; padding: 3px 0; border: 0; border-radius: 3px; background: transparent; color: var(--blue); font: inherit; font-size: 12px; line-height: 1.7; text-align: left; cursor: pointer; }
.risk-detail-button:hover { color: var(--cyan); text-decoration: underline; text-underline-offset: 3px; }
.risk-notify-button { margin-left: auto; }
.plan-risk-records .btn { max-width: 100%; height: auto; min-height: 30px; padding: 4px 10px; font-size: 12px; line-height: 1.7; }
.plan-risk-records button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.risk-list-message { display: grid; justify-items: start; gap: 8px; padding: 16px 0; color: var(--txt-3); font-size: 13px; line-height: 1.8; }
.risk-list-message strong { color: var(--txt-2); font-size: 13px; font-weight: 500; }
.risk-list-message p { margin: 0; }
.risk-list-error strong { color: var(--amber); }
.risk-list-more { margin: 0; padding: 10px 0 0; border-top: 1px solid var(--line-2); color: var(--txt-3); font-size: 12px; line-height: 1.8; }
.plan-risk-records h3, .plan-risk-records h4, .plan-risk-records p, .plan-risk-records span, .plan-risk-records button { white-space: normal; overflow-wrap: anywhere; }
</style>
