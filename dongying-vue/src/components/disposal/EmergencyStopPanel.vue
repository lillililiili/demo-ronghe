<script setup>
import { computed, ref, toRef, watch } from 'vue';
import UField from '@/components/form/UField.vue';
import { useEmergencyStop } from './useEmergencyStop.js';
import { deviceStopText, stopActionLabel, stopSummary, stopTime } from './emergencyStopView.js';

const props = defineProps({ eventId: { type: String, required: true }, eventLabel: { type: String, default: '' } });
const emit = defineEmits(['updated', 'changed']);
const host = ref(null);
const { overview, stop, loading, busy, error, uncertain, forbidden, retryReady, refresh, retryPending, requestStop, addNote, retryDevice, confirmDevice }
  = useEmergencyStop(toRef(props, 'eventId'), data => emit('updated', data), eventId => emit('changed', eventId));
const offered = computed(() => (overview.value?.allowed_actions || []).includes('EMERGENCY_STOP'));
const visible = computed(() => uncertain.value || !!error.value || !!stop.value || (!!overview.value?.applicable && offered.value));
const hasDetails = computed(() => !!stop.value || (loading.value && !overview.value) || error.value || uncertain.value || overview.value?.block_reason);
const actions = computed(() => overview.value?.allowed_actions || []);
const canStop = computed(() => actions.value.includes('EMERGENCY_STOP') && !busy.value && !loading.value && !error.value && !uncertain.value);
const actionLabel = computed(() => stopActionLabel(overview.value));
const summary = computed(() => stopSummary(overview.value));
const locked = computed(() => busy.value || loading.value || !!error.value || !!uncertain.value || forbidden.value);
const note = ref(''), confirming = ref(''), confirmation = ref('');
const historyLabel = kind => ({ STOP: '发起急停', NOTE: '补充原因', RETRY: '重试停止', MANUAL_CONFIRM: '现场停机核查' })[kind] || '处置记录';
const allows = (device, action) => (device.allowed_actions || []).includes(action);
const icon = name => window.UI.icon(name);

watch([() => props.eventId, () => stop.value?.stop_id], () => { note.value = ''; confirming.value = ''; confirmation.value = ''; });
async function saveNote() {
  if (locked.value || !actions.value.includes('ADD_NOTE') || !note.value.trim()) return;
  if (await addNote(note.value.trim())) note.value = '';
}
async function retry(device) {
  if (!locked.value && allows(device, 'RETRY_STOP')) await retryDevice(device);
}
async function confirm(device) {
  if (locked.value || !allows(device, 'MANUAL_CONFIRM') || !confirmation.value.trim()) return;
  if (await confirmDevice(device, confirmation.value.trim())) { confirming.value = ''; confirmation.value = ''; }
}
async function halt() {
  if (!canStop.value) return;
  await requestStop();
}
defineExpose({ refresh });
</script>

<template>
  <div v-if="error && !visible" ref="host" class="es-query-notice" role="alert" :data-event-id="eventId">
    <span><strong>暂时无法核对急停状态</strong>：{{ error }}</span>
    <button v-if="!forbidden" type="button" class="btn" :disabled="loading || busy" @click="refresh">重新查询</button>
  </div>
  <section v-if="visible" ref="host" class="emergency-stop-panel" aria-label="反制处置急停" :data-event-id="eventId">
    <header class="es-header" :class="{ 'is-standalone': !hasDetails }">
      <div><h3>反制处置</h3><p v-if="eventLabel" class="es-muted">{{ eventLabel }}</p></div>
      <div v-if="offered" class="es-stop-area">
        <button type="button" class="btn es-stop-button" :disabled="!canStop" @click="halt">
          <span aria-hidden="true" v-html="icon('stop')"></span>{{ busy ? '正在提交' : actionLabel }}
        </button>
      </div>
    </header>
    <div v-if="hasDetails" class="es-content">
      <div v-if="loading && !overview" class="es-muted" role="status">正在读取当前处置状态</div>
      <div v-if="error" class="es-status is-error" role="alert">
        <strong>暂时无法核对急停状态</strong><p>{{ error }}</p>
        <button v-if="!forbidden" type="button" class="btn" :disabled="loading || busy" @click="refresh">重新查询</button>
      </div>
      <div v-if="uncertain" class="es-status is-warning" role="status"><strong>请求结果未知</strong><p>{{ uncertain }}</p><button type="button" class="btn" :disabled="loading || busy" @click="refresh">查询当前结果</button><button v-if="retryReady" type="button" class="btn" :disabled="loading || busy" @click="retryPending">重试同一请求</button><p v-if="retryReady">已查询但尚未证实原请求结果；重试会沿用原请求标识。</p></div>
      <div v-if="overview?.block_reason" class="es-blocker">{{ overview.block_reason }}</div>
      <div v-if="stop" class="es-feedback">
        <div class="es-status" :class="'is-' + summary.tone" role="status"><strong>{{ summary.title }}</strong><p v-if="stop.devices?.length !== 1">{{ summary.detail }}</p></div>
        <p class="es-muted">{{ stop.requested_by_name || '操作人未记录' }} · {{ stopTime(stop.requested_at) }}</p>
        <p v-if="stop.reason_pending" class="es-needs-check">急停原因待补充</p>
        <p v-else-if="stop.note">急停原因：{{ stop.note }}</p>
        <div v-for="device in stop.devices || []" :key="device.device_id" class="es-device">
          <div class="es-device-title"><strong>{{ device.device_name || '设备名称未记录' }}</strong><span v-if="device.simulated" class="es-muted">模拟设备</span></div>
          <p>{{ deviceStopText(device) }}</p>
          <p v-if="device.detail && !['QUEUED', 'WAITING_FEEDBACK', 'CONTROLLER_ALL_OFF_ACK', 'MANUALLY_CONFIRMED', 'NOT_REQUIRED'].includes(device.stop_status) && device.detail !== deviceStopText(device)" class="es-muted">{{ device.detail }}</p>
          <p v-if="device.confirmed_at">核查人：{{ device.confirmed_by_name || '未记录' }} · {{ stopTime(device.confirmed_at) }}</p>
          <p v-if="device.confirmation_note">核查依据：{{ device.confirmation_note }}</p>
          <div class="es-actions">
            <button v-if="allows(device, 'QUERY')" type="button" class="btn" :disabled="loading || busy || forbidden" @click="refresh">查询设备反馈</button>
            <button v-if="allows(device, 'RETRY_STOP')" type="button" class="btn" :disabled="locked" @click="retry(device)">重试停止</button>
            <button v-if="allows(device, 'MANUAL_CONFIRM') && confirming !== device.device_id" type="button" class="btn" :disabled="locked" @click="confirming = device.device_id; confirmation = ''">登记现场停机核查</button>
          </div>
          <div v-if="confirming === device.device_id && allows(device, 'MANUAL_CONFIRM')" class="es-form">
            <UField v-model="confirmation" type="textarea" label="现场停机核查依据" required :disabled="locked" :input-props="{ maxlength: 500 }" help="仅在已现场核实设备实际停止后登记，控制器全关回码不能替代现场核查。" />
            <div class="es-actions"><button type="button" class="btn" :disabled="locked || !confirmation.trim()" @click="confirm(device)">确认已现场核实停止</button><button type="button" class="btn" :disabled="busy" @click="confirming = ''; confirmation = ''">取消</button></div>
          </div>
        </div>
        <div v-if="actions.includes('ADD_NOTE')" class="es-note">
          <UField v-model="note" type="textarea" label="补充急停原因" :disabled="locked" :input-props="{ maxlength: 500 }" />
          <div class="es-actions"><button type="button" class="btn" :disabled="locked || !note.trim()" @click="saveNote">保存原因</button></div>
        </div>
        <details v-if="stop.events?.length" class="es-history"><summary>急停处理记录</summary><ol><li v-for="entry in stop.events" :key="entry.event_id"><strong>{{ historyLabel(entry.kind) }} · {{ entry.actor_name || '未记录' }}</strong><time>{{ stopTime(entry.occurred_at) }}</time><span>{{ entry.note }}</span></li></ol></details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.es-query-notice { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; min-width:0; padding:8px 12px; color:var(--amber); font-size:13px; }
.es-query-notice > span { flex:1 1 240px; min-width:0; overflow-wrap:anywhere; }
.es-query-notice > .btn { flex:none; }
.emergency-stop-panel { background:var(--surface-1); border:1px solid var(--line); border-radius:var(--r); min-width:0; color:var(--txt); }
.es-header { position:sticky; top:0; z-index:2; display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:14px; background:var(--surface-1); border-bottom:1px solid var(--line); border-radius:var(--r) var(--r) 0 0; }
.es-header.is-standalone { border-bottom:0; border-radius:var(--r); }
.es-header h3 { margin:0; font-size:15px; }
.es-header p { margin:4px 0 0; overflow-wrap:anywhere; }
.es-stop-area { display:flex; flex-direction:column; align-items:flex-end; gap:5px; }
.es-muted { color:var(--txt-2); }
.es-stop-button { min-height:44px; padding:9px 16px; background:color-mix(in srgb, var(--red) 65%, var(--canvas)); border-color:var(--red); color:var(--txt); font-weight:600; }
.es-stop-button:not(:disabled):hover { background:color-mix(in srgb, var(--red) 80%, var(--canvas)); }
.es-stop-button:focus-visible { outline:2px solid var(--red); outline-offset:3px; }
.es-stopped { padding:5px 8px; color:var(--red); background:color-mix(in srgb, var(--red) 12%, var(--surface-1)); border-radius:4px; }
.es-content { padding:12px 14px; }
.es-content p { margin:5px 0; overflow-wrap:anywhere; }
.es-status { padding:12px; margin-bottom:12px; border-radius:5px; background:color-mix(in srgb, var(--amber) 12%, var(--surface-1)); color:var(--amber); }
.es-status strong { display:block; font-size:14px; }
.es-status.is-error { background:color-mix(in srgb, var(--red) 12%, var(--surface-1)); color:var(--red); }
.es-status.is-success { background:color-mix(in srgb, var(--green) 12%, var(--surface-1)); color:var(--green); }
.es-status.is-neutral { background:var(--surface-2); color:var(--txt-2); }
.es-blocker { margin-bottom:12px; color:var(--amber); overflow-wrap:anywhere; }
.es-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.es-link { background:transparent; border-color:transparent; color:var(--blue); }
.es-feedback, .es-form, .es-history { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.es-device { padding:12px 0; border-bottom:1px solid var(--line); }.es-device:last-child { border-bottom:0; }
.es-device-title { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }.es-device-title strong { overflow-wrap:anywhere; }
.es-needs-check { color:var(--amber); }.es-note, .es-footer { padding-top:12px; }
.es-history-label { font-weight:600; padding-bottom:6px; }
.es-history ol { list-style:none; padding:0; margin:10px 0; }.es-history li { display:grid; gap:4px; padding:8px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }.es-history time { color:var(--txt-2); font-size:12px; }
@media (max-width:600px) { .es-stop-area { width:100%; align-items:stretch; } }
</style>
