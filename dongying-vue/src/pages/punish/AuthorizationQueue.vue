<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import UPanel from '@/components/UPanel.vue';
import UControl from '@/components/form/UControl.vue';
import UPagination from '@/components/UPagination.vue';
import { disposalApi } from '@/services/disposalApi.js';
import { DISPOSAL_ACTION_LABEL, DISPOSAL_CHANNEL_LABEL, SOURCE_MODE_LABEL, disposalStatusText, labelOf } from '@/ui/labels.js';
import { openDisposalApproval, openDisposalExecution, openDisposalManualResult, openDisposalStop } from '@/ui/disposalAuthModal.js';

const rows = ref([]), page = ref(1), total = ref(0), status = ref('REQUESTED');
const loading = ref(false), error = ref('');
const pageSize = ref(20);
const options = [{ label: '全部状态', value: '' }, ...['REQUESTED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED', 'EXPIRED', 'STOPPED', 'CANCELLED'].map(value => ({ value, label: disposalStatusText({ status: value }) }))];
const actions = [
  { codes: ['APPROVE', 'REJECT'], label: '审批', open: openDisposalApproval },
  { codes: ['EXECUTE'], label: '执行', open: openDisposalExecution },
  { codes: ['MANUAL_RESULT'], label: '登记执行结果', open: openDisposalManualResult },
  { codes: ['STOP'], label: '停止', open: openDisposalStop }
];
let request = 0, detailRequest = 0, active = true;
function allowed(row) { return actions.filter(a => a.codes.some(code => row?.allowed_actions?.includes(code))); }
async function load(next = page.value) {
  const seq = ++request;
  loading.value = true; error.value = '';
  try {
    const result = await disposalApi.list({ page: next, size: pageSize.value, ...(status.value ? { status: status.value } : {}) });
    if (!active || seq !== request) return;
    rows.value = result?.items || []; total.value = result?.total || 0; page.value = next;
  } catch (e) {
    if (active && seq === request) { error.value = e.message || '读取处置授权失败'; rows.value = []; }
  } finally { if (active && seq === request) loading.value = false; }
}
async function refresh(id) {
  const seq = ++detailRequest;
  try {
    const detail = await disposalApi.detail(id);
    if (active && seq === detailRequest) await load();
    return detail;
  } catch (e) {
    if (active && seq === detailRequest) error.value = e.message || '读取授权详情失败';
    throw e;
  }
}
function resize(size) { pageSize.value = size; load(1); }
function act(action, row) { action.open({ authorization: row, refresh: () => refresh(row.authorization_id) }); }
onMounted(() => load());
onUnmounted(() => { active = false; request++; });
</script>

<template>
  <UPanel title="处置授权" sub="先申请、由另一人审批、执行并核对设备回执，再提交处罚交接"
    panel-style="flex:1;min-height:0;margin-top:12px;overflow:hidden"
    body-style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
    <div class="toolbar">
      <label>授权状态 <UControl type="select" v-model="status" :options="options" :input-props="{ 'aria-label': '授权状态' }" /></label>
      <button class="btn" :disabled="loading" @click="load(1)">{{ loading ? '正在读取…' : '查询授权' }}</button>
      <button class="btn" :disabled="loading" @click="load()">刷新状态</button>
    </div>
    <div v-if="error" class="warnbox" role="alert">{{ error }}</div>
    <div class="scroll table-scroll table-shell">
      <table class="tb">
        <thead><tr><th>授权编号</th><th>动作 / 来源</th><th>申请人</th><th>审批人</th><th>执行通道</th><th>状态 / 结果</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.authorization_id">
            <td><span class="mono" :title="row.authorization_id">{{ row.authorization_no }}</span></td>
            <td>{{ labelOf(DISPOSAL_ACTION_LABEL, row.action_type) }} · {{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</td>
            <td>{{ row.requested_by_name || '未提供' }}</td><td>{{ row.approved_by_name || '待审批' }}</td>
            <td>{{ labelOf(DISPOSAL_CHANNEL_LABEL, row.channel) }}</td>
            <td>{{ disposalStatusText(row) }}<div v-if="row.result_code">{{ row.result_code }}</div></td>
            <td><div class="actions"><button v-for="action in allowed(row)" :key="action.label" class="btn" @click="act(action, row)">{{ action.label }}</button></div></td>
          </tr>
          <tr v-if="!loading && !rows.length"><td colspan="7" class="empty">当前筛选下没有可见授权，可切换“全部状态”查看已处理记录。</td></tr>
        </tbody>
      </table>
    </div>
    <footer class="pager">
      <UPagination :page="page" :page-size="pageSize" :item-count="total" @update:page="load" @update:page-size="resize" />
    </footer>
  </UPanel>
</template>

<style scoped>
.toolbar { display:flex; gap:12px; flex-wrap:wrap; align-items:end; margin-bottom:12px; flex:none; }
.actions { display:flex; gap:8px; flex-wrap:wrap; }
.tb td { overflow-wrap:anywhere; }
.table-scroll { flex:1; min-height:0; }
.pager { display:flex; justify-content:flex-end; flex:none; padding-top:10px; }
.warnbox { flex:none; }
</style>
