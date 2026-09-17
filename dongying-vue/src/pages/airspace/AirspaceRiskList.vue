<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import UField from '@/components/form/UField.vue';
import { FunnelOutline } from '@vicons/ionicons5';
import { RISK_TYPE_LABEL, RISK_TYPE_OPTIONS, RISK_STATE_LABEL,
  SEVERITY_LABEL, SEVERITY_TAG, targetTypeLabel, labelOf } from '@/ui/labels.js';
import { DEMO_FRAMES, DEMO_SCENES } from './airspaceMonitorDemo.js';

const props = defineProps({ list: { type: Object, required: true }, monitor: { type: Object, required: true },
  risks: { type: Object, required: true }, selected: { type: Object, default: null } });
const emit = defineEmits(['inspect']);
const recordScroll = ref(null);
watch(() => props.list.page, () => recordScroll.value?.scrollTo({ top: 0 }));
watch(() => props.list.active?.key, async () => {
  await nextTick();
  const list = recordScroll.value, active = list?.querySelector('.risk-record.on');
  if (!active) return;
  const itemRect = active.getBoundingClientRect(), listRect = list.getBoundingClientRect();
  if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
    list.scrollBy({ top: itemRect.top - listRect.top });
  }
});
const notesOpen = ref(false);
const filtersOpen = ref(false);
const filterToggle = ref(null);
const filterPanel = ref(null);
const monitorIcon = window.UI.icon('radar');
const modes = [{ value: 'demo', label: '模拟演示' }, { value: 'live', label: '接口监测数据' }];
const scenes = [{ value: '', label: '全部重点区域' }, ...DEMO_SCENES.map(item => ({ value: item.id, label: item.label }))];
const minutesOptions = [5, 15, 60].map(value => ({ value, label: `最近 ${value} 分钟` }));
const typeOptions = [{ value: '', label: '全部类型' }, ...RISK_TYPE_OPTIONS, { value: 'UNCLASSIFIED', label: '未分类' }];
const severityOptions = [{ value: '', label: '全部等级' }, ...Object.entries(SEVERITY_LABEL).map(([value, label]) => ({ value, label }))];
const stateLabels = { ...RISK_STATE_LABEL, DEMO: '模拟监测', UNRECORDED: '未记录风险' };
const stateOptions = [{ value: '', label: '全部状态' }, ...Object.entries(stateLabels).map(([value, label]) => ({ value, label }))];
const scope = computed({ get: () => props.risks.onlySelected ? 'selected' : 'district',
  set: value => { props.risks.onlySelected = value === 'selected'; } });
const scopeOptions = computed(() => [{ value: 'district', label: '当前区县全部' },
  ...(props.selected ? [{ value: 'selected', label: props.selected.name || '所选空域' }] : [])]);
const appliedFilters = computed(() => {
  const { monitor, risks, selected } = props;
  return [
    monitor.isDemo && monitor.scene ? { key: 'scene', text: `重点区域：${scenes.find(item => item.value === monitor.scene)?.label || monitor.scene}` } : null,
    !monitor.isDemo && monitor.minutes !== 5 ? { key: 'window', text: `监测窗口：最近 ${monitor.minutes} 分钟` } : null,
    risks.onlySelected && selected ? { key: 'scope', text: `范围：${selected.name || '所选空域'}` } : null,
    risks.riskType ? { key: 'type', text: `风险类型：${typeOptions.find(item => item.value === risks.riskType)?.label || risks.riskType}` } : null,
    risks.severity ? { key: 'severity', text: `等级：${labelOf(SEVERITY_LABEL, risks.severity, risks.severity)}` } : null,
    risks.state ? { key: 'state', text: `状态：${labelOf(stateLabels, risks.state, risks.state)}` } : null,
    risks.occurred ? { key: 'time', text: `时间：${time(risks.occurred[0])} 至 ${time(risks.occurred[1])}` } : null
  ].filter(Boolean);
});
const moreFilterCount = computed(() => appliedFilters.value.filter(item => !['type', 'severity'].includes(item.key)).length);
function clearFilter(key) {
  const { monitor, risks } = props;
  if (key === 'scene') monitor.scene = '';
  else if (key === 'window') monitor.minutes = 5;
  else if (key === 'scope') risks.onlySelected = false;
  else if (key === 'type') risks.riskType = '';
  else if (key === 'severity') risks.severity = '';
  else if (key === 'state') risks.state = '';
  else if (key === 'time') risks.occurred = null;
}
function resetFilters() { appliedFilters.value.forEach(item => clearFilter(item.key)); }
async function toggleFilters() {
  filtersOpen.value = !filtersOpen.value;
  notesOpen.value = false;
  if (filtersOpen.value) { await nextTick(); filterPanel.value?.focus({ preventScroll: true }); }
}
function closeFilters() { filtersOpen.value = false; filterToggle.value?.focus({ preventScroll: true }); }
function time(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function title(row) { return row.target?.target_no || row.risk?.risk_no || '未编号'; }
function typeLabel(row) { return row.target ? targetTypeLabel(row.target.subtype, row.target.object_type_code, '未分类')
  : labelOf(RISK_TYPE_LABEL, row.type, '未分类'); }
function isMock(row) { return !!row.target?.demo || row.risk?.source_mode === 'mock' || row.target?.source_mode === 'mock'; }
const pageCount = computed(() => Math.max(1, Math.ceil(props.list.rows.length / props.list.size)));
const pageSizes = [10, 20, 50].map(value => ({ value, label: `${value} 条/页` }));
function summary(row) {
  return row.target?.demo ? `${row.target.demo.scene.label} · ${Math.round(row.target.demo.distance)} 米`
    : row.risk?.reason_text || (row.risk ? '未记录风险事由' : row.target?.risk_summary ? '已有风险摘要' : '近期监测发现，尚无风险记录');
}
</script>

<template>
  <section class="airspace-risk-list" aria-label="空域风险列表">
    <div class="monitor-controls">
      <div class="monitor-control-head">
        <h3><span class="monitor-title-icon" aria-hidden="true" v-html="monitorIcon"></span>空域监测</h3>
        <UField id="airspace-monitor-mode" v-model="monitor.mode" class="monitor-mode" label="监测数据" variant="toolbar" type="select" :options="modes" size="small" />
        <div class="quick-filters" role="group" aria-label="常用筛选">
          <span class="filter-label"><FunnelOutline aria-hidden="true" />筛选</span>
          <UField id="airspace-monitor-type" v-model="risks.riskType" class="quick-type" label="风险类型" variant="toolbar" type="select" :options="typeOptions" size="small" />
          <UField id="airspace-monitor-severity" v-model="risks.severity" class="quick-severity" label="等级" variant="toolbar" type="select" :options="severityOptions" size="small" />
          <button ref="filterToggle" class="btn filter-toggle" type="button" :aria-expanded="filtersOpen" aria-controls="airspace-more-filters" @click="toggleFilters">{{ filtersOpen ? '收起筛选' : '更多筛选' }}<span v-if="moreFilterCount" class="filter-count">{{ moreFilterCount }}</span><span aria-hidden="true">{{ filtersOpen ? '⌃' : '⌄' }}</span></button>
        </div>
        <div v-if="monitor.isDemo && monitor.canRead" class="playback">
          <span class="tag t-purple">模拟第 {{ monitor.frame + 1 }}/{{ DEMO_FRAMES }} 帧</span>
          <button class="btn pri" type="button" @click="monitor.paused = !monitor.paused">{{ monitor.paused ? '播放模拟' : '暂停模拟' }}</button>
          <button class="btn ghost" type="button" @click="monitor.paused = true; monitor.stepDemo()">下一帧</button>
        </div>
        <span v-else-if="!monitor.isDemo && monitor.canRead" class="update">最近 {{ monitor.minutes }} 分钟 · 每 10 秒刷新<template v-if="monitor.updatedAt"> · {{ time(monitor.updatedAt) }}</template></span>
      </div>
      <section v-show="filtersOpen" id="airspace-more-filters" ref="filterPanel" tabindex="-1" class="more-filters" aria-label="更多筛选条件" @keydown.esc.stop="closeFilters">
        <div class="filter-panel-head"><b>更多筛选</b><span>选择后即时生效</span><button class="linkbtn" type="button" @click="closeFilters">收起筛选面板</button></div>
        <div class="monitor-filter-grid">
        <UField v-if="monitor.isDemo" id="airspace-monitor-scene" v-model="monitor.scene" label="重点区域" type="select" :options="scenes" size="small" />
        <UField v-else id="airspace-monitor-window" v-model="monitor.minutes" label="近期监测窗口" type="select" :options="minutesOptions" size="small" />
        <UField id="airspace-monitor-scope" v-model="scope" label="范围" type="select" :options="scopeOptions" size="small" />
        <UField id="airspace-monitor-state" v-model="risks.state" label="状态" type="select" :options="stateOptions" size="small" />
        <UField id="airspace-monitor-time" v-model="risks.occurred" class="monitor-time" label="发生 / 发现时间" type="datetimerange" clearable size="small" start-placeholder="开始时间" end-placeholder="结束时间" />
      </div>
      </section>
      <div v-if="appliedFilters.length" class="applied-filters" aria-label="已选筛选条件">
        <span>已选 {{ appliedFilters.length }} 项</span>
        <button v-for="item in appliedFilters" :key="item.key" class="filter-chip" type="button" :title="item.text" :aria-label="`移除${item.text}`" @click="clearFilter(item.key)">{{ item.text }}<span aria-hidden="true"> ×</span></button>
        <button class="linkbtn clear-filters" type="button" @click="resetFilters">清空筛选</button>
      </div>
      <div class="monitor-note-bar">
        <p v-if="list.unlocated" class="location-warning" role="status"><strong>{{ list.unlocated }} 条</strong>记录缺少有效位置，可查看详情，无法定位。</p>
        <button class="linkbtn notes-toggle" type="button" :aria-expanded="notesOpen" aria-controls="airspace-monitor-notes" @click="notesOpen = !notesOpen; filtersOpen = false">监测说明 <span>{{ notesOpen ? '收起' : '展开' }}</span></button>
      </div>
      <div v-show="notesOpen" id="airspace-monitor-notes" class="monitor-notes">
        <p v-if="monitor.isDemo">模拟观测每 10 秒更新；距离为水平距离，高度为海拔高度。</p>
        <p>风险位置为发现时快照，监测位置为最近观测；通知与风险解除分别记录。</p>
        <p v-if="risks.onlySelected && selected">按 {{ selected.name }} 的平面范围筛选（含边界），不直接判定进入管制高度或违规。</p>
      </div>
    </div>
    <section class="risk-records-panel panel" aria-label="风险与监测记录">
      <div class="records-head"><b>风险与监测记录</b><span>{{ list.rows.length }} 条</span></div>
    <div v-if="!monitor.canRead || !risks.canRead" class="list-note" role="status">{{ !monitor.canRead ? '没有监测目标查看权限。' : '' }}{{ !risks.canRead ? '没有风险记录查看权限。' : '' }}仅展示有权限读取的内容。</div>
    <div v-if="monitor.error" class="list-note" role="alert">{{ monitor.error }}<button v-if="![401, 403].includes(monitor.errorStatus)" class="btn" type="button" @click="monitor.reload">重试监测</button></div>
    <div v-if="risks.error" class="list-note" role="alert">{{ risks.error }}<button v-if="![401, 403].includes(risks.errorStatus)" class="btn" type="button" @click="risks.reload">重试风险记录</button></div>
    <div v-if="monitor.loading || risks.loading" class="list-note" role="status">正在读取数据，已读取的内容先显示。</div>
    <div v-if="risks.timeError" class="empty" role="alert">{{ risks.timeError }}</div>
    <div v-else-if="risks.onlySelected && selected && !risks.polygons.length" class="empty">这片空域没有可用的当前边界，请切换“当前区县全部”查看。</div>
    <div v-else-if="!list.rows.length" class="empty">{{ monitor.loading || risks.loading ? '正在读取' : monitor.error || risks.error || !monitor.canRead || !risks.canRead ? '可读取的数据中没有匹配项，完整情况待确认。' : '当前筛选下没有记录。' }}</div>
    <div v-else ref="recordScroll" class="risk-record-scroll" aria-label="风险记录列表">
      <button v-for="row in list.pageRows" :key="row.key" class="risk-record" :class="{ on: list.active?.key === row.key }" type="button" :aria-pressed="list.active?.key === row.key" :aria-label="`${title(row)}，查看详情`" @click="emit('inspect', row)">
        <span class="record-heading"><b>{{ title(row) }}</b><span class="tag" :class="SEVERITY_TAG[row.severity] || 't-gray'">{{ labelOf(SEVERITY_LABEL, row.severity, '未判定') }}</span></span>
        <span class="record-state">{{ typeLabel(row) }}<span v-if="isMock(row)" class="tag t-amber">模拟</span><span>{{ labelOf(stateLabels, row.state, '状态未记录') }}</span></span>
        <span class="record-summary" :title="summary(row)">{{ summary(row) }}</span>
        <span class="record-bottom"><span>{{ time(row.at) }}</span><span>{{ list.active?.key === row.key ? '正在查看' : '查看详情' }}</span></span>
      </button>
    </div>
    <div v-if="list.rows.length" class="record-pager">
      <span>第 {{ list.page }} / {{ pageCount }} 页</span>
      <button class="btn ghost" type="button" :disabled="list.page <= 1" @click="list.page--">上一页</button>
      <button class="btn ghost" type="button" :disabled="list.page >= pageCount" @click="list.page++">下一页</button>
      <UField v-model="list.size" label="每页条数" sr-only type="select" :options="pageSizes" size="small" />
    </div>
    </section>
  </section>
</template>

<style scoped>
.airspace-risk-list { display: contents; }
.monitor-controls { grid-area: filters; border: 1px solid var(--line); border-radius: 8px; min-width: 0; position: relative; z-index: 3; flex: none; border-bottom: 1px solid var(--line); background: var(--panel-2); }
.monitor-control-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid var(--line-2); }
.monitor-control-head h3 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--txt); font-size: 14px; white-space: nowrap; }
.monitor-title-icon { display: flex; color: var(--cyan); }
.monitor-title-icon :deep(svg) { width: 18px; height: 18px; }
.monitor-mode { width: 190px; max-width: 100%; }
.playback { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; font-size: 12px; color: var(--txt-2); }
.playback .btn { min-height: 32px; }
.update { margin-left: auto; font-size: 12px; color: var(--txt-2); }
.quick-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.filter-label { display: flex; align-items: center; gap: 4px; color: var(--txt-2); font-size: 12px; }
.filter-label :deep(svg) { width: 15px; height: 15px; }
.quick-type { width: 195px; }.quick-severity { width: 155px; }
.filter-toggle { gap: 6px; white-space: nowrap; }
.filter-toggle[aria-expanded="true"] { color: var(--cyan); border-color: var(--cyan); }
.filter-count { padding: 0 5px; background: var(--surface-1); border-radius: 8px; font-size: 12px; }
.more-filters { position: absolute; top: 100%; left: 10px; right: 10px; padding: 12px; max-height: 230px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-1); box-shadow: var(--shadow); }
.filter-panel-head { display: flex; align-items: center; gap: 12px; font-size: 13px; }
.filter-panel-head > span { color: var(--txt-3); font-size: 12px; }.filter-panel-head > button { margin-left: auto; }
.monitor-filter-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(320px, 1.8fr); gap: 10px 14px; padding-top: 12px; }
.applied-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; max-height: 64px; overflow: auto; padding: 6px 12px; font-size: 12px; color: var(--txt-2); }
.filter-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 360px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border: 1px solid var(--line); border-radius: 4px; padding: 3px 7px; background: var(--surface-1); color: var(--txt); font: inherit; cursor: pointer; }
.clear-filters { margin-left: auto; }
.filter-chip:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.monitor-filter-grid :deep(.u-field) { gap: 5px; }
.monitor-filter-grid :deep(.u-field > label) { font-size: 12px; color: var(--txt-2); }
.monitor-note-bar { display: flex; align-items: center; gap: 12px; min-height: 35px; padding: 5px 14px; border-top: 1px solid var(--line-2); }
.location-warning { margin: 0; color: var(--amber); font-size: 12px; line-height: 1.6; }
.location-warning strong { font-weight: 600; }
.notes-toggle { margin-left: auto; flex: none; }
.notes-toggle span { margin-left: 6px; font-size: 11px; color: var(--txt-2); }
.monitor-notes { position: absolute; top: 100%; left: 10px; right: 10px; max-height: 160px; overflow: auto; box-shadow: var(--shadow); padding: 8px 14px; border-top: 1px solid var(--line-2); background: var(--surface-1); color: var(--txt-2); font-size: 12px; line-height: 1.7; }
.monitor-notes p { margin: 0; }
.monitor-notes p + p { margin-top: 4px; }
.list-note { flex: none; padding: 7px 12px; border-bottom: 1px solid var(--line); font-size: 12px; line-height: 1.6; color: var(--txt-3); }
.risk-records-panel { grid-area: records; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.records-head { display: flex; flex: none; justify-content: space-between; padding: 11px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }.records-head span { color: var(--txt-3); }
.risk-record-scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding: 8px; scrollbar-gutter: stable; scrollbar-width: auto; scrollbar-color: auto; }
.risk-record-scroll::-webkit-scrollbar { width: 10px; }
.risk-record-scroll::-webkit-scrollbar-track { background: var(--panel-2); }
.risk-record-scroll::-webkit-scrollbar-thumb { background: var(--txt-3); border: 2px solid var(--panel-2); border-radius: 6px; }
.risk-record { display: grid; flex: none; gap: 4px; width: 100%; min-width: 0; padding: 8px; text-align: left; background: var(--surface-1); color: var(--txt); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.record-heading .tag { padding: 1px 5px; font-size: 11px; line-height: 16px; }
.risk-record:hover { border-color: var(--page-accent); }.risk-record.on { border-color: var(--page-accent); box-shadow: inset 3px 0 var(--page-accent); background: color-mix(in srgb, var(--page-accent) 9%, var(--surface-1)); }
.risk-record:focus-visible { outline: 2px solid var(--page-accent); outline-offset: -2px; }
.record-heading { display: flex; align-items: flex-start; gap: 6px; justify-content: space-between; }.record-heading b { min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.5; }.record-heading .tag { flex: none; }
.record-state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--txt-3); font-size: 11px; }.record-state .tag { padding: 0 5px; font-size: 10px; }
.record-summary { color: var(--txt-2); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.record-bottom { display: flex; justify-content: space-between; gap: 6px; color: var(--txt-3); font-size: 10px; line-height: 1.5; }.record-bottom > span:last-child { flex: none; color: var(--page-accent); }
.record-pager { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border-top: 1px solid var(--line); font-size: 11px; color: var(--txt-3); }.record-pager .btn { padding: 4px 7px; font-size: 11px; }.record-pager .u-field { width: 95px; margin-left: auto; }
.linkbtn { border: 0; background: transparent; color: var(--blue); padding: 3px 0; font-size: 12.5px; cursor: pointer; }
.linkbtn + .linkbtn { margin-left: 10px; }
.linkbtn:disabled { opacity: .45; cursor: not-allowed; }
.linkbtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.empty { flex: 1; min-height: 160px; }
@container (max-width: 900px) {
  .monitor-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }

  .playback, .update { margin-left: 0; }
}
@container (max-width: 520px) {
  .monitor-control-head { gap: 10px; }
  .monitor-filter-grid { grid-template-columns: minmax(0, 1fr); }
  .monitor-note-bar { align-items: flex-start; flex-wrap: wrap; }
}
</style>
