<script setup>
import { computed, nextTick, ref, toRef, watch } from 'vue';
import { UField } from '@/components/form/index.js';
import { DISPOSAL_ACTION_LABEL, DISPOSAL_STATUS_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import { useEmergencyStop } from './useEmergencyStop.js';
import { deviceStopText, stopActionLabel, stopSummary, stopTime } from './emergencyStopView.js';

const props = defineProps({ eventId: { type: String, required: true }, eventLabel: { type: String, default: '' } });
const emit = defineEmits(['updated', 'changed']);
const host = ref(null), feedbackOpen = ref(false), historyOpen = ref(false), noteOpen = ref(false);
const note = ref(''), formError = ref(''), confirmation = ref(null), confirmationNote = ref('');
const { overview, stop, followup, loading, busy, error, uncertain, forbidden, retryReady, refresh, retryPending, requestStop, addNote, retryDevice, confirmDevice }
  = useEmergencyStop(toRef(props, 'eventId'), data => emit('updated', data), eventId => {
    feedbackOpen.value = true; emit('changed', eventId);
  });
// 加载本身不代表存在可停止的处置，避免首次读取和轮询时先展开急停区再收起。
const visible = computed(() => error.value || uncertain.value || overview.value?.applicable || stop.value);
const summary = computed(() => stopSummary(overview.value));
const historicalStop = computed(() => !!stop.value && overview.value?.applicable);
const actions = computed(() => overview.value?.allowed_actions || []);
const canStop = computed(() => actions.value.includes('EMERGENCY_STOP') && !busy.value && !loading.value && !error.value && !uncertain.value);
const canNote = computed(() => actions.value.includes('ADD_NOTE'));
const actionLabel = computed(() => stopActionLabel(overview.value));
const disabled = computed(() => busy.value || !!error.value || !!uncertain.value);
const icon = name => window.UI.icon(name);

watch(() => props.eventId, () => {
  feedbackOpen.value = false; historyOpen.value = false; noteOpen.value = false;
  note.value = ''; confirmation.value = null; confirmationNote.value = ''; formError.value = '';
});
watch(() => stop.value?.stop_id, () => { confirmation.value = null; confirmationNote.value = ''; noteOpen.value = false; note.value = ''; });
watch(() => summary.value.tone, tone => { if (stop.value && tone === 'error') feedbackOpen.value = true; });

async function halt() {
  if (!canStop.value) return;
  await requestStop();
}
async function saveNote() {
  if (!canNote.value || disabled.value) return;
  if (note.value.trim().length < 2) { formError.value = '请填写至少两个字的急停原因'; return; }
  const eventId = props.eventId;
  if (await addNote(note.value.trim()) && eventId === props.eventId) { noteOpen.value = false; formError.value = ''; }
}
async function retry(device) {
  if (disabled.value || !device.allowed_actions?.includes('RETRY_STOP')) return;
  await retryDevice(device);
}
function startConfirmation(device) {
  if (disabled.value || !device.allowed_actions?.includes('MANUAL_CONFIRM')) return;
  confirmation.value = device; confirmationNote.value = ''; formError.value = '';
}
async function saveConfirmation() {
  if (!confirmation.value || disabled.value) return;
  if (confirmationNote.value.trim().length < 2) { formError.value = '请填写现场确认依据，不能只凭控制器回执确认停机'; return; }
  const eventId = props.eventId;
  if (await confirmDevice(confirmation.value, confirmationNote.value.trim()) && eventId === props.eventId) {
    confirmation.value = null; confirmationNote.value = ''; formError.value = '';
  }
}
function openNote() { noteOpen.value = !noteOpen.value; formError.value = ''; }
async function showFeedback() { feedbackOpen.value = true; await nextTick(); host.value?.scrollIntoView({ block: 'nearest' }); }
async function showNote() { noteOpen.value = true; await nextTick(); host.value?.scrollIntoView({ block: 'nearest' }); }
defineExpose({ refresh, showFeedback, showNote });
</script>

<template>
  <section v-if="visible" ref="host" class="emergency-stop-panel" aria-label="反制与干扰急停" :data-event-id="eventId">
    <header class="es-header">
      <div><h3>反制与干扰</h3><p v-if="eventLabel" class="es-muted">{{ eventLabel }}</p></div>
      <div v-if="!stop || overview?.applicable" class="es-stop-area">
        <button type="button" class="btn es-stop-button" :disabled="!canStop" @click="halt">
          <span aria-hidden="true" v-html="icon('stop')"></span>{{ busy ? '正在提交…' : actionLabel }}
        </button>
        <small>停止本事件反制及关联干扰</small>
      </div>
      <span v-else class="es-stopped">本次处置已中止</span>
    </header>
    <div class="es-content">
      <div v-if="loading && !overview" class="es-muted" role="status">正在读取当前处置状态…</div>
      <div v-if="error" class="es-status is-error" role="alert">
        <strong>暂时无法核对急停状态</strong><p>{{ error }}</p>
        <button v-if="!forbidden" type="button" class="btn" :disabled="loading || busy" @click="refresh">重新查询</button>
      </div>
      <div v-if="uncertain" class="es-status is-warning" role="status"><strong>请求结果未知</strong><p>{{ uncertain }}</p><button type="button" class="btn" :disabled="loading || busy" @click="refresh">查询当前结果</button><button v-if="retryReady" type="button" class="btn" :disabled="loading || busy" @click="retryPending">重试同一请求</button><p v-if="retryReady">已查询但尚未证实原请求结果；重试会沿用原请求标识。</p></div>
      <div v-if="overview?.block_reason" class="es-blocker">{{ overview.block_reason }}</div>
      <dl v-if="overview?.authorizations?.length" class="es-authorizations">
        <div v-for="authorization in overview.authorizations" :key="authorization.authorization_id">
          <dt>{{ labelOf(DISPOSAL_ACTION_LABEL, authorization.action_type, '处置') }}</dt>
          <dd>{{ authorization.status === 'STOPPED' ? '已中止' : labelOf(DISPOSAL_STATUS_LABEL, authorization.status, '状态未知') }}</dd>
        </div>
      </dl>
      <p v-if="historicalStop" class="es-history-label">上次处置的停止记录（当前处置尚未中止）</p>
      <div v-if="stop" class="es-status" :class="'is-' + summary.tone" role="status" aria-live="polite">
        <strong>{{ summary.title }}</strong><p>{{ summary.detail }}</p>
      </div>
      <template v-if="stop">
        <div class="es-actions">
          <button type="button" class="btn" :aria-expanded="feedbackOpen" @click="feedbackOpen = !feedbackOpen">{{ feedbackOpen ? '收起设备反馈' : '查看设备反馈' }}</button>
          <button v-if="canNote" type="button" class="btn es-link" :disabled="busy" :aria-expanded="noteOpen" @click="openNote">{{ stop.reason_pending ? '补充急停原因' : '追加原因说明' }}</button>
          <span v-else-if="stop.reason_pending" class="es-muted">原因待补充</span>
          <button type="button" class="btn es-link" :aria-expanded="historyOpen" @click="historyOpen = !historyOpen">{{ historyOpen ? '收起操作记录' : '查看操作记录' }}</button>
        </div>
        <div v-if="feedbackOpen" class="es-feedback">
          <p v-if="!stop.devices?.length" class="es-muted">没有可读取的设备反馈，请核查现场动作。</p>
          <article v-for="device in stop.devices" :key="device.device_id" class="es-device">
            <div class="es-device-title"><strong>{{ device.device_name || '设备名称未提供' }}</strong><span v-if="device.simulated" class="tag t-purple">模拟设备</span><span v-else-if="device.source_mode && device.source_mode !== 'live'" class="tag t-amber">{{ labelOf(SOURCE_MODE_LABEL, device.source_mode) }}</span></div>
            <p :class="{ 'es-needs-check': !['MANUALLY_CONFIRMED', 'NOT_REQUIRED'].includes(device.stop_status) }">{{ deviceStopText(device) }}</p>
            <p v-if="device.detail" class="es-muted">{{ device.detail }}</p>
            <p v-if="device.confirmed_at" class="es-muted">现场确认：{{ device.confirmed_by_name || '姓名未提供' }} · {{ stopTime(device.confirmed_at) }}</p>
            <p v-if="device.confirmation_note">确认依据：{{ device.confirmation_note }}</p>
            <div class="es-actions">
              <button v-if="device.allowed_actions?.includes('QUERY')" type="button" class="btn" :disabled="busy || loading" @click="refresh">{{ loading ? '查询中…' : '查询反馈' }}</button>
              <button v-if="device.allowed_actions?.includes('RETRY_STOP')" type="button" class="btn" :disabled="disabled" @click="retry(device)">重试停止</button>
              <button v-if="device.allowed_actions?.includes('MANUAL_CONFIRM')" type="button" class="btn" :disabled="disabled" @click="startConfirmation(device)">登记现场核查</button>
            </div>
          </article>
        </div>
        <div v-if="confirmation" class="es-form">
          <UField v-model="confirmationNote" label="现场停机确认依据" type="textarea" required :disabled="busy" :input-props="{ maxlength: 500 }" placeholder="请在现场确认设备已停止后填写，说明核查方式和看到的结果。" :help="confirmation.device_name" />
          <p v-if="formError" class="es-needs-check" role="alert">{{ formError }}</p>
          <div class="es-actions"><button type="button" class="btn" :disabled="busy" @click="confirmation = null">取消</button><button type="button" class="btn pri" :disabled="disabled" @click="saveConfirmation">确认已现场核查停机</button></div>
        </div>
        <div v-if="noteOpen" class="es-form">
          <UField v-model="note" label="补充急停原因" type="textarea" required :disabled="busy" :input-props="{ maxlength: 500 }" placeholder="例如：设备异常、现场要求或误操作" help="原因事后补填，不影响已经发起的停止。" />
          <p v-if="formError" class="es-needs-check" role="alert">{{ formError }}</p>
          <div class="es-actions"><button type="button" class="btn" :disabled="busy" @click="noteOpen = false">稍后补充</button><button type="button" class="btn pri" :disabled="disabled" @click="saveNote">保存原因</button></div>
        </div>
        <p v-if="!stop.reason_pending && stop.note" class="es-note">急停原因：{{ stop.note }}</p>
        <div v-if="historyOpen" class="es-history">
          <p class="es-muted">发起人：{{ stop.requested_by_name || '姓名未提供' }} · {{ stopTime(stop.requested_at) }}</p>
          <ol><li v-for="entry in stop.events || []" :key="entry.event_id"><time>{{ stopTime(entry.occurred_at) }}</time><span>{{ entry.actor_name || '系统' }} · {{ entry.note }}</span></li></ol>
          <p v-if="!stop.events?.length" class="es-muted">暂无可读取的操作记录</p>
        </div>
        <p v-if="!followup && !historicalStop" class="es-muted es-footer">继续处置需重新申请；急停不等于告警解除。</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.emergency-stop-panel { background:var(--surface-1); border:1px solid var(--line); border-radius:var(--r); min-width:0; color:var(--txt); }
.es-header { position:sticky; top:0; z-index:2; display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:14px; background:var(--surface-1); border-bottom:1px solid var(--line); border-radius:var(--r) var(--r) 0 0; }
.es-header h3 { margin:0; font-size:15px; }
.es-header p { margin:4px 0 0; overflow-wrap:anywhere; }
.es-stop-area { display:flex; flex-direction:column; align-items:flex-end; gap:5px; }
.es-stop-area small, .es-muted { color:var(--txt-2); }
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
.es-authorizations { margin:0; }
.es-authorizations > div { display:grid; grid-template-columns:100px 1fr; gap:10px; border-bottom:1px solid var(--line); padding:9px 0; }
.es-authorizations dt { color:var(--txt-2); }.es-authorizations dd { margin:0; }
.es-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.es-link { background:transparent; border-color:transparent; color:var(--blue); }
.es-feedback, .es-form, .es-history { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.es-device { padding:12px 0; border-bottom:1px solid var(--line); }.es-device:last-child { border-bottom:0; }
.es-device-title { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }.es-device-title strong { overflow-wrap:anywhere; }
.es-needs-check { color:var(--amber); }.es-note, .es-footer { padding-top:12px; }
.es-history-label { font-weight:600; padding-bottom:6px; }
.es-history ol { list-style:none; padding:0; margin:10px 0; }.es-history li { display:grid; gap:4px; padding:8px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }.es-history time { color:var(--txt-2); font-size:12px; }
@media (max-width:600px) { .es-stop-area { width:100%; align-items:stretch; }.es-stop-area small { text-align:center; }.es-authorizations > div { grid-template-columns:88px 1fr; } }
</style>
