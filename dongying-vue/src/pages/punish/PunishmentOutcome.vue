<script setup>
import { ref, watch, onUnmounted } from 'vue';
import { punishmentApi } from '@/services/punishmentApi.js';
import { CASE_STATUS_LABEL, PENALTY_TYPE_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
const props = defineProps({ handoffId: { type: String, required: true } });
const rows = ref([]), loading = ref(false), error = ref('');
let token = 0, active = true;
onUnmounted(() => { active = false; ++token; });
async function load() {
  const seq = ++token, id = props.handoffId;
  loading.value = true; error.value = ''; rows.value = [];
  try {
    const result = await punishmentApi.listCases({ handoff_id: id, page: 1, size: 100 });
    if (active && seq === token) rows.value = result.items || [];
  } catch (e) {
    if (active && seq === token) error.value = e.status === 403 ? '当前账号没有查看处罚结果的权限。' : e.message || '读取处罚结果失败。';
  } finally { if (active && seq === token) loading.value = false; }
}
watch(() => props.handoffId, load, { immediate: true });
const decided = row => ['DECIDED', 'CLOSED'].includes(row.status);
const money = value => value == null ? '未提供' : `${(Number(value) / 100).toLocaleString('zh-CN')} 元`;
</script>

<template>
  <section class="sect punishment-outcome" aria-label="处罚办理结果">
    <header><h4>处罚办理结果</h4><button type="button" class="btn sm" :disabled="loading" @click="load">刷新结果</button></header>
    <p v-if="loading">正在读取案件办理情况…</p>
    <p v-else-if="error" class="po-muted" role="alert">{{ error }}</p>
    <p v-else-if="!rows.length" class="po-muted">暂无关联案件结果。当前只完成材料移送，不能据此认定已罚款。</p>
    <article v-for="row in rows" :key="row.case_id">
      <p><b>{{ row.case_no }}</b> · {{ labelOf(CASE_STATUS_LABEL, row.status) }} <span v-if="row.source_mode !== 'live'" class="tag t-amber">{{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</span></p>
      <dl class="kv kv-surface">
        <dt>当事人</dt><dd>{{ row.party_name || '待查明' }}</dd>
        <dt>承办人</dt><dd>{{ row.officer_name || '待指派' }}</dd>
        <template v-if="row.current_discretion"><dt>{{ decided(row) ? '决定内容' : '拟定内容' }}</dt><dd>{{ labelOf(PENALTY_TYPE_LABEL, row.current_discretion.penalty_type) }}</dd><dt>{{ decided(row) ? '决定罚款金额' : '拟罚金额' }}</dt><dd>{{ money(row.current_discretion.fine_amount) }}</dd></template>
        <dt v-if="row.withdraw_reason">撤案说明</dt><dd v-if="row.withdraw_reason">{{ row.withdraw_reason }}</dd>
        <dt v-if="row.close_note">结案说明</dt><dd v-if="row.close_note">{{ row.close_note }}</dd>
      </dl>
      <p v-if="row.current_discretion" class="po-muted">{{ decided(row) ? '决定金额来自案件记录；是否缴款需以履行凭证为准。' : '当前为拟定内容，尚不能作为已处罚结果。' }}</p>
    </article>
  </section>
</template>

<style scoped>
.punishment-outcome header{display:flex;align-items:center;justify-content:space-between;gap:12px}.punishment-outcome h4{margin:0}.punishment-outcome p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}.punishment-outcome article+article{border-top:1px solid var(--line);padding-top:10px}.po-muted{color:var(--muted)}
</style>
