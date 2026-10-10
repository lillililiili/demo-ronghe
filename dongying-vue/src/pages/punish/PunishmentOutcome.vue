<script setup>
import { ref, watch, onUnmounted } from 'vue';
import { punishmentApi } from '@/services/punishmentApi.js';
import { CASE_STATUS_LABEL, PENALTY_TYPE_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import { ruleReasonText } from '@/ui/legalityReviewModal.js';
const props = defineProps({ handoffId: { type: String, required: true } });
const rows = ref([]), loading = ref(false), error = ref('');
const decisionBasis = ref({});
let token = 0, active = true;
onUnmounted(() => { active = false; ++token; });
async function load({ quiet = false } = {}) {
  const seq = ++token, id = props.handoffId;
  loading.value = !quiet; error.value = '';
  if (!quiet) { rows.value = []; decisionBasis.value = {}; }
  try {
    const result = await punishmentApi.listCases({ handoff_id: id, page: 1, size: 100 });
    if (active && seq === token) {
      rows.value = result.items || [];
      const ids = new Set(rows.value.map(row => row.case_id));
      Object.keys(decisionBasis.value).forEach(key => { if (!ids.has(key)) delete decisionBasis.value[key]; });
      // 只读有效决定对应的冻结文书，不能用当前罚则或后来修改的裁量覆盖历史依据。
      for (const row of rows.value.filter(effective)) {
        if (decisionBasis.value[row.case_id]?.documentId !== row.effective_decision.document_id) {
          decisionBasis.value[row.case_id] = { loading: true };
        }
        void loadDecisionBasis(row, seq);
      }
    }
  } catch (e) {
    if (active && seq === token) {
      rows.value = []; decisionBasis.value = {};
      error.value = e.status === 403 ? '当前账号无权查看处罚结果，请联系管理员。' : e.message || '处罚结果读取失败，请刷新重试。';
    }
  } finally { if (active && seq === token) loading.value = false; }
}
async function loadDecisionBasis(row, seq) {
  try {
    const documents = await punishmentApi.listDocuments(row.case_id);
    if (!active || seq !== token) return;
    const document = documents.find(item => item.document_id === row.effective_decision.document_id && item.status === 'ISSUED');
    decisionBasis.value[row.case_id] = document
      ? { documentId: document.document_id, fields: document.fields || {}, simulated: document.template_version?.startsWith('demo') || !!document.fields?.watermark }
      : { error: '未读到本次有效决定的文书依据' };
  } catch (e) {
    if (!active || seq !== token) return;
    decisionBasis.value[row.case_id] = { error: e.status === 403 ? '当前账号无权查看处罚文书依据' : '处罚文书依据读取失败，请刷新结果重试' };
  }
}
const effective = row => row.effective_decision?.status === 'EFFECTIVE';
watch(() => props.handoffId, () => load(), { immediate: true });
defineExpose({ refresh: () => load({ quiet: true }) });
const history = row => (row.effective_decision?.history || []).filter(document => document.document_id !== row.effective_decision?.document_id);
const time = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const money = value => value == null ? '未提供' : `${(Number(value) / 100).toLocaleString('zh-CN')} 元`;
</script>

<template>
  <section class="sect punishment-outcome" aria-label="处罚办理结果" :aria-busy="loading">
    <header><h4>处罚办理结果</h4><button type="button" class="btn sm" :disabled="loading" @click="load">{{ loading ? '正在刷新' : '刷新结果' }}</button></header>
    <p v-if="loading" role="status">正在读取案件办理情况</p>
    <p v-else-if="error" class="po-muted" role="alert">{{ error }}</p>
    <p v-else-if="!rows.length" class="po-muted" role="status">暂无处罚结果</p>
    <article v-for="row in rows" :key="row.case_id">
      <p><b>{{ row.case_no }}</b> · {{ labelOf(CASE_STATUS_LABEL, row.status) }} <span v-if="row.source_mode !== 'live'" class="tag t-amber">{{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</span></p>
      <p v-if="row.simulated || row.source_mode !== 'live'" class="po-muted">历史测试记录，非真实处罚结果。</p>
      <p v-if="effective(row)">当前有效处罚决定</p>
      <p v-else-if="row.effective_decision?.status === 'NONE'" class="po-muted">尚无有效处罚决定</p>
      <p v-else class="po-muted" role="status">有效处罚决定信息暂不可用</p>
      <dl class="kv kv-surface">
        <dt>当事人</dt><dd>{{ row.party_name || '待查明' }}</dd>
        <dt>承办人</dt><dd>{{ row.officer_name || '待指派' }}</dd>
        <template v-if="effective(row)">
          <dt>处罚依据</dt><dd v-if="decisionBasis[row.case_id]?.loading">正在读取文书依据</dd>
          <dd v-else-if="decisionBasis[row.case_id]?.error">{{ decisionBasis[row.case_id].error }}</dd>
          <dd v-else>{{ decisionBasis[row.case_id]?.simulated ? '演示文书，非正式处罚依据' : '本次有效决定书保存的依据' }}</dd>
          <template v-if="decisionBasis[row.case_id]?.fields">
            <dt>违法事由</dt><dd>{{ decisionBasis[row.case_id].fields.violation_title || '文书未记录' }}</dd>
            <dt>法律依据</dt><dd>{{ decisionBasis[row.case_id].fields.legal_basis || '文书未记录' }}</dd>
            <dt>裁量说明</dt><dd>{{ decisionBasis[row.case_id].fields.basis_text || '文书未记录' }}</dd>
          </template>
          <dt>决定书编号</dt><dd>{{ row.effective_decision.document_no }}</dd>
          <dt>决定内容</dt><dd>{{ labelOf(PENALTY_TYPE_LABEL, row.effective_decision.penalty_type) }}</dd>
          <dt>决定罚款金额</dt><dd>{{ money(row.effective_decision.fine_amount) }}</dd>
          <dt>出具时间</dt><dd>{{ time(row.effective_decision.issued_at) }}</dd>
        </template>
        <template v-else-if="row.current_discretion">
          <dt>拟认定事由</dt><dd>{{ ruleReasonText(row.current_discretion.violation_code || row.primary_violation_code) || '未记录' }}</dd>
          <dt>裁量说明</dt><dd>{{ row.current_discretion.basis_text || '未记录' }}</dd>
          <dt>{{ row.current_discretion.status === 'CONFIRMED' ? '已确认裁量' : '拟定内容' }}</dt><dd>{{ labelOf(PENALTY_TYPE_LABEL, row.current_discretion.penalty_type) }}</dd>
          <dt>{{ row.current_discretion.status === 'CONFIRMED' ? '裁量金额' : '拟罚金额' }}</dt><dd>{{ money(row.current_discretion.fine_amount) }}</dd>
        </template>
        <template v-else><dt>案件事由</dt><dd>{{ ruleReasonText(row.primary_violation_code) || '未记录' }}</dd></template>
        <dt v-if="row.withdraw_reason">撤案说明</dt><dd v-if="row.withdraw_reason">{{ row.withdraw_reason }}</dd>
        <dt v-if="row.close_note">结案说明</dt><dd v-if="row.close_note">{{ row.close_note }}</dd>
      </dl>
      <p v-if="effective(row)" class="po-muted">缴款情况以履行凭证为准。</p>
      <details v-if="history(row).length" class="po-history">
        <summary>文书历史（{{ history(row).length }}）</summary>
        <section v-for="document in history(row)" :key="document.document_id">
          <p><b>{{ document.document_no }}</b> · {{ document.status === 'REVOKED' ? '已撤销' : document.status === 'ISSUED' ? '已出具' : '状态待确认' }} <span v-if="document.simulated" class="tag t-amber">演示文书</span></p>
          <p class="po-muted">出具时间：{{ time(document.issued_at) }}</p>
          <p v-if="document.status === 'REVOKED'" class="po-muted">撤销时间：{{ time(document.revoked_at) }}；撤销原因：{{ document.revoke_reason || '未提供' }}</p>
          <p v-else-if="document.simulated" class="po-muted">不作为正式处罚结果。</p>
        </section>
      </details>
    </article>
  </section>
</template>

<style scoped>
.punishment-outcome header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.punishment-outcome h4{margin:0}.punishment-outcome p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}.punishment-outcome article+article{border-top:1px solid var(--line);padding-top:10px}.po-muted{color:var(--muted)}
.po-history{margin-top:10px}.po-history summary{cursor:pointer}.po-history section{padding-top:6px}.po-history section+section{border-top:1px solid var(--line)}
</style>
