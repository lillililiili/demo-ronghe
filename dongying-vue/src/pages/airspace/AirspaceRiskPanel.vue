<script setup>
import { computed, ref, watch } from 'vue';
import UControl from '@/components/form/UControl.vue';
import UPagination from '@/components/UPagination.vue';
import { ALTITUDE_DATUM_LABEL, RISK_TYPE_LABEL, RISK_TYPE_OPTIONS, RISK_STATE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';

const props = defineProps({ risks: { type: Object, required: true }, selected: { type: Object, default: null } });
const emit = defineEmits(['locate', 'inspect']);
const tableScroll = ref(null);
// 父组件传入 reactive 包装后的 composable，各字段保持同一份状态。
const page = ref(1), size = ref(10);
const severityOptions = [{ label: '全部等级', value: '' }, ...Object.entries(SEVERITY_LABEL).map(([value, label]) => ({ value, label }))];
const stateOptions = [{ label: '全部状态', value: '' }, ...Object.entries(RISK_STATE_LABEL).map(([value, label]) => ({ value, label }))];
const riskTypeOptions = [{ label: '全部类型', value: '' }, ...RISK_TYPE_OPTIONS];
const scope = computed({ get: () => props.risks.onlySelected ? 'selected' : 'district', set: value => { props.risks.onlySelected = value === 'selected'; } });
const scopeOptions = computed(() => [{ label: '当前区县全部风险', value: 'district' },
  ...(props.selected ? [{ label: '所选空域平面范围内（含边界）', value: 'selected' }] : [])]);
const pageRows = computed(() => props.risks.filtered.slice((page.value - 1) * size.value, page.value * size.value));
watch(() => props.risks.filtered, () => { page.value = 1; });
watch(() => props.risks.activeId, id => {
  const index = props.risks.filtered.findIndex(risk => risk.risk_id === id);
  if (index >= 0) page.value = Math.floor(index / size.value) + 1;
  if (tableScroll.value) tableScroll.value.scrollTop = 0;
});
function date(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
</script>

<template>
  <section class="airspace-risk-panel" aria-label="空域风险">
    <div class="toolbar">
      <div class="toolbar-fields">
        <div class="field"><label>风险范围</label><UControl v-model="scope" type="select" :options="scopeOptions" size="small" /></div>
        <div class="field"><label>风险类型</label><UControl v-model="risks.riskType" type="select" :options="riskTypeOptions" size="small" /></div>
        <div class="field"><label>风险等级</label><UControl v-model="risks.severity" type="select" :options="severityOptions" size="small" /></div>
        <div class="field"><label>核验与通知状态</label><UControl v-model="risks.state" type="select" :options="stateOptions" size="small" /></div>
        <div class="field"><label>发生时间</label><UControl v-model="risks.occurred" type="datetimerange" clearable size="small" start-placeholder="开始时间" end-placeholder="结束时间" /></div>
      </div>
      <div v-if="risks.canRead && !risks.error && !risks.loading" class="risk-summary">{{ risks.filtered.length }} 起 · 待核验 {{ risks.pending }} 起</div>
    </div>
    <div class="risk-scope-note">
      <template v-if="risks.onlySelected && selected">{{ selected.name }}：按地图上的空域范围查看；目标正好在边界上时，是否算进入仍待确认。</template>
      <template v-else>地图显示发现风险时的位置。</template>
      已通知、已回执不代表现场风险已解除。
      <span v-if="risks.canRead && !risks.error && !risks.loading && risks.unlocated">另有 {{ risks.unlocated }} 起未记录有效位置，保留在区县列表中，暂不能确定属于哪片空域。</span>
    </div>
    <div v-if="!risks.canRead" class="empty">当前账号没有查看空域风险的权限。</div>
    <div v-else-if="risks.timeError" class="empty" role="alert">{{ risks.timeError }}</div>
    <div v-else-if="risks.error" class="empty" role="alert">{{ risks.error }} <button v-if="![401, 403].includes(risks.errorStatus)" class="btn" type="button" @click="risks.reload">重试风险</button></div>
    <div v-else-if="risks.loading" class="empty" role="status">正在读取空域风险…</div>
    <div v-else-if="risks.onlySelected && !risks.polygons.length" class="empty">所选空域没有可用的当前边界，无法匹配风险位置。请切换“当前区县全部风险”查看。</div>
    <div v-else-if="!risks.filtered.length" class="empty">当前筛选范围内暂无已记录的风险事件，不代表这片空域当前安全。</div>
    <div v-else ref="tableScroll" class="risk-table-scroll">
      <article v-if="risks.active" class="risk-inline-detail" aria-label="风险详情">
        <header><b>{{ risks.active.risk_no || '风险详情' }}</b><button class="linkbtn" type="button" @click="risks.activeId = ''">收起详情</button></header>
        <dl>
          <dt>风险类型</dt><dd>{{ labelOf(RISK_TYPE_LABEL, risks.active.risk_type, '其他风险') }}</dd>
          <dt>风险等级 / 状态</dt><dd>{{ labelOf(SEVERITY_LABEL, risks.active.severity, '未知') }} · {{ labelOf(RISK_STATE_LABEL, risks.active.state, '未知') }}</dd>
          <dt>风险事由</dt><dd>{{ risks.active.reason_text || '未记录风险事由' }}</dd>
          <dt>发生时间</dt><dd>{{ date(risks.active.occurred_at) }}</dd>
          <dt>接收时间</dt><dd>{{ date(risks.active.received_at) }}</dd>
          <dt>发现时的位置</dt><dd>{{ risks.active.point ? `${risks.active.point[0]}, ${risks.active.point[1]}（经度、纬度）` : '位置未记录，无法定位' }}</dd>
          <dt>测得高度</dt><dd>{{ risks.active.observed_altitude_m == null ? '未记录' : `${risks.active.observed_altitude_m} 米 · ${labelOf(ALTITUDE_DATUM_LABEL, risks.active.observed_altitude_datum, '高度基准未记录')}` }}</dd>
          <dt>关联计划</dt><dd>{{ risks.active.plan_no || (risks.active.plan_id ? '已关联计划' : '没有可查看的相关计划') }}</dd>
          <dt>来源</dt><dd>{{ risks.active.source_name || risks.active.source_code || '未记录' }} · {{ labelOf(SOURCE_MODE_LABEL, risks.active.source_mode, '来源未记录') }}</dd>
        </dl>
      </article>
      <table class="tb">
        <thead><tr><th>风险编号 / 类型</th><th>风险事由</th><th>等级</th><th>核验与通知状态</th><th>发生时间</th><th>关联计划（如有）</th><th>位置 / 来源</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="risk in pageRows" :key="risk.risk_id" :class="{ on: risks.activeId === risk.risk_id }">
            <td><b>{{ risk.risk_no || '未编业务编号' }}</b><small>{{ labelOf(RISK_TYPE_LABEL, risk.risk_type, '其他风险') }}</small></td>
            <td class="risk-reason">{{ risk.reason_text || '未记录风险事由' }}</td>
            <td><span class="tag" :class="SEVERITY_TAG[risk.severity] || 't-gray'">{{ labelOf(SEVERITY_LABEL, risk.severity, '未知') }}</span></td>
            <td>{{ labelOf(RISK_STATE_LABEL, risk.state, '未知') }}</td>
            <td>{{ date(risk.occurred_at) }}</td>
            <td>{{ risk.plan_no || (risk.plan_id ? '已关联计划' : '没有可查看的相关计划') }}</td>
            <td>{{ risk.point ? (risks.onlySelected && risk.relation === 'BOUNDARY' ? '位于边界，归属待确认' : '已记录发现位置') : '位置未记录' }}<small>{{ labelOf(SOURCE_MODE_LABEL, risk.source_mode, '来源未记录') }}</small></td>
            <td class="risk-actions"><button class="linkbtn" type="button" :disabled="!risk.point" :title="risk.point ? '定位发现时的位置' : '位置无法确认，暂时无法定位'" @click="emit('locate', risk)">定位</button><button type="button" class="linkbtn" @click="emit('inspect', risk)">查看详情</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="risks.canRead && !risks.error && !risks.loading && risks.filtered.length" class="pager"><UPagination v-model:page="page" v-model:page-size="size" :item-count="risks.filtered.length" /></div>
  </section>
</template>

<style scoped>
.airspace-risk-panel { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.toolbar { flex: none; flex-wrap: wrap; gap: 8px; }
.risk-summary { color: var(--txt-2); font-size: 12px; margin-left: auto; }
.risk-scope-note { flex: none; padding: 7px 12px; font-size: 12px; line-height: 1.6; color: var(--txt-3); border-bottom: 1px solid var(--line); }
.risk-scope-note span { display: block; }
.risk-table-scroll { flex: 1; min-height: 0; overflow: auto; }
.tb { min-width: 1080px; width: 100%; }
.tb td { vertical-align: top; }
.tb small { display: block; margin-top: 3px; color: var(--txt-3); }
.risk-reason { min-width: 210px; max-width: 320px; white-space: normal; overflow-wrap: anywhere; }
.risk-actions { white-space: nowrap; }
.risk-actions .linkbtn + .linkbtn { margin-left: 10px; }
.risk-inline-detail { padding: 12px; border-bottom: 1px solid var(--line); background: var(--surface-1); }
.risk-inline-detail header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.risk-inline-detail dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px 12px; font-size: 13px; }
.risk-inline-detail dt { color: var(--txt-3); }
.risk-inline-detail dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.linkbtn { border: 0; background: transparent; color: var(--blue); padding: 3px 0; font-size: 12.5px; cursor: pointer; text-decoration: none; }
.linkbtn:hover { text-decoration: underline; }
.linkbtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.toolbar-fields > .field:first-child { min-width: 295px; }
.toolbar-fields > .field:first-child :deep(.n-select) { width: 250px; min-width: 250px; }
.risk-actions button:disabled { opacity: .45; cursor: not-allowed; }
.empty { flex: 1; }
.pager { flex: none; }
</style>
