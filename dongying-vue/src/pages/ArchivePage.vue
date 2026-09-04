<script setup>
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NDataTable, NSpin, NTag } from 'naive-ui';
import { UField } from '@/components/form/index.js';
import UPagination from '@/components/UPagination.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { hasPermission } from '@/services/accessControl.js';
import { systemApi } from '@/services/systemAdmin.js';
import { actionOptions, actionText, moduleOptions, moduleText, roleText } from './system/auditLabels.js';
import { openModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';

usePageChrome('archive');
const loading = ref(false);
const exporting = ref(false);
const error = ref('');
const rows = ref([]);
const roles = ref([]);
const page = ref(1);
const size = ref(20);
const total = ref(0);
const RANGE_DEFAULT_TIME = ['00:00:00', '23:59:59'];
const filters = reactive({ range: null, account: '', module: null, action: null, result: null });
const resultOptions = [{ value: 'SUCCESS', label: '成功' }, { value: 'FAILURE', label: '失败' }];
const roleNames = computed(() => {
  const names = { 'ROLE-ADMIN': '超级管理员' };
  for (const item of roles.value) names[item.role_code] = item.name;
  return names;
});

function params(includePage = true) {
  const from = Array.isArray(filters.range) ? filters.range[0] : null;
  const to = Array.isArray(filters.range) ? filters.range[1] : null;
  return {
    from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null,
    account: filters.account.trim(), module: filters.module || '', action: filters.action || '',
    result: filters.result,
    ...(includePage ? { page: page.value, size: size.value } : {})
  };
}
function dt(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function resultText(value) { return value === 'SUCCESS' ? '成功' : value === 'FAILURE' ? '失败' : value || '—'; }
function roleLabel(code) { return roleText(code, roleNames.value); }

async function load() {
  loading.value = true; error.value = '';
  try {
    const [data, roleList] = await Promise.all([
      systemApi.audits(params()),
      roles.value.length ? Promise.resolve(roles.value) : systemApi.roles().catch(() => [])
    ]);
    rows.value = data.items; total.value = data.total;
    if (!roles.value.length) roles.value = roleList;
  } catch (e) { error.value = e.message || '审计日志加载失败。'; }
  finally { loading.value = false; }
}
function search() { page.value = 1; load(); }
function reset() {
  Object.assign(filters, { range: null, account: '', module: null, action: null, result: null });
  search();
}
function onPageSize(value) { size.value = value; page.value = 1; load(); }

function detail(row) {
  openModal({
    title: `审计详情 · ${row.audit_id}`, width: '720px',
    render: () => h('div', { class: 'audit-detail' }, [
      h('dl', [
        h('dt', '时间'), h('dd', dt(row.occurred_at)), h('dt', '用户'), h('dd', `${row.account || '—'}（${roleLabel(row.role_code)}）`),
        h('dt', '模块'), h('dd', moduleText(row.module_code)), h('dt', '动作'), h('dd', actionText(row.action)),
        h('dt', '结果'), h('dd', resultText(row.result)), h('dt', 'IP'), h('dd', row.ip || '—'),
        h('dt', 'User-Agent'), h('dd', row.user_agent || '—'), h('dt', '详情'), h('dd', row.detail || '—')
      ])
    ])
  });
}

async function exportCsv() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const blob = await systemApi.auditCsv(params(false));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    toast('审计日志已导出', 'ok');
  } catch (e) { toast(e.message || '导出失败', 'err'); }
  finally { exporting.value = false; }
}

const auditColumns = computed(() => [
  { title: '时间', key: 'occurred_at', width: 180, render: row => h('span', { class: 'mono' }, dt(row.occurred_at)) },
  { title: '账号', key: 'account', width: 120, ellipsis: { tooltip: true }, render: row => row.account || '—' },
  { title: '角色', key: 'role_code', width: 130, ellipsis: { tooltip: true }, render: row => roleLabel(row.role_code) },
  { title: '模块', key: 'module_code', width: 130, render: row => moduleText(row.module_code) },
  { title: '动作', key: 'action', width: 150, ellipsis: { tooltip: true }, render: row => actionText(row.action) },
  { title: '结果', key: 'result', width: 88, render: row => h(NTag, { size: 'small', type: row.result === 'SUCCESS' ? 'success' : 'error', bordered: false }, { default: () => resultText(row.result) }) },
  { title: 'IP', key: 'ip', width: 130, render: row => h('span', { class: 'mono' }, row.ip || '—') },
  { title: '操作', key: 'actions', width: 80, render: row => h(NButton, { text: true, type: 'primary', onClick: () => detail(row) }, { default: () => '详情' }) }
]);

onMounted(load);
</script>

<template>
  <div class="view audit-api-view">
    <section class="panel audit-api-panel">
      <header class="ph audit-heading"><div><h2>审计日志</h2><p>日志只读且不可删除；查询与 CSV 导出使用相同筛选条件。</p></div><n-button type="primary" :loading="exporting" :disabled="!hasPermission('audit.op')" @click="exportCsv">导出 CSV</n-button></header>
      <form class="audit-filter" @submit.prevent="search">
        <UField class="audit-time" v-model="filters.range" variant="toolbar" type="datetimerange" label="时间"
          start-placeholder="开始时间" end-placeholder="结束时间" :default-time="RANGE_DEFAULT_TIME" clearable />
        <UField v-model="filters.account" variant="toolbar" label="账号" placeholder="账号" clearable />
        <UField v-model="filters.module" variant="toolbar" label="模块" type="select" :options="moduleOptions" clearable placeholder="全部模块" />
        <UField v-model="filters.action" variant="toolbar" label="动作" type="select" :options="actionOptions" clearable placeholder="全部动作" />
        <UField v-model="filters.result" variant="toolbar" label="结果" type="select" :options="resultOptions" clearable placeholder="全部结果" />
        <div class="toolbar-actions"><n-button type="primary" attr-type="submit">查询</n-button><n-button @click="reset">重置</n-button></div>
      </form>
      <p v-if="error" class="audit-error" role="alert">{{ error }} <button type="button" @click="load">重试</button></p>
      <n-spin :show="loading">
        <div class="naive-table-fill">
          <n-data-table :columns="auditColumns" :data="rows" :row-key="row => row.audit_id" :bordered="false" :single-line="true" size="small" flex-height :scroll-x="1100" />
        </div>
        <footer class="pager-row"><span>共 {{ total }} 条，默认按时间倒序。单次 CSV 导出上限 50,000 条。</span>
          <UPagination v-model:page="page" v-model:page-size="size" :item-count="total" @update:page="load" @update:page-size="onPageSize" />
        </footer>
      </n-spin>
    </section>
  </div>
</template>

<style scoped>
.audit-api-view { display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.audit-api-panel { display:flex; flex:1; min-height:0; flex-direction:column; overflow:hidden; }
.audit-heading { display:flex; flex:none; justify-content:space-between; align-items:center; gap:16px; }
.audit-heading h2, .audit-heading p { margin:0; }.audit-heading p { margin-top:5px; color:var(--txt-3); }
.audit-filter { display:flex; flex:none; flex-wrap:wrap; align-items:end; gap:10px; padding:14px 16px; border-bottom:1px solid var(--line); }
.audit-filter .audit-time { flex:1 1 28em; min-width:min(28em, 100%); max-width:40em; }
.audit-filter .audit-time :deep(.u-field__control) { min-width:22em; }
.audit-filter .u-field:not(.audit-time) { flex:1 1 10em; min-width:9em; max-width:16em; }
.audit-api-panel :deep(.n-spin-container), .audit-api-panel :deep(.n-spin-content) { display:flex; flex:1; min-height:0; flex-direction:column; overflow:hidden; }
.audit-error { flex:none; margin:12px 16px; padding:11px 13px; border:1px solid var(--red); border-radius:6px; color:var(--red); background:color-mix(in srgb, var(--red) 10%, transparent); }
:global(.audit-detail dl) { display:grid; grid-template-columns:110px 1fr; gap:12px; }
:global(.audit-detail dt) { color:var(--txt-3); }
:global(.audit-detail dd) { margin:0; word-break:break-word; }
@media (max-width:760px) { .audit-filter .audit-time, .audit-filter .u-field:not(.audit-time) { flex:1 1 100%; min-width:0; max-width:none; }.audit-filter .audit-time :deep(.u-field__control) { min-width:0; }.pager-row { align-items:flex-start; flex-direction:column; } }
</style>
