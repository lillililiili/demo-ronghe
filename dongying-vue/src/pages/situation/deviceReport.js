import { reactive } from 'vue';
import { apiRequestTimed, isUncertainOutcome } from '@/services/apiClient.js';
import { authUser } from '@/services/auth.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';

const states = reactive(new Map());
const prefix = 'dongying.device-report.pending.v1:';
function remember(state, key) {
  state.requestKey = key;
  try {
    if (key) sessionStorage.setItem(prefix + state.identity, key);
    else sessionStorage.removeItem(prefix + state.identity);
  } catch { /* 本页仍保留原提交编号供重试。 */ }
}
export function deviceReportState(deviceId) {
  const identity = `${authUser.value?.user_id || ''}:${deviceId}`;
  if (!states.has(identity)) {
    let requestKey = null;
    try { requestKey = sessionStorage.getItem(prefix + identity); } catch { /* 浏览器存储不可用。 */ }
    states.set(identity, { identity, requestKey, context: null, reading: false, refreshing: false, pending: false,
      loadedAt: null, readError: '', error: '', result: null, generation: 0 });
  }
  return states.get(identity);
}
const path = id => `/devices/${encodeURIComponent(id)}/maintenance-report`;
function validate(data, deviceId) {
  if (data?.device_id !== deviceId || typeof data.can_report !== 'boolean'
      || (data.task && (!data.task.task_id || !data.task.workflow_state))) {
    throw new Error('设备上报结果不完整，请刷新核对。');
  }
  return data;
}
export async function loadDeviceReport(deviceId, { quiet = false } = {}) {
  if (!deviceId) return;
  const state = deviceReportState(deviceId);
  if (state.pending || state.refreshing) return;
  const generation = ++state.generation;
  state.refreshing = true; if (!quiet) state.reading = true;
  try {
    const context = validate(await apiRequestTimed(path(deviceId), { dedupe: false }), deviceId);
    if (generation !== state.generation) return;
    state.context = context; state.loadedAt = Date.now(); state.readError = '';
    if (state.result?.taskId !== context.task?.task_id) state.result = null;
    // A GET cannot prove whether this particular POST committed. Keep the original key until replay confirms it.
  } catch (error) {
    if (generation !== state.generation) return;
    state.readError = error.message || '处置进度读取失败，请刷新重试。';
    if ([401, 403, 404].includes(error.status)) { state.context = null; state.result = null; }
    if (quiet) throw error;
  } finally { if (generation === state.generation) { state.reading = false; state.refreshing = false; } }
}
export async function submitDeviceReport(deviceId) {
  const state = deviceReportState(deviceId);
  if (state.pending || state.reading || (!state.requestKey && (!state.context?.can_report || state.readError))) return;
  const replay = !!state.requestKey;
  remember(state, state.requestKey || newHandoffIdempotencyKey());
  state.generation++; state.reading = false; state.refreshing = false; state.pending = true; state.error = '';
  try {
    const context = validate(await apiRequestTimed(path(deviceId), { method: 'POST', mutation: true,
      idempotencyKey: state.requestKey }), deviceId);
    if (!context.task?.task_id) throw new Error('未取得处置单，请用原提交重试确认结果。');
    state.context = context; state.loadedAt = Date.now(); state.readError = '';
    state.result = { taskId: context.task.task_id, text: replay ? '上报已保存'
      : context.reused ? '上报已保存，已关联原处置单，后台不会新增一条待办。' : '上报已保存，后台已新建处置单。' };
    remember(state, null);
    return context;
  } catch (error) {
    const uncertain = isUncertainOutcome(error) || !error.status || error.status >= 500 || error.code === 'INVALID_RESPONSE';
    if (!uncertain) remember(state, null);
    state.error = error.message || '上报失败，请重试。';
  } finally { state.pending = false; }
}
