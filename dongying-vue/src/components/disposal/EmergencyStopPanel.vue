<script setup>
import { computed, ref, toRef } from 'vue';
import { useEmergencyStop } from './useEmergencyStop.js';
import { stopActionLabel } from './emergencyStopView.js';

const props = defineProps({ eventId: { type: String, required: true }, eventLabel: { type: String, default: '' } });
const emit = defineEmits(['updated', 'changed']);
const host = ref(null);
const { overview, loading, busy, error, uncertain, forbidden, retryReady, refresh, retryPending, requestStop }
  = useEmergencyStop(toRef(props, 'eventId'), data => emit('updated', data), eventId => emit('changed', eventId));
const offered = computed(() => (overview.value?.allowed_actions || []).includes('EMERGENCY_STOP'));
const visible = computed(() => uncertain.value || !!error.value || (!!overview.value?.applicable && offered.value));
const hasDetails = computed(() => (loading.value && !overview.value) || error.value || uncertain.value || overview.value?.block_reason);
const actions = computed(() => overview.value?.allowed_actions || []);
const canStop = computed(() => actions.value.includes('EMERGENCY_STOP') && !busy.value && !loading.value && !error.value && !uncertain.value);
const actionLabel = computed(() => stopActionLabel(overview.value));
const icon = name => window.UI.icon(name);

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
  <section v-if="visible" ref="host" class="emergency-stop-panel" aria-label="反制与干扰急停" :data-event-id="eventId">
    <header class="es-header" :class="{ 'is-standalone': !hasDetails }">
      <div><h3>反制与干扰</h3><p v-if="eventLabel" class="es-muted">{{ eventLabel }}</p></div>
      <div class="es-stop-area">
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
