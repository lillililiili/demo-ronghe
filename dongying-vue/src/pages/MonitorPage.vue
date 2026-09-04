<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { NButton, NDataTable, NEmpty, NSpin, NTag } from 'naive-ui';
import UField from '@/components/form/UField.vue';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { deviceApi } from '@/services/deviceApi.js';
import { optionsOf } from '@/ui/formModal.js';

usePageChrome('monitor');
const filters = reactive({ keyword: '', channel: null, type_code: null });
const overview = ref({ total: 0, online: 0, offline: 0, abnormal: 0, unknown: 0, alarm: 0, simulated: false });
const tree = ref([]);
const incidents = ref([]);
const selectedId = ref('');
const state = ref(null);
const events = ref([]);
const eventSeq = ref(0);
const history = ref([]);
const metricCode = ref('link_latency_ms');
const command = ref(null);
const protocolStatus = ref(null);
const radarTargets = ref([]);
const chartEl = ref(null);
const loading = ref(false);
const selectedLoading = ref(false);
const error = ref('');
const selected = computed(() => tree.value.find(item => item.device_id === selectedId.value) || null);
const groups = computed(() => Object.entries(tree.value.reduce((out, item) => {
  (out[item.channel || '未分组'] ||= []).push(item); return out;
}, {})));
const collapsedGroups = ref({});
function isCollapsed(name) { return !!collapsedGroups.value[name]; }
function toggleGroup(name) {
  collapsedGroups.value = { ...collapsedGroups.value, [name]: !collapsedGroups.value[name] };
}
const metricOptions = computed(() => optionsOf((state.value?.metrics || []).map(item => [item.code, `${item.label || item.code}${item.unit ? `（${item.unit}）` : ''}`])));
const terminalCommands = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);
let aggregateTimer = null;
let selectedTimer = null;
let aggregateInFlight = false;
let selectedInFlight = false;
let selectedPending = false;

const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const statusText = value => ({ ONLINE: '在线', OFFLINE: '离线', ABNORMAL: '异常', UNKNOWN: '未知' })[value] || value || '未知';
const statusType = value => ({ ONLINE: 'success', OFFLINE: 'default', ABNORMAL: 'error', UNKNOWN: 'warning' })[value] || 'default';
const healthText = value => ({ GOOD: '良好', DEGRADED: '一般', BAD: '异常', UNKNOWN: '未知' })[value] || '未知';
const PROTOCOL_NAME = {
  RADAR_TCP_V3_0_0: 'T02/兼容机扫雷达 TCP',
  COUNTERMEASURE_TCP_4CH_V2_0: '固定式四通道网络控制器'
};
function protocolLabel(status) {
  const name = PROTOCOL_NAME[status?.protocol_code] || status?.protocol_code || '未配置';
  return status?.protocol_version ? `${name} · v${status.protocol_version}` : name;
}
const kpis = computed(() => [
  { label: '设备总数', value: overview.value.total, color: 'blue', icon: 'device' },
  { label: '在线', value: overview.value.online, color: 'green', icon: 'check' },
  { label: '离线', value: overview.value.offline, color: 'gray', icon: 'alert' },
  { label: '异常', value: overview.value.abnormal, color: 'red', icon: 'alert' },
  { label: '告警中', value: overview.value.alarm, color: 'amber', icon: 'alert' }
]);
const targetColumns = [
  { title: '航迹 ID', key: 'external_track_id', width: 116 },
  { title: '分类', key: 'category_code', width: 110 },
  { title: 'X / Y / Z（m）', key: 'position', width: 190, render: row => `${row.raw_xm ?? '—'} / ${row.raw_ym ?? '—'} / ${row.raw_zm ?? '—'}` },
  { title: 'SNR', key: 'snr_db', width: 80, render: row => row.snr_db == null ? '—' : `${row.snr_db} dB` },
  { title: '更新时间', key: 'last_seen_at', width: 165, render: row => fmtTime(row.last_seen_at) }
];

async function loadAggregate(showBusy = false) {
  if (aggregateInFlight) return;
  aggregateInFlight = true;
  if (showBusy) loading.value = true;
  try {
    const [overviewData, treeData, incidentData] = await Promise.all([
      deviceApi.overview(), deviceApi.tree(filters), deviceApi.incidents({ page: 1, size: 20, stage: 'PENDING' })
    ]);
    overview.value = overviewData; tree.value = treeData.items; incidents.value = incidentData.items;
    if (!tree.value.some(item => item.device_id === selectedId.value)) selectedId.value = tree.value[0]?.device_id || '';
    error.value = '';
  } catch (e) { error.value = e.message || '实时监测数据加载失败'; }
  finally { loading.value = false; aggregateInFlight = false; }
}

async function loadSelected(showBusy = false) {
  if (!selectedId.value) return;
  if (selectedInFlight) { selectedPending = true; return; }
  selectedInFlight = true;
  const requestDeviceId = selectedId.value;
  const requestMetricCode = metricCode.value;
  if (showBusy) selectedLoading.value = true;
  try {
    const [stateData, historyData, eventData, protocolData, targetData] = await Promise.all([
      deviceApi.state(requestDeviceId),
      deviceApi.history(requestDeviceId, { metric_code: requestMetricCode, limit: 120 }),
      deviceApi.events({ device_id: requestDeviceId, after_seq: eventSeq.value, limit: 100 }),
      deviceApi.protocolStatus(requestDeviceId),
      selected.value?.protocol_code === 'RADAR_TCP_V3_0_0'
        ? deviceApi.targets({ device_id: requestDeviceId, active: true, page: 1, size: 20 }) : Promise.resolve({ items: [] })
    ]);
    if (requestDeviceId !== selectedId.value || requestMetricCode !== metricCode.value) return;
    state.value = stateData; history.value = historyData.points; protocolStatus.value = protocolData; radarTargets.value = targetData.items;
    if (eventData.items.length) {
      const merged = new Map([...events.value, ...eventData.items].map(item => [item.event_seq, item]));
      events.value = [...merged.values()].sort((a, b) => a.event_seq - b.event_seq).slice(-100);
    }
    eventSeq.value = eventData.next_seq;
    if (command.value && !terminalCommands.has(command.value.status)) command.value = await deviceApi.command(command.value.command_id);
    error.value = '';
    await nextTick(); paintChart();
  } catch (e) { error.value = e.message || '所选设备状态加载失败'; }
  finally {
    selectedLoading.value = false;
    selectedInFlight = false;
    if (selectedPending) {
      selectedPending = false;
      void loadSelected();
    }
  }
}

function paintChart() {
  if (!chartEl.value) return;
  window.CH.disposeEl(chartEl.value);
  if (!history.value.length) return;
  const metric = state.value?.metrics?.find(item => item.code === metricCode.value);
  window.CH.line(chartEl.value, { x: history.value.map(item => new Date(item.received_at).toLocaleTimeString('zh-CN', { hour12: false })),
    yName: metric?.unit || '', legend: false, series: [{ name: metric?.label || metricCode.value,
      data: history.value.map(item => item.value), area: true, color: '#2dcfd0' }] });
}

function selectDevice(item) {
  selectedId.value = item.device_id; state.value = null; protocolStatus.value = null; radarTargets.value = [];
  history.value = []; events.value = []; eventSeq.value = 0; command.value = null;
}

function applyFilters() { loadAggregate(true).then(() => loadSelected(true)); }

watch(selectedId, () => { if (selectedId.value) loadSelected(true); });
watch(metricCode, () => { history.value = []; loadSelected(true); });
onMounted(async () => {
  await loadAggregate(true); await loadSelected(true);
  aggregateTimer = setInterval(loadAggregate, 10_000);
  selectedTimer = setInterval(loadSelected, 2_000);
});
onUnmounted(() => { clearInterval(aggregateTimer); clearInterval(selectedTimer); window.CH.disposeEl(chartEl.value); });
</script>

<template>
  <div class="view monitor-page" id="view" :aria-busy="loading || selectedLoading">
    <UKpis :list="kpis" variant="compact" />
    <div v-if="error" class="warnbox error-row" role="alert"><span>{{ error }}</span><NButton size="small" @click="applyFilters">重试</NButton></div>
    <div class="monitor-grid">
      <UPanel title="设备树" nopad>
        <div class="tree-filter"><UField v-model="filters.keyword" label="关键词" placeholder="编号或名称" @keyup.enter="applyFilters" /><NButton type="primary" @click="applyFilters">筛选</NButton></div>
        <NSpin :show="loading"><div v-if="tree.length" class="device-tree"><section v-for="[name, items] in groups" :key="name">
          <button type="button" class="group-head" :aria-expanded="!isCollapsed(name)" @click="toggleGroup(name)">
            <i :class="{ folded: isCollapsed(name) }"></i><span>{{ name }}</span><small>{{ items.length }}</small>
          </button>
          <template v-if="!isCollapsed(name)">
            <button v-for="item in items" :key="item.device_id" type="button" :class="{ active:item.device_id===selectedId }" @click="selectDevice(item)">
              <span><b>{{ item.name }}</b><code>{{ item.device_no }}</code></span>
              <NTag size="small" :type="statusType(item.connectivity)" :bordered="false">{{ statusText(item.connectivity) }}</NTag>
            </button>
          </template>
        </section></div><NEmpty v-else-if="!loading" description="没有匹配的设备" class="empty-block" /></NSpin>
      </UPanel>
      <div class="center-column">
        <UPanel title="实时状态" :sub="selected ? selected.device_no : '未选择设备'">
          <NSpin :show="selectedLoading"><template v-if="state"><div class="state-hero"><div><small>连接状态</small><strong>{{ statusText(state.connectivity) }}</strong></div><div><small>健康状态</small><strong>{{ healthText(state.health_code) }}</strong></div><div><small>最后心跳</small><strong class="time-value">{{ fmtTime(state.last_heartbeat_at) }}</strong></div></div><div class="metric-grid"><article v-for="metric in state.metrics" :key="metric.code"><small>{{ metric.label || metric.code }}</small><b>{{ metric.value ?? '—' }} <em>{{ metric.unit || '' }}</em></b><span>{{ metric.source || '来源未声明' }}</span></article></div><div v-if="protocolStatus?.protocol_code" class="protocol-state"><header><b>{{ protocolLabel(protocolStatus) }}</b><NTag size="small" :type="protocolStatus.connection_state==='ONLINE'?'success':'warning'" :bordered="false">{{ statusText(protocolStatus.connection_state) }}</NTag></header><p v-if="protocolStatus.blocking_reason">{{ protocolStatus.blocking_reason }}</p></div><div v-if="command" class="command-card"><div><b>{{ command.command_no }}</b><span>{{ command.simulated ? '模拟回执' : '设备回执' }} · {{ command.status }}</span></div><p>{{ command.result_detail || '指令已排队，等待后端 Worker 处理。' }}</p></div></template><NEmpty v-else description="请选择设备查看状态" /></NSpin>
        </UPanel>
        <UPanel v-if="selected?.protocol_code==='RADAR_TCP_V3_0_0'" title="最近活动航迹" sub="仅展示雷达分类与原始坐标，不推导风险或合法性" nopad><NDataTable v-if="radarTargets.length" :columns="targetColumns" :data="radarTargets" :row-key="row=>row.target_id" :scroll-x="660" :max-height="210" /><NEmpty v-else description="当前没有活动航迹；雷达待机时保持无数据" class="empty-block" /></UPanel>
        <UPanel title="指标曲线" sub="最近 60 分钟，最多 120 点" panel-style="flex:1;min-height:280px" nopad>
          <div class="chart-toolbar"><UField v-model="metricCode" type="select" label="指标" :options="metricOptions" /></div><div v-if="history.length" ref="chartEl" class="metric-chart"></div><NEmpty v-else-if="!selectedLoading" description="该指标暂无上报数据，保持缺失而非补零" class="empty-block" />
        </UPanel>
      </div>
      <div class="right-column">
        <UPanel title="活动告警" :sub="`${incidents.length} 条`" nopad><div v-if="incidents.length" class="feed"><button v-for="item in incidents" :key="item.incident_id" type="button" @click="selectedId=item.device_id"><span><NTag size="small" :type="item.severity==='HIGH'?'error':'warning'" :bordered="false">{{ item.severity }}</NTag><b>{{ item.device_name }}</b></span><p>{{ item.reason }}</p><time>{{ fmtTime(item.detected_at) }}</time></button></div><NEmpty v-else description="当前没有活动告警" class="empty-block" /></UPanel>
        <UPanel title="设备事件流" sub="按序号增量拉取" panel-style="flex:1;min-height:0" nopad><div v-if="events.length" class="event-feed"><article v-for="item in [...events].reverse()" :key="item.event_seq"><i :class="item.level_code"></i><div><b>{{ item.event_type }}</b><p>{{ item.message }}</p><time>#{{ item.event_seq }} · {{ fmtTime(item.occurred_at) }}</time></div></article></div><NEmpty v-else description="暂无设备事件" class="empty-block" /></UPanel>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitor-page{display:flex;flex-direction:column;gap:12px;min-width:0}
.monitor-page :deep(.kpis){margin-bottom:12px}
.monitor-page :deep(.kpi .dt){display:none}
.error-row{display:flex;justify-content:space-between;align-items:center}.monitor-grid{display:grid;grid-template-columns:270px minmax(430px,1fr) 330px;gap:12px;flex:1;min-height:0}.monitor-grid>.panel,.center-column,.right-column{min-width:0;min-height:0}.center-column,.right-column{display:flex;flex-direction:column;gap:12px}.tree-filter{display:grid;gap:8px;padding:10px;border-bottom:1px solid var(--line-1)}.device-tree{height:calc(100vh - 380px);min-height:300px;padding:8px;overflow:auto}.device-tree button,.feed button{width:100%;border:0;text-align:left;color:inherit;background:transparent;cursor:pointer}.device-tree .group-head{display:flex;align-items:center;gap:8px;padding:8px 7px;margin-top:4px;border-radius:6px;color:var(--txt-2)}.device-tree .group-head:hover{background:color-mix(in srgb,var(--blue) 10%,transparent)}.device-tree .group-head i{width:0;height:0;border-style:solid;border-width:5px 0 5px 7px;border-color:transparent transparent transparent var(--txt-3);transform:rotate(90deg);transition:transform .15s}.device-tree .group-head i.folded{transform:rotate(0)}.device-tree .group-head span{flex:1;min-width:0}.device-tree .group-head small{color:var(--txt-3)}.device-tree button:not(.group-head){display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px;border-radius:6px}.device-tree button:not(.group-head):hover,.device-tree button:not(.group-head).active{background:color-mix(in srgb,var(--blue) 14%,transparent)}.device-tree button:not(.group-head) span{display:grid;gap:6px;min-width:0}.device-tree b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-tree code{color:var(--txt-3);font-size:11px}.state-hero{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:10px;align-items:end}.state-hero>div{display:grid;gap:5px}.state-hero small,.metric-grid small{color:var(--txt-3)}.state-hero strong{font-size:19px}.state-hero .time-value{font-size:13px}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:15px}.metric-grid article{display:grid;gap:6px;padding:12px;border:1px solid var(--line-1);border-radius:6px;background:var(--surface-2)}.metric-grid b{font-size:20px;color:var(--cyan)}.metric-grid em{font-size:11px;color:var(--txt-3);font-style:normal}.metric-grid span{font-size:10px;color:var(--txt-3)}.protocol-state{display:grid;gap:9px;margin-top:12px;padding:11px;border:1px solid var(--line-2);border-radius:6px;background:var(--surface-2)}.protocol-state header{display:flex;align-items:center;justify-content:space-between;gap:8px}.protocol-state p{margin:0;color:var(--amber)}.command-card{margin-top:12px;padding:11px;border-left:3px solid var(--amber);background:color-mix(in srgb,var(--amber) 7%,transparent)}.command-card div{display:flex;justify-content:space-between}.command-card span{color:var(--amber)}.command-card p{margin:6px 0 0;color:var(--txt-2)}.chart-toolbar{width:240px;padding:10px 12px 0}.metric-chart{height:240px}.feed{max-height:240px;overflow:auto}.feed button{padding:11px 12px;border-bottom:1px solid var(--line-1)}.feed button span{display:flex;align-items:center;gap:8px}.feed p{margin:7px 0;color:var(--txt-2);line-height:1.5}.feed time,.event-feed time{color:var(--txt-3);font-size:10px}.event-feed{height:100%;overflow:auto;padding:8px 12px}.event-feed article{display:grid;grid-template-columns:10px 1fr;gap:8px;padding:9px 0;border-bottom:1px solid var(--line-1)}.event-feed i{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--blue)}.event-feed i.WARN{background:var(--amber)}.event-feed i.ERROR{background:var(--red)}.event-feed p{margin:4px 0;color:var(--txt-2);line-height:1.45}.empty-block{padding:42px 10px}@media(max-width:1360px){.monitor-grid{grid-template-columns:240px minmax(420px,1fr) 280px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:1050px){.monitor-grid{grid-template-columns:250px minmax(0,1fr)}.right-column{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr}}
</style>
