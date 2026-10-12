import { reactive } from 'vue';
import { apiRequestTimed, isUncertainOutcome } from '@/services/apiClient.js';
import { authUser } from '@/services/auth.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';

export function maintenanceState(task) {
  return task?.workflow_state || (task?.status === 'HANDLED' ? 'LEGACY_HANDLED' : task?.status);
}
export function maintenanceStateLabel(task) {
  return ({ PENDING: '待处理', PROCESSING: '处理中', READY_TO_COMPLETE: '待确认办结',
    PENDING_VERIFICATION: '系统核验中', COMPLETED: '已办结', LEGACY_HANDLED: '历史已反馈' })[maintenanceState(task)] || '状态待确认';
}
export function maintenanceRecoveryText(task) {
  // 已办结单的 PASS 是当时的核验快照，不能冒充设备当前恢复事实。
  return maintenanceState(task) === 'READY_TO_COMPLETE' && task?.recovery?.result === 'PASS'
    ? '设备已恢复 · 等待后台确认办结' : '';
}

// 仅用于已确认的上报 POST；列表 GET 的 reused=false 不能用来判断本次是否新建。
export function maintenanceReportResult(task, replay = false) {
  if (!task?.task_id) return null;
  // 重试返回的 reused 也可能只是同一请求重放，不能据此声称原来已有处置单。
  const linkedExisting = !replay && task.reused === true;
  return { taskId: task.task_id, linkedExisting,
    title: linkedExisting ? '上报已保存 · 已关联原处置单'
      : !replay && task.reused === false ? '上报已保存 · 已新建处置单' : '上报已保存',
    description: linkedExisting ? '该设备已有处置单，本次上报已并入原单，后台不会新增一条待办。'
      : '本任务的设备异常已记录，请按下方设备和处置单编号查看办理进展。' };
}

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
      task: null, reportResult: null, loaded: false, error: '', reading: false, readError: '', readGeneration: 0, loadedAt: null });
  }
  return submissions.get(key);
}

export async function loadDeviceMaintenanceNotice(planId, deviceId) {
  if (!planId || !deviceId) return;
  const state = deviceNoticeState(planId, deviceId);
  if (state.reading || state.pending) return;
  const generation = ++state.readGeneration;
  // 失败后的重试尚未成功，旧恢复结果仍属于过时信息。
  state.reading = true;
  try {
    // 此处已由按用户隔离的 state 合并读取，避免跨账号复用全局同路径 GET。
    const result = await apiRequestTimed(`/flight-plans/${encodeURIComponent(planId)}/device-maintenance-tasks?device_id=${encodeURIComponent(deviceId)}`, { dedupe: false });
    if (!Array.isArray(result?.items) || (result.items.length && !result.items[0]?.task_id))
      throw new Error('后台通知记录格式不完整，请刷新或确认前后台版本一致。');
    if (generation !== state.readGeneration) return;
    state.task = result.items?.[0] || null;
    if (state.reportResult?.taskId !== state.task?.task_id) state.reportResult = null;
    state.loaded = true; state.loadedAt = Date.now(); state.readError = '';
    const { request, task } = state;
    const resolved = request && task && (request.kind === 'create'
      ? task.task_id !== request.previousTaskId || task.status === 'PENDING'
      : task.task_id !== request.taskId || Number(task.latest_notification_attempt_no) > request.expectedAttemptNo);
    if (resolved) { rememberRequest(state, null); state.uncertain = false; }
    if (!state.uncertain) state.error = '';
    return state.task;
  } catch (error) {
    if (generation === state.readGeneration) {
      state.readError = error.message || '运维通知记录读取失败，请重试';
      if ([401, 403, 404].includes(error.status)) { state.task = null; state.reportResult = null; state.loaded = false; }
    }
  } finally { if (generation === state.readGeneration) state.reading = false; }
}

async function submitNotice(planId, deviceId, request, replay = false) {
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
      body: resending ? { expected_attempt_no: request.expectedAttemptNo, reason: request.reason, plan_id: planId } : { device_id: deviceId } });
    if (!task?.task_id) throw new Error('未取得后台待办编号，请刷新确认提交结果。');
    state.task = task; state.loaded = true; state.loadedAt = Date.now(); state.uncertain = false; state.readError = '';
    if (!resending) state.reportResult = maintenanceReportResult(task, replay);
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
  return submitNotice(planId, deviceId, state.request, true);
}
