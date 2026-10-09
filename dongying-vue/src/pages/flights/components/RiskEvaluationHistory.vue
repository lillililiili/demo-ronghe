<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { riskApi } from '@/services/riskApi.js';
import { refreshFailureText, useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { EVALUATION_LEVEL_NOTE, evaluationHistoryNote, evaluationSummaryText, segmentFactsText, segmentTimeText, segmentVerdict } from '@/ui/riskEvaluationHistory.js';

// P03：鸟群风险的评估历史，飞行任务页和空域页的风险详情共用。后台说这条风险不记评估历史（applicable=false，
// 例如天气、机场区域风险）时整栏不显示；第一次读到之前也不占位，免得这类风险闪一下空栏。
const PAGE_SIZE = 10;
const props = defineProps({ riskId: { type: String, required: true } });
const history = ref(null), page = ref(1), loading = ref(false), error = ref(''), refreshError = ref(''), now = ref(Date.now());
let request = 0, alive = true;

const visible = computed(() => history.value ? !!history.value.applicable : !!error.value);
const pageCount = computed(() => Math.max(1, Math.ceil((history.value?.total || 0) / PAGE_SIZE)));
const summary = computed(() => evaluationSummaryText(history.value, now.value));
const note = computed(() => evaluationHistoryNote(history.value));
const rows = computed(() => (history.value?.items || []).map(segment => ({
  key: segment.segment_no, time: segmentTimeText(segment, now.value), count: segment.evaluation_count,
  facts: segmentFactsText(segment), verdict: segmentVerdict(segment)
})));

function message(e, fallback) {
  return e?.status === 401 ? '登录已失效，请重新登录。' : e?.status === 403 ? '当前账号没有查看这条风险的权限。' : e?.message || fallback;
}

/* silent：实时刷新时重读当前页，失败保留已显示的内容，只在下面提示一句，并把错误抛给刷新钩子退避重试。 */
async function load(nextPage = page.value, { silent = false } = {}) {
  const token = ++request, id = props.riskId;
  if (!silent) { loading.value = true; error.value = ''; }
  try {
    const data = await riskApi.getEvaluationHistory(id, { page: nextPage, size: PAGE_SIZE });
    if (!alive || token !== request || id !== props.riskId) return;
    now.value = Date.now();
    history.value = data;
    page.value = data.page || nextPage;
    error.value = '';
    refreshError.value = '';
  } catch (e) {
    if (!alive || token !== request || id !== props.riskId) return;
    if (silent && history.value) refreshError.value = `自动刷新失败：${refreshFailureText(e, '读取失败')}，稍后会再试`;
    else error.value = message(e, '评估历史读取失败');
    if (silent) throw e;
  } finally {
    if (alive && token === request) loading.value = false;
  }
}

useRealtimeRefresh(['risk_evaluation'], async () => {
  if (history.value && !history.value.applicable) return;
  await load(page.value, { silent: true });
}, { minIntervalMs: 3_000 });

watch(() => props.riskId, () => {
  history.value = null; page.value = 1; error.value = ''; refreshError.value = '';
  load(1);
}, { immediate: true });
onUnmounted(() => { alive = false; request++; });
</script>

<template>
  <section v-if="visible" class="sect risk-evaluation-history">
    <h4>评估历史</h4>
    <div v-if="error" class="warnbox" role="alert">{{ error }}<button class="btn" type="button" :disabled="loading" @click="load(page)">重试</button></div>
    <template v-if="history">
      <p v-if="summary" class="eval-summary">{{ summary }}</p>
      <p class="eval-note">{{ EVALUATION_LEVEL_NOTE }}</p>
      <p v-if="note" class="eval-note">{{ note }}</p>
      <ol v-if="rows.length" class="eval-list" :aria-busy="loading">
        <li v-for="row in rows" :key="row.key" class="eval-item">
          <div class="eval-head"><span class="eval-time">{{ row.time }}</span><span class="eval-count">评估 {{ row.count }} 次</span><span class="tag" :class="row.verdict.tag">{{ row.verdict.text }}</span></div>
          <div class="eval-facts">{{ row.facts }}</div>
        </li>
      </ol>
      <div v-else-if="!note && !error" class="empty">还没有评估记录</div>
      <p v-if="refreshError" class="eval-note" role="status">{{ refreshError }}</p>
      <div v-if="history.total > PAGE_SIZE" class="eval-pager">
        <button class="btn ghost" type="button" :disabled="loading || page <= 1" @click="load(page - 1)">上一页</button>
        <span>第 {{ page }} / {{ pageCount }} 页</span>
        <button class="btn ghost" type="button" :disabled="loading || page >= pageCount" @click="load(page + 1)">下一页</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.risk-evaluation-history > h4 { margin-top: 0; }
.eval-summary { margin: 0 0 4px; font-size: 12px; line-height: 1.6; }
.eval-note { margin: 0 0 6px; color: var(--txt-3); font-size: 11px; line-height: 1.6; }
.eval-list { display: grid; gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }
.eval-item { display: grid; gap: 3px; padding: 7px 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
.eval-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eval-head .tag { margin-left: auto; }
.eval-time { font-variant-numeric: tabular-nums; }
.eval-count { color: var(--txt-3); font-size: 11px; }
.eval-facts { color: var(--txt-2); line-height: 1.5; }
.eval-pager { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; }
</style>
