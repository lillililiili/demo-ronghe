import { reactive } from 'vue';
import { apiRequestTimed, isUncertainOutcome } from '@/services/apiClient.js';
import { authUser } from '@/services/auth.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';

// 地图与列表共用服务端结果；未确认的提交跨刷新保留原幂等键。
const submissions = reactive(new Map());
const storagePrefix = 'dongying.maintenance.pending.v1:';
const rejectedCommands = new Set(['MAINTENANCE_RESEND_BLOCKED', 'MAINTENANCE_NOTICE_CHANGED', 'MAINTENANCE_TASK_CHANGED',
  'DEVICE_NOT_NEAR_PLAN', 'MAINTENANCE_OBSERVATION_STALE', 'DEVICE_NOT_ABNORMAL', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_REPLAY']);
function savedRequest(key) {
  try {
    const request = JSON.parse(sessionStorage.getItem(storagePrefix + key) || 'null');
    return request?.key && ['create', 'resend'].includes(request.kind) ? request : null;
  } catch { return null; }
}
function rememberRequest(state, request) {
  state.request = request;
  try {
    if (request) sessionStorage.setItem(storagePrefix + state.storageKey, JSON.stringify(request));
    else sessionStorage.removeItem(storagePrefix + state.storageKey);
  } catch { /* 存储不可用时仍保留本页的原提交编号。 */ }
}

export function deviceNoticeState(planId, deviceId) {
  const key = `${authUser.value?.user_id || ''}:${planId}:${deviceId}`;
  if (!submissions.has(key)) {
    const request = savedRequest(key);
    submissions.set(key, { storageKey: key, pending: false, request, uncertain: !!request,
      task: null, loaded: false, error: '', reading: false, readError: '', readGeneration: 0 });
  }
  return submissions.get(key);
}

export async function loadDeviceMaintenanceNotice(planId, deviceId) {
  if (!planId || !deviceId) return;
  const state = deviceNoticeState(planId, deviceId);
  if (state.reading || state.pending) return;
  const generation = ++state.readGeneration;
  state.reading = true; state.readError = '';
  try {
    // 此处已由按用户隔离的 state 合并读取，避免跨账号复用全局同路径 GET。
    const result = await apiRequestTimed(`/flight-plans/${encodeURIComponent(planId)}/device-maintenance-tasks?device_id=${encodeURIComponent(deviceId)}`, { dedupe: false });
    if (!Array.isArray(result?.items) || (result.items.length && !result.items[0]?.task_id))
      throw new Error('后台通知记录格式不完整，请刷新或确认前后台版本一致。');
    if (generation !== state.readGeneration) return;
    state.task = result.items?.[0] || null;
    state.loaded = true;
    const { request, task } = state;
    const resolved = request && task && (request.kind === 'create'
      ? task.task_id !== request.previousTaskId || task.status === 'PENDING'
      : task.task_id !== request.taskId || Number(task.latest_notification_attempt_no) > request.expectedAttemptNo);
    if (resolved) { rememberRequest(state, null); state.uncertain = false; }
    if (!state.uncertain) state.error = '';
    return state.task;
  } catch (error) {
    if (generation === state.readGeneration) state.readError = error.message || '运维通知记录读取失败，请重试';
  } finally { if (generation === state.readGeneration) state.reading = false; }
}

async function submitNotice(planId, deviceId, request) {
  const state = deviceNoticeState(planId, deviceId);
  if (state.pending) return null;
  state.readGeneration++; state.reading = false;
  state.pending = true; state.error = '';
  rememberRequest(state, request);
  const resending = request.kind === 'resend';
  let refreshRejected = false;
  const path = resending
    ? `/device-maintenance-tasks/${encodeURIComponent(request.taskId)}/notifications/resend`
    : `/flight-plans/${encodeURIComponent(planId)}/device-maintenance-tasks`;
  try {
    const task = await apiRequestTimed(path, { method: 'POST', mutation: true, idempotencyKey: request.key,
      body: resending ? { expected_attempt_no: request.expectedAttemptNo, reason: request.reason } : { device_id: deviceId } });
    if (!task?.task_id) throw new Error('未取得后台待办编号，请刷新确认提交结果。');
    state.task = task; state.loaded = true; state.uncertain = false; state.readError = '';
    rememberRequest(state, null);
    return task;
  } catch (error) {
    refreshRejected = error?.status === 409 && rejectedCommands.has(error.code);
    state.uncertain = !refreshRejected && (isUncertainOutcome(error) || !error?.status || error.status >= 500 || error.code === 'INVALID_RESPONSE');
    if (!state.uncertain) rememberRequest(state, null);
    state.error = error?.status === 404
      ? '未找到通知接口或关联记录，请确认前后台已更新并刷新记录。'
      : error?.message || '未确认提交结果，请先刷新状态。';
    throw new Error(state.error);
  } finally {
    state.pending = false;
    if (refreshRejected) {
      const message = state.error;
      await loadDeviceMaintenanceNotice(planId, deviceId);
      state.error = message;
    }
  }
}

export function notifyDeviceAbnormal(planId, deviceId) {
  const state = deviceNoticeState(planId, deviceId);
  if (state.pending || state.uncertain || state.reading || state.readError || !state.loaded) return null;
  return submitNotice(planId, deviceId, { kind: 'create', key: newHandoffIdempotencyKey(), previousTaskId: state.task?.task_id || null });
}

export function resendDeviceNotice(planId, deviceId) {
  const state = deviceNoticeState(planId, deviceId);
  if (state.pending || state.uncertain || state.reading || state.readError || !state.task?.can_resend_notification) return null;
  return submitNotice(planId, deviceId, { kind: 'resend', key: newHandoffIdempotencyKey(), taskId: state.task.task_id,
    expectedAttemptNo: state.task.latest_notification_attempt_no,
    reason: state.task.notification_delivery_status === 'FAILED' ? '发送失败后重试' : '人工再次通知' });
}

export function retryDeviceNoticeSubmission(planId, deviceId) {
  const state = deviceNoticeState(planId, deviceId);
  if (!state.uncertain || !state.request || state.pending || state.reading || state.readError) return null;
  return submitNotice(planId, deviceId, state.request);
}
