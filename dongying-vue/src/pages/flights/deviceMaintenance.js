import { reactive } from 'vue';
import { apiRequestTimed } from '@/services/apiClient.js';
import { authUser } from '@/services/auth.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';

// 列表与地图共用提交状态；结果未知时沿用原幂等键重试。
const submissions = reactive(new Map());
export function deviceNoticeState(planId, deviceId) {
  const key = `${authUser.value?.user_id || ''}:${planId}:${deviceId}`;
  if (!submissions.has(key)) submissions.set(key, { pending: false, key: null, task: null, error: '', reading: false, readError: '', readGeneration: 0 });
  return submissions.get(key);
}

export async function loadDeviceMaintenanceNotice(planId, deviceId) {
  if (!planId || !deviceId) return;
  const state = deviceNoticeState(planId, deviceId);
  if (state.reading || state.pending) return;
  const generation = ++state.readGeneration;
  state.reading = true; state.readError = '';
  try {
    const result = await apiRequestTimed(`/flight-plans/${encodeURIComponent(planId)}/device-maintenance-tasks?device_id=${encodeURIComponent(deviceId)}`);
    if (generation === state.readGeneration) state.task = result.items?.[0] || null;
  } catch (error) {
    if (generation === state.readGeneration) state.readError = error.message || '运维通知记录读取失败，请重试';
  } finally { if (generation === state.readGeneration) state.reading = false; }
}

export async function notifyDeviceAbnormal(planId, deviceId) {
  const state = deviceNoticeState(planId, deviceId);
  if (state.pending) return null;
  state.readGeneration++; state.reading = false;
  state.pending = true;
  state.error = '';
  state.key ||= newHandoffIdempotencyKey();
  try {
    const task = await apiRequestTimed(`/flight-plans/${encodeURIComponent(planId)}/device-maintenance-tasks`, {
      method: 'POST', body: { device_id: deviceId }, mutation: true, idempotencyKey: state.key
    });
    if (!task?.task_id) throw new Error('未取得后台待办编号，请重试确认结果。');
    state.task = task;
    state.key = null;
    return task;
  } catch (error) {
    state.error = error?.status === 404
      ? '未找到后台通知接口或关联设备，请确认前台和管理端连接同一新版后台。'
      : error?.message || '未确认提交结果，请重试；同一次提交不会重复生成待办。';
    throw new Error(state.error);
  } finally { state.pending = false; }
}
