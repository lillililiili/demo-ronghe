<script setup>
import { computed, h, onMounted, onUnmounted, reactive, ref } from 'vue';
import { NButton, NDataTable, NEmpty, NSpin, NTag } from 'naive-ui';
import UField from '@/components/form/UField.vue';
import UFieldGrid from '@/components/form/UFieldGrid.vue';
import UPanel from '@/components/UPanel.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { canRouteAction } from '@/services/accessControl.js';
import { commissionApi, deviceApi } from '@/services/deviceApi.js';
import { closeModal, openModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';

usePageChrome('commission');
const devices = ref([]);
const selectedDeviceId = ref(null);
const tasks = ref([]);
const taskTotal = ref(0);
const active = ref(null);
const events = ref([]);
const afterSeq = ref(0);
const report = ref(null);
const loading = ref(false);
const actionBusy = ref(false);
const error = ref('');
const canOperate = computed(() => canRouteAction('commission', 'op'));
const terminal = new Set(['PASSED', 'FAILED', 'UNTESTABLE', 'CANCELLED']);
let pollTimer = null;
let listTimer = null;
let pollInFlight = false;

const config = reactive({ transport: 'TCP', host: '', port: 9001, path: '', data_format: 'JSON', charset_name: 'UTF-8',
  auth_mode: 'Token', credential_ref: '', heartbeat_interval_seconds: 30, report_interval_millis: 1000, sampling_rate_hz: null,
  compression_enabled: false, retransmission_enabled: true, timeout_millis: 3000, retry_count: 3,
  longitude_offset_deg: 0, latitude_offset_deg: 0, altitude_offset_m: 0, time_sync_mode: 'NTP',
  time_server: 'time.example.invalid', timezone_name: 'Asia/Shanghai', time_sync_interval_seconds: 60 });
const options = values => values.map(([value, label]) => ({ value, label }));
const deviceOptions = computed(() => devices.value.map(d => ({ value: d.device_id, label: `${d.device_no} · ${d.name}` })));
const currentDevice = computed(() => devices.value.find(d => d.device_id === selectedDeviceId.value));
const activeProtocol = computed(() => active.value?.protocol_code || currentDevice.value?.protocol_code || null);
const isSimulation = computed(() => active.value ? active.value.simulated : currentDevice.value?.simulated !== false);
const sourceBadge = computed(() => isSimulation.value ? ['MOCK 调测', 'warning'] : ['LIVE 协议调测', 'success']);
const protocolNotice = computed(() => activeProtocol.value === 'RADAR_TCP_V3_0_0'
  ? '雷达步骤：TCP → DATA 登录 → 心跳 → 工作模式读取 → 可选 RTK → 点迹/航迹。待机无数据时结论为不可判定。'
  : activeProtocol.value === 'COUNTERMEASURE_TCP_4CH_V2_0'
    ? '反制步骤：TCP → 编码探测 → 0x10 状态查询 → 地址/校验和 → 四通道映射；不发送任何动作帧。'
    : '选择已配置协议的设备后，后端将按协议能力执行调测。');
const statusMeta = {
  CREATED: ['待连接', 'default'], CONNECTING: ['连接中', 'info'], CONNECTED: ['已连接', 'success'], READY: ['待调测', 'warning'],
  RUNNING: ['调测中', 'info'], PASSED: ['通过', 'success'], FAILED: ['失败', 'error'], UNTESTABLE: ['不可判定', 'warning'], CANCELLED: ['已取消', 'default']
};
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const statusText = (status, simulated = false) => status === 'PASSED' && simulated ? '模拟通过' : (statusMeta[status] || [status])[0];
const statusType = status => (statusMeta[status] || ['', 'default'])[1];
const steps = [
  ['CREATED', '创建任务'], ['CONNECTED', '建立连接'], ['READY', '保存配置'], ['RUNNING', '执行调测'], ['PASSED', '形成报告']
];
const stepIndex = computed(() => {
  const status = active.value?.status;
  if (status === 'CONNECTING') return 1;
  if (['CONNECTED'].includes(status)) return 1;
  if (status === 'READY') return 2;
  if (status === 'RUNNING') return 3;
  if (terminal.has(status)) return 4;
  return 0;
});
const configFields = [
  { key: 'transport', label: '传输方式', type: 'select', required: true, options: options([['TCP', 'TCP'], ['HTTP', 'HTTP'], ['WS', 'WebSocket']]) },
  { key: 'host', label: '主机', required: true, placeholder: 'IP 或域名' },
  { key: 'port', label: '端口', type: 'number', required: true, min: 1, max: 65535 },
  { key: 'path', label: '路径' }, { key: 'data_format', label: '数据格式', required: true },
  { key: 'charset_name', label: '字符集' }, { key: 'credential_ref', label: '凭据引用', placeholder: '不填写明文密钥' },
  { key: 'heartbeat_interval_seconds', label: '心跳间隔（s）', type: 'number', min: 1 },
  { key: 'report_interval_millis', label: '上报周期（ms）', type: 'number', min: 100 },
  { key: 'timeout_millis', label: '超时（ms）', type: 'number', min: 100 }, { key: 'retry_count', label: '重试次数', type: 'number', min: 0, max: 20 },
  { key: 'longitude_offset_deg', label: '经度偏移（°）', type: 'number' }, { key: 'latitude_offset_deg', label: '纬度偏移（°）', type: 'number' },
  { key: 'altitude_offset_m', label: '高度偏移（m）', type: 'number' },
  { key: 'time_sync_mode', label: '时钟同步', type: 'select', options: options([['NTP', 'NTP'], ['DEVICE', '设备时钟'], ['NONE', '不配置']]) },
  { key: 'time_server', label: '时间服务器' }, { key: 'timezone_name', label: '时区' }
];

function statusTag(status, simulated = false) {
  return h(NTag, { size: 'small', type: statusType(status), bordered: false }, { default: () => statusText(status, simulated) });
}
const taskColumns = [
  { title: '任务编号', key: 'commission_no', width: 190 }, { title: '设备', key: 'device_name', width: 190, ellipsis: { tooltip: true } },
  { title: '状态', key: 'status', width: 110, render: row => statusTag(row.status, row.simulated) },
  { title: '模式', key: 'source_mode', width: 85, render: row => row.simulated ? 'MOCK' : row.source_mode },
  { title: '创建时间', key: 'created_at', width: 170, render: row => fmtTime(row.created_at) },
  { title: '操作', key: 'action', width: 90, render: row => h(NButton, { text: true, type: 'info', onClick: () => selectTask(row.commission_id) }, { default: () => '查看' }) }
];

async function loadDevices() {
  const data = await deviceApi.list({ page: 1, size: 100, enabled: true, sort: 'device_no_asc' });
  devices.value = data.items;
  if (!devices.value.some(d => d.device_id === selectedDeviceId.value)) selectedDeviceId.value = devices.value[0]?.device_id || null;
}
async function loadTasks() {
  const data = await commissionApi.list({ page: 1, size: 50 });
  tasks.value = data.items; taskTotal.value = data.total;
}
async function bootstrap() {
  loading.value = true; error.value = '';
  try { await Promise.all([loadDevices(), loadTasks()]); }
  catch (e) { error.value = e.message || '调测数据加载失败'; }
  finally { loading.value = false; }
}
async function selectTask(id) {
  loading.value = true;
  try {
    active.value = await commissionApi.get(id); selectedDeviceId.value = active.value.device_id;
    events.value = []; afterSeq.value = 0; report.value = null;
    if (active.value.configuration) Object.assign(config, active.value.configuration);
    await loadEvents();
    if (['PASSED', 'FAILED', 'UNTESTABLE'].includes(active.value.status)) report.value = await commissionApi.report(id);
  } catch (e) { error.value = e.message || '任务详情加载失败'; }
  finally { loading.value = false; }
}
async function loadEvents() {
  if (!active.value) return;
  const taskId = active.value.commission_id;
  const data = await commissionApi.events(taskId, { after_seq: afterSeq.value, limit: 100 });
  if (active.value?.commission_id !== taskId) return;
  if (data.items.length) {
    const merged = new Map([...events.value, ...data.items].map(item => [item.event_seq, item]));
    events.value = [...merged.values()].sort((a, b) => a.event_seq - b.event_seq).slice(-150);
  }
  afterSeq.value = Math.max(afterSeq.value, data.next_seq);
}
async function pollActive() {
  if (!active.value || pollInFlight) return;
  pollInFlight = true;
  try {
    const latest = await commissionApi.get(active.value.commission_id);
    const changed = latest.status !== active.value.status;
    active.value = latest; await loadEvents();
    if (changed) {
      await loadTasks();
      if (latest.status === 'CONNECTED' && latest.configuration) Object.assign(config, latest.configuration);
      if (['PASSED', 'FAILED', 'UNTESTABLE'].includes(latest.status)) report.value = await commissionApi.report(latest.commission_id);
    }
  } catch (e) { error.value = e.message || '任务轮询失败'; }
  finally { pollInFlight = false; }
}
async function runAction(action, success) {
  if (actionBusy.value) return;
  actionBusy.value = true; error.value = '';
  try { await action(); toast(success, 'ok'); await Promise.all([pollActive(), loadTasks()]); }
  catch (e) { error.value = e.message || '操作失败'; toast(error.value, 'err'); }
  finally { actionBusy.value = false; }
}
async function createTask(previousTaskId = null) {
  if (!selectedDeviceId.value) return;
  await runAction(async () => {
    active.value = await commissionApi.create({ device_id: selectedDeviceId.value, previous_task_id: previousTaskId });
    events.value = []; afterSeq.value = 0; report.value = null; await loadEvents();
    const detail = await deviceApi.detail(selectedDeviceId.value);
    if (detail.connection) Object.assign(config, detail.connection);
  }, previousTaskId ? '已创建关联前次记录的新任务' : '调测任务已创建');
}
function connectTask() { runAction(async () => { active.value = await commissionApi.connect(active.value.commission_id, active.value.version); }, isSimulation.value ? '正在通过模拟适配器建立连接' : '正在建立 live 协议只读连接'); }
function saveConfig() {
  if (!config.host?.trim() || !config.port) { error.value = '主机和端口为必填'; return; }
  runAction(async () => { active.value = await commissionApi.configure(active.value.commission_id, { version: active.value.version, ...config }); }, '配置快照已保存，任务进入待调测');
}
function startTask() { runAction(async () => { active.value = await commissionApi.start(active.value.commission_id, active.value.version); }, isSimulation.value ? '模拟调测已进入持久化队列' : '协议调测已进入持久化队列'); }
function cancelTask() { runAction(async () => { active.value = await commissionApi.cancel(active.value.commission_id, active.value.version); }, '任务已取消'); }
function reconnect() {
  const oldId = active.value?.commission_id;
  selectedDeviceId.value = active.value.device_id;
  createTask(oldId).then(() => { if (active.value?.status === 'CREATED') connectTask(); });
}
function showReport() {
  if (!report.value) return;
  openModal({ title: `调测报告 · ${report.value.commission_no}`, width: '820px', footer: false,
    render: () => h('div', { class: 'report-modal' }, [
      h('div', { class: 'warnbox' }, report.value.warning || '报告仅供在线查看。'),
      h('pre', JSON.stringify(report.value, null, 2)),
      h('div', { class: 'u-form-footer' }, [h(NButton, { disabled: true }, { default: () => 'PDF 下载（待后续）' }), h(NButton, { type: 'primary', onClick: closeModal }, { default: () => '关闭' })])
    ]) });
}

onMounted(async () => { await bootstrap(); pollTimer = setInterval(pollActive, 2_000); listTimer = setInterval(loadTasks, 10_000); });
onUnmounted(() => { clearInterval(pollTimer); clearInterval(listTimer); });
</script>

<template>
  <div class="view commission-page" id="view" :aria-busy="loading || actionBusy">
    <div class="source-banner"><NTag :type="sourceBadge[1]" :bordered="false">{{ sourceBadge[0] }}</NTag><span>{{ isSimulation ? '模拟结果不代表真实设备验收或可投入运行。' : '仅验证协议链路；雷达控制和反制射频发射保持关闭。' }}</span><NButton disabled title="文件接口待后续切片">PDF 报告（待后续）</NButton></div>
    <div v-if="error" class="warnbox error-row" role="alert"><span>{{ error }}</span><NButton size="small" @click="bootstrap">重试</NButton></div>
    <div class="commission-top">
      <UPanel title="调测对象" sub="启用设备" nopad>
        <div class="device-picker"><UField v-model="selectedDeviceId" type="select" label="选择设备" :options="deviceOptions" :disabled="!!active && !terminal.has(active.status)" /><div v-if="currentDevice" class="device-card"><b>{{ currentDevice.name }}</b><code>{{ currentDevice.device_no }}</code><span>{{ currentDevice.device_type_name }} · {{ currentDevice.channel }}</span><NTag size="small" :type="currentDevice.connectivity==='ONLINE'?'success':'warning'" :bordered="false">{{ currentDevice.connectivity }}</NTag></div><NButton type="primary" block :disabled="!canOperate || !selectedDeviceId || (!!active && !terminal.has(active.status))" :loading="actionBusy" @click="createTask()">创建新任务</NButton></div>
      </UPanel>
      <UPanel title="任务进度" :sub="active?.commission_no || '尚未创建任务'">
        <div class="steps"><div v-for="([code,label], index) in steps" :key="code" :class="{ done:index<stepIndex, active:index===stepIndex && active }"><i>{{ index < stepIndex ? '✓' : index + 1 }}</i><span>{{ label }}</span></div></div>
        <div v-if="active" class="task-summary"><div><small>当前状态</small><NTag :type="statusType(active.status)" :bordered="false">{{ statusText(active.status, active.simulated) }}</NTag></div><div><small>任务版本</small><b>v{{ active.version }}</b></div><div><small>接入协议</small><b>{{ active.protocol_code || 'MOCK' }}<template v-if="active.protocol_version"> · v{{ active.protocol_version }}</template></b></div><div><small>数据来源</small><b>{{ active.simulated ? '开发模拟适配器' : 'LIVE' }}</b></div></div><NEmpty v-else description="选择设备并创建任务后开始" />
        <div class="config-notice protocol-notice">{{ protocolNotice }}</div><div class="task-actions"><NButton type="primary" :disabled="!canOperate || active?.status!=='CREATED'" :loading="actionBusy" @click="connectTask">建立连接</NButton><NButton type="primary" :disabled="!canOperate || active?.status!=='READY'" :loading="actionBusy" @click="startTask">{{ isSimulation ? '开始模拟调测' : '开始协议调测' }}</NButton><NButton :disabled="!canOperate || !active || terminal.has(active.status)" @click="cancelTask">取消任务</NButton><NButton :disabled="!canOperate || !active" @click="reconnect">重新连接（新任务）</NButton><NButton :disabled="!report" @click="showReport">查看 JSON 报告</NButton></div>
      </UPanel>
    </div>
    <div class="commission-main">
      <UPanel title="连接配置" sub="保存类型化快照，不接收明文密钥" nopad>
        <NSpin :show="actionBusy"><div class="config-form"><UFieldGrid :fields="configFields" :model="config" :columns="2" /><div class="config-notice">坐标偏移与高度基准只按原值保存，本版本不做 WGS-84、AGL 或 AMSL 推算。</div><NButton type="primary" :disabled="!canOperate || active?.status!=='CONNECTED'" :loading="actionBusy" @click="saveConfig">保存配置</NButton></div></NSpin>
      </UPanel>
      <UPanel title="调测事件" sub="2 秒增量轮询" nopad>
        <div v-if="events.length" class="event-log"><article v-for="event in [...events].reverse()" :key="event.event_seq"><i :class="event.level_code"></i><div><header><b>{{ event.stage_code }}</b><time>#{{ event.event_seq }} · {{ fmtTime(event.occurred_at) }}</time></header><p>{{ event.message }}</p><small v-if="event.simulated">模拟事件</small></div></article></div><NEmpty v-else description="暂无任务事件" class="empty-block" />
      </UPanel>
      <UPanel title="调测结论" sub="服务端持久化报告" nopad>
        <div v-if="report" class="report-card"><NTag :type="statusType(report.status)" :bordered="false" size="large">{{ statusText(report.status, report.simulated) }}</NTag><p>{{ report.warning }}</p><div v-for="item in report.results?.items || []" :key="item.code" class="result-item"><span><b>{{ item.label || item.code }}</b><small>{{ item.basis || (report.simulated ? '开发模拟判据' : report.protocol_code) }}</small></span><NTag size="small" :type="item.result==='FAILED'?'error':item.result==='UNTESTABLE'?'warning':'success'" :bordered="false">{{ item.result === 'PASSED' ? '通过' : item.result === 'FAILED' ? '失败' : item.result === 'UNTESTABLE' ? '不可判定' : item.result }}</NTag></div><NButton type="primary" @click="showReport">查看完整 JSON</NButton></div><NEmpty v-else description="任务完成后由后端生成在线报告" class="empty-block" />
      </UPanel>
    </div>
    <UPanel title="历史调测记录" :sub="`共 ${taskTotal} 条，历史不可覆盖`" nopad><NDataTable :columns="taskColumns" :data="tasks" :row-key="row=>row.commission_id" :scroll-x="900" :max-height="260" /><NEmpty v-if="!tasks.length && !loading" description="暂无调测记录" class="empty-block" /></UPanel>
  </div>
</template>

<style scoped>
.commission-page{gap:12px;min-width:0}.source-banner{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--amber) 36%,transparent);border-radius:6px;background:color-mix(in srgb,var(--amber) 8%,transparent)}.source-banner span{flex:1;color:var(--txt-2)}.error-row{display:flex;align-items:center;justify-content:space-between}.commission-top{display:grid;grid-template-columns:300px minmax(0,1fr);gap:12px}.device-picker{display:grid;gap:12px;padding:14px}.device-card{display:grid;gap:6px;padding:12px;border:1px solid var(--line-1);border-radius:6px;background:var(--surface-2)}.device-card code,.device-card span{color:var(--txt-3)}.steps{display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));gap:0;margin:4px 0 18px}.steps>div{position:relative;display:grid;justify-items:center;gap:7px;color:var(--txt-3)}.steps>div:not(:last-child)::after{content:'';position:absolute;top:15px;left:60%;width:80%;height:1px;background:var(--line-2)}.steps i{z-index:1;display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line-2);border-radius:50%;background:var(--surface-2);font-style:normal}.steps .done i,.steps .active i{border-color:var(--cyan);color:var(--cyan);box-shadow:0 0 14px color-mix(in srgb,var(--cyan) 25%,transparent)}.steps .active span{color:var(--txt-1)}.task-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.task-summary>div{display:grid;gap:7px;padding:10px;border-left:2px solid var(--blue);background:color-mix(in srgb,var(--blue) 7%,transparent)}.task-summary small{color:var(--txt-3)}.task-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.commission-main{display:grid;grid-template-columns:minmax(400px,1.2fr) minmax(330px,1fr) 330px;gap:12px;min-height:430px}.commission-main>.panel{min-width:0;min-height:0}.config-form{display:grid;gap:12px;padding:14px;max-height:430px;overflow:auto}.config-notice{padding:9px 10px;border-left:2px solid var(--amber);color:var(--txt-2);background:color-mix(in srgb,var(--amber) 7%,transparent)}.event-log{height:430px;overflow:auto;padding:8px 12px}.event-log article{display:grid;grid-template-columns:10px 1fr;gap:8px;padding:10px 0;border-bottom:1px solid var(--line-1)}.event-log i{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--blue)}.event-log i.WARN{background:var(--amber)}.event-log i.ERROR{background:var(--red)}.event-log header{display:flex;justify-content:space-between;gap:8px}.event-log time,.event-log small{color:var(--txt-3);font-size:10px}.event-log p{margin:5px 0;line-height:1.5;color:var(--txt-2)}.report-card{display:grid;gap:12px;padding:14px}.report-card>p{line-height:1.6;color:var(--txt-2)}.result-item{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-1)}.result-item span{display:grid;gap:4px}.result-item small{color:var(--txt-3)}.empty-block{padding:44px 10px}:global(.report-modal){display:grid;gap:12px}:global(.report-modal pre){max-height:52vh;margin:0;padding:14px;overflow:auto;border:1px solid var(--line-1);border-radius:6px;background:var(--surface-2);color:var(--txt-2);font-size:12px;line-height:1.55}@media(max-width:1360px){.commission-main{grid-template-columns:minmax(380px,1.2fr) minmax(300px,1fr)}.commission-main>.panel:last-child{grid-column:1/-1}.report-card{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:980px){.commission-top,.commission-main{grid-template-columns:1fr}.commission-main>.panel:last-child{grid-column:auto}.task-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
