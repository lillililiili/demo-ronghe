<script setup>
import { computed, h, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin, NTag } from 'naive-ui';
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
let pollInFlight = false;

const config = reactive({ transport: 'TCP', host: '', port: null, timeout_millis: 3000 });
let connectionRequest = 0;
function resetConfig() {
  config.transport = 'TCP';
  config.host = '';
  config.port = null;
  config.timeout_millis = 3000;
}
async function applyDeviceConnection(deviceId) {
  const request = ++connectionRequest;
  if (!deviceId) { resetConfig(); return; }
  try {
    const detail = await deviceApi.detail(deviceId);
    if (request !== connectionRequest) return;
    const c = detail.connection || {};
    config.transport = c.transport || 'TCP';
    config.host = c.host || '';
    config.port = c.port ?? null;
    config.timeout_millis = c.timeout_millis ?? 3000;
  } catch {
    if (request !== connectionRequest) return;
    resetConfig();
  }
}
const deviceOptions = computed(() => devices.value.map(d => ({ value: d.device_id, label: `${d.device_no} · ${d.name}` })));
const currentDevice = computed(() => devices.value.find(d => d.device_id === selectedDeviceId.value));
const isSimulation = computed(() => !!(active.value?.simulated || currentDevice.value?.simulated));
const statusMeta = {
  CREATED: ['待连接', 'default'], CONNECTING: ['连接中', 'info'], CONNECTED: ['已连接', 'success'], READY: ['待调测', 'warning'],
  RUNNING: ['调测中', 'info'], PASSED: ['通过', 'success'], FAILED: ['失败', 'error'], UNTESTABLE: ['不可判定', 'warning'], CANCELLED: ['已取消', 'default']
};
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const statusText = (status, simulated = false) => status === 'PASSED' && simulated ? '模拟通过' : (statusMeta[status] || [status])[0];
const statusType = status => (statusMeta[status] || ['', 'default'])[1];
const PROTOCOL_NAME = {
  RADAR_TCP_V3_0_0: 'T02/兼容机扫雷达 TCP',
  COUNTERMEASURE_TCP_4CH_V2_0: '固定式四通道网络控制器'
};
function protocolLabel(task) {
  return PROTOCOL_NAME[task?.protocol_code] || task?.protocol_code || '未配置';
}
const steps = [
  ['CREATED', '创建任务'], ['CONNECTED', '建立连接'], ['READY', '保存配置'], ['RUNNING', '执行调测'], ['PASSED', '形成报告']
];
const stepIndex = computed(() => {
  const status = active.value?.status;
  if (!status || status === 'CREATED') return 0;
  if (status === 'CONNECTING') return 1;
  if (status === 'CONNECTED') return 2;
  if (status === 'READY' || status === 'RUNNING') return 3;
  if (status === 'PASSED') return 4;
  if (active.value?.started_at) return 4;
  if (active.value?.configuration) return 2;
  return 1;
});
const configFields = [
  { key: 'host', label: '主机', required: true, placeholder: '设备 IP' },
  { key: 'port', label: '端口', type: 'number', required: true, min: 1, max: 65535 },
  { key: 'timeout_millis', label: '超时（ms）', type: 'number', min: 100 }
];

async function loadDevices() {
  const data = await deviceApi.list({ page: 1, size: 100, enabled: true, sort: 'device_no_asc' });
  devices.value = data.items;
  if (!devices.value.some(d => d.device_id === selectedDeviceId.value)) selectedDeviceId.value = devices.value[0]?.device_id || null;
}
async function bootstrap() {
  loading.value = true; error.value = '';
  try { await loadDevices(); }
  catch (e) { error.value = e.message || '调测数据加载失败'; }
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
      if (latest.status === 'CONNECTED' && latest.configuration) Object.assign(config, latest.configuration);
      if (['PASSED', 'FAILED', 'UNTESTABLE'].includes(latest.status)) report.value = await commissionApi.report(latest.commission_id);
    }
  } catch (e) { error.value = e.message || '任务轮询失败'; }
  finally { pollInFlight = false; }
}
async function runAction(action, success) {
  if (actionBusy.value) return;
  actionBusy.value = true; error.value = '';
  try { await action(); toast(success, 'ok'); await pollActive(); }
  catch (e) { error.value = e.message || '操作失败'; toast(error.value, 'err'); }
  finally { actionBusy.value = false; }
}
async function createTask() {
  if (!selectedDeviceId.value) return;
  await runAction(async () => {
    active.value = await commissionApi.create({ device_id: selectedDeviceId.value });
    events.value = []; afterSeq.value = 0; report.value = null; await loadEvents();
    await applyDeviceConnection(selectedDeviceId.value);
  }, '调测任务已创建');
}
function connectTask() { runAction(async () => { active.value = await commissionApi.connect(active.value.commission_id, active.value.version); }, isSimulation.value ? '正在通过模拟适配器建立连接' : '正在建立连接'); }
function saveConfig() {
  if (!config.host?.trim() || !config.port) { error.value = '主机和端口为必填'; return; }
  runAction(async () => { active.value = await commissionApi.configure(active.value.commission_id, { version: active.value.version, ...config }); }, '配置快照已保存，任务进入待调测');
}
function startTask() { runAction(async () => { active.value = await commissionApi.start(active.value.commission_id, active.value.version); }, isSimulation.value ? '模拟调测已进入持久化队列' : '协议调测已进入持久化队列'); }
function cancelTask() { runAction(async () => { active.value = await commissionApi.cancel(active.value.commission_id, active.value.version); }, '任务已取消'); }
function showReport() {
  if (!report.value) return;
  openModal({ title: `调测报告 · ${report.value.commission_no}`, width: '820px', footer: false,
    render: () => h('div', { class: 'report-modal' }, [
      h('div', { class: 'warnbox' }, report.value.warning || '报告仅供在线查看。'),
      h('pre', JSON.stringify(report.value, null, 2)),
      h('div', { class: 'u-form-footer' }, [h(NButton, { type: 'primary', onClick: closeModal }, { default: () => '关闭' })])
    ]) });
}

watch(selectedDeviceId, id => {
  if (active.value && !terminal.has(active.value.status)) return;
  void applyDeviceConnection(id);
});
onMounted(async () => { await bootstrap(); pollTimer = setInterval(pollActive, 2_000); });
onUnmounted(() => { clearInterval(pollTimer); });
</script>

<template>
  <div class="view commission-page" id="view" :aria-busy="loading || actionBusy">
    <div v-if="error" class="warnbox error-row" role="alert"><span>{{ error }}</span><NButton size="small" @click="bootstrap">重试</NButton></div>
    <div class="commission-top">
      <UPanel title="调测对象" sub="启用设备" nopad>
        <div class="device-picker"><UField v-model="selectedDeviceId" type="select" label="选择设备" :options="deviceOptions" :disabled="!!active && !terminal.has(active.status)" /><div v-if="currentDevice" class="device-card"><b>{{ currentDevice.name }}</b><code>{{ currentDevice.device_no }}</code><span>{{ currentDevice.device_type_name }} · {{ currentDevice.channel }}</span><NTag size="small" :type="currentDevice.connectivity==='ONLINE'?'success':'warning'" :bordered="false">{{ currentDevice.connectivity }}</NTag></div><NButton type="primary" block :disabled="!canOperate || !selectedDeviceId || (!!active && !terminal.has(active.status))" :loading="actionBusy" @click="createTask()">创建新任务</NButton></div>
      </UPanel>
      <UPanel title="任务进度" :sub="active?.commission_no || '尚未创建任务'">
        <div class="progress-body">
          <ol class="steps">
            <li v-for="([code,label], index) in steps" :key="code" :class="{ done:index<stepIndex, active:index===stepIndex }">
              <i>{{ index < stepIndex ? '✓' : index + 1 }}</i><span>{{ label }}</span>
            </li>
          </ol>
          <div v-if="active" class="task-summary">
            <div><small>当前状态</small><b>{{ statusText(active.status, active.simulated) }}</b></div>
            <div><small>接入协议</small><b>{{ protocolLabel(active) }}</b></div>
          </div>
          <p v-else class="task-hint">请在左侧选择设备并创建任务</p>
          <div class="task-actions">
            <NButton :type="active?.status==='CREATED'?'primary':'default'" :disabled="!canOperate || active?.status!=='CREATED'" :loading="actionBusy" @click="connectTask">建立连接</NButton>
            <NButton :type="active?.status==='CONNECTED'?'primary':'default'" :disabled="!canOperate || active?.status!=='CONNECTED'" :loading="actionBusy" @click="saveConfig">保存配置</NButton>
            <NButton :type="active?.status==='READY'?'primary':'default'" :disabled="!canOperate || active?.status!=='READY'" :loading="actionBusy" @click="startTask">开始协议调测</NButton>
            <NButton :disabled="!canOperate || !active || terminal.has(active.status)" @click="cancelTask">取消任务</NButton>
          </div>
        </div>
      </UPanel>
    </div>
    <div class="commission-main">
      <UPanel title="连接配置" sub="随所选设备带出" nopad>
        <NSpin :show="actionBusy"><div class="config-form"><UFieldGrid :fields="configFields" :model="config" :columns="2" /><NButton type="primary" :disabled="!canOperate || active?.status!=='CONNECTED'" :loading="actionBusy" @click="saveConfig">保存配置</NButton></div></NSpin>
      </UPanel>
      <UPanel title="调测事件" nopad>
        <div v-if="events.length" class="event-log"><article v-for="event in [...events].reverse()" :key="event.event_seq"><i :class="event.level_code"></i><div><header><b>{{ event.stage_code }}</b><time>{{ fmtTime(event.occurred_at) }}</time></header><p>{{ event.message }}</p><small v-if="event.simulated">模拟事件</small></div></article></div><NEmpty v-else description="暂无任务事件" class="empty-block" />
      </UPanel>
      <UPanel title="调测结论"  nopad>
        <div v-if="report" class="report-card"><NTag :type="statusType(report.status)" :bordered="false" size="large">{{ statusText(report.status, report.simulated) }}</NTag><p>{{ report.warning }}</p><div v-for="item in report.results?.items || []" :key="item.code" class="result-item"><span><b>{{ item.label || item.code }}</b><small>{{ item.basis || (report.simulated ? '开发模拟判据' : report.protocol_code) }}</small></span><NTag size="small" :type="item.result==='FAILED'?'error':item.result==='UNTESTABLE'?'warning':'success'" :bordered="false">{{ item.result === 'PASSED' ? '通过' : item.result === 'FAILED' ? '失败' : item.result === 'UNTESTABLE' ? '不可判定' : item.result }}</NTag></div><NButton type="primary" @click="showReport">查看完整 JSON</NButton></div><NEmpty v-else description="任务完成后由后端生成在线报告" class="empty-block" />
      </UPanel>
    </div>
  </div>
</template>

<style scoped>
.commission-page{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;overflow:hidden}
.error-row{flex:none;display:flex;align-items:center;justify-content:space-between}
.commission-top{flex:none;display:grid;grid-template-columns:300px minmax(0,1fr);gap:12px;align-items:stretch}
.commission-top :deep(.pb){display:flex;flex-direction:column}
.device-picker{display:grid;gap:12px;padding:14px}
.device-card{display:grid;gap:6px;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2)}
.device-card code,.device-card span{color:var(--txt-3)}
.progress-body{display:flex;flex-direction:column;gap:16px;min-height:100%;box-sizing:border-box}
.steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:0;padding:2px 4px 0;list-style:none}
.steps>li{position:relative;display:grid;justify-items:center;gap:8px;color:var(--txt-3);font-size:12px}
.steps>li:not(:last-child)::after{content:'';position:absolute;top:15px;left:calc(50% + 18px);right:calc(-50% + 18px);height:2px;background:var(--line);z-index:0}
.steps>li.done:not(:last-child)::after,.steps>li.active:not(:last-child)::after{background:color-mix(in srgb,var(--cyan) 65%,transparent)}
.steps i{z-index:1;display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);border-radius:50%;background:var(--surface-2);font-size:12px;font-weight:600;font-style:normal}
.steps .done i{border-color:var(--cyan);background:color-mix(in srgb,var(--cyan) 20%,var(--surface-2));color:var(--cyan)}
.steps .active i{border-color:var(--cyan);color:var(--cyan);box-shadow:0 0 0 4px color-mix(in srgb,var(--cyan) 16%,transparent)}
.steps .done span{color:var(--txt-2)}
.steps .active span{color:var(--txt-1);font-weight:600}
.task-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.task-summary>div{display:grid;gap:4px;padding:10px 12px;border-left:2px solid var(--cyan);background:color-mix(in srgb,var(--cyan) 8%,transparent)}
.task-summary small{color:var(--txt-3);font-size:11px}
.task-summary b{font-size:14px}
.task-hint{margin:0;color:var(--txt-3);font-size:13px;line-height:1.5}
.task-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:12px;border-top:1px solid var(--line-2)}
.commission-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(400px,1.2fr) minmax(330px,1fr) 330px;gap:12px}
.commission-main>.panel{min-width:0;min-height:0;overflow:hidden}
.commission-main>.panel :deep(.pb.nopad){flex:1;min-height:0;display:block;overflow:auto;overscroll-behavior:contain}
.commission-main>.panel :deep(.n-spin-container),.commission-main>.panel :deep(.n-spin-content){height:100%;min-height:100%}
.config-form{display:grid;gap:12px;padding:14px}
.event-log{padding:8px 12px}
.event-log article{display:grid;grid-template-columns:10px 1fr;gap:8px;padding:10px 0;border-bottom:1px solid var(--line-1)}
.event-log i{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--blue)}
.event-log i.WARN{background:var(--amber)}
.event-log i.ERROR{background:var(--red)}
.event-log header{display:flex;justify-content:space-between;gap:8px}
.event-log time,.event-log small{color:var(--txt-3);font-size:10px}
.event-log p{margin:5px 0;line-height:1.5;color:var(--txt-2)}
.report-card{display:grid;gap:12px;padding:14px}
.report-card>p{line-height:1.6;color:var(--txt-2)}
.result-item{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-1)}
.result-item span{display:grid;gap:4px}
.result-item small{color:var(--txt-3)}
.empty-block{min-height:100%;display:grid;place-items:center;padding:16px 10px;box-sizing:border-box}
:global(.report-modal){display:grid;gap:12px}
:global(.report-modal pre){max-height:52vh;margin:0;padding:14px;overflow:auto;border:1px solid var(--line-1);border-radius:6px;background:var(--surface-2);color:var(--txt-2);font-size:12px;line-height:1.55}
@media(max-width:1360px){.commission-main{grid-template-columns:minmax(380px,1.2fr) minmax(300px,1fr)}.commission-main>.panel:last-child{grid-column:1/-1}.report-card{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:980px){.commission-top,.commission-main{grid-template-columns:1fr}.commission-main>.panel:last-child{grid-column:auto}}
</style>
