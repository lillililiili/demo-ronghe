import { computed, onUnmounted, ref, watch } from 'vue';
import { disposalApi, newDisposalIdempotencyKey } from '@/services/disposalApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { authUser } from '@/services/auth.js';
import { requiresStopFollowup } from './emergencyStopView.js';

// 页面切换后同一操作仍复用请求标识；状态始终回读服务端，不使用本 Map 推进成功。
const pendingKeys = new Map();
const messageOf = error => error?.status === 401 ? '登录已失效，请重新登录'
  : error?.status === 403 ? '当前账号没有查看或操作本次处置的权限'
    : error?.status === 404 ? '当前事件不可见，或急停服务尚未接入'
      : error?.message || '暂时无法读取急停状态，请重试';

export function useEmergencyStop(eventId, onUpdate, onChanged) {
  const overview = ref(null), loading = ref(false), busy = ref(false), error = ref('');
  const uncertain = ref(''), forbidden = ref(false), retryReady = ref(false);
  let generation = 0, readSeq = 0, disposed = false, timer = null, fingerprint = '', pending = null;
  const stop = computed(() => overview.value?.latest_stop || null);
  const followup = computed(() => requiresStopFollowup(overview.value));

  function apply(data) {
    overview.value = data;
    const next = JSON.stringify(data);
    if (next !== fingerprint) { fingerprint = next; onUpdate?.(data); }
    if (pending?.confirmed(data)) {
      pendingKeys.delete(pending.identity);
      pending = null;
      uncertain.value = ''; retryReady.value = false;
      onChanged?.(eventId.value);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (disposed || forbidden.value || !eventId.value) return;
    timer = setTimeout(async () => {
      if (!busy.value && document.visibilityState !== 'hidden') await refresh();
      else schedule();
    }, followup.value || uncertain.value ? 5000 : 15000);
  }

  async function refresh() {
    if (!eventId.value || busy.value || disposed) return;
    clearTimeout(timer);
    const id = eventId.value, epoch = generation, seq = ++readSeq;
    loading.value = true;
    try {
      const data = await disposalApi.emergencyOverview(id);
      if (disposed || epoch !== generation || seq !== readSeq) return;
      error.value = ''; forbidden.value = false;
      apply(data);
      // 读成功仍未证实：允许重放同一请求，不把未查到误判为未提交。
      retryReady.value = !!pending && !!uncertain.value;
    } catch (cause) {
      if (disposed || epoch !== generation || seq !== readSeq) return;
      retryReady.value = false;
      error.value = messageOf(cause);
      forbidden.value = [401, 403, 404].includes(cause?.status);
      if (forbidden.value) { overview.value = null; onUpdate?.(null); }
    } finally {
      if (!disposed && epoch === generation && seq === readSeq) { loading.value = false; schedule(); }
    }
  }

  async function mutate(action, params, call, confirmed) {
    if (busy.value || disposed || !eventId.value || forbidden.value || uncertain.value) return false;
    const identity = JSON.stringify([authUser.value?.user_id || authUser.value?.account, eventId.value, action, params]);
    const key = pendingKeys.get(identity) || newDisposalIdempotencyKey(`emergency-${action}`);
    pendingKeys.set(identity, key);
    return executeMutation({ identity, key, call, confirmed });
  }

  async function executeMutation(operation) {
    const id = eventId.value, epoch = generation;
    const { identity, key, call } = operation;
    clearTimeout(timer); ++readSeq;
    busy.value = true; loading.value = false; error.value = ''; uncertain.value = ''; retryReady.value = false;
    try {
      const result = await call(id, key);
      pendingKeys.delete(identity);
      if (disposed || epoch !== generation) return false;
      pending = null; apply(result); onChanged?.(id); return true;
    } catch (cause) {
      if (disposed || epoch !== generation) return false;
      if ((isUncertainOutcome(cause) && cause.status !== 409) || cause.status >= 500) {
        pending = operation;
        uncertain.value = '请求结果未知，正在核对；请勿重复操作。';
      } else {
        pendingKeys.delete(identity); pending = null;
        error.value = messageOf(cause);
        forbidden.value = [401, 403, 404].includes(cause?.status);
      }
      return false;
    } finally {
      if (!disposed && epoch === generation) {
        busy.value = false;
        if (!forbidden.value && uncertain.value) await refresh();
        else schedule();
      }
    }
  }

  function retryPending() {
    if (!retryReady.value || !pending || busy.value || loading.value || disposed || forbidden.value) return false;
    return executeMutation(pending);
  }

  function requestStop() {
    const previous = stop.value?.stop_id;
    return mutate('stop', { previous }, (id, key) => disposalApi.emergencyStop(id, key),
      data => !!data?.latest_stop && data.latest_stop.stop_id !== previous);
  }
  function addNote(note) {
    const stopId = stop.value?.stop_id;
    return mutate('note', { stopId, note }, (id, key) => disposalApi.emergencyNote(id, stopId, note, key),
      data => data?.latest_stop?.stop_id === stopId && data.latest_stop.note === note && !data.latest_stop.reason_pending);
  }
  function retryDevice(device) {
    const stopId = stop.value?.stop_id, previous = device.command_id;
    return mutate('retry', { stopId, deviceId: device.device_id, previous },
      (id, key) => disposalApi.emergencyRetry(id, stopId, device.device_id, key),
      data => data?.latest_stop?.stop_id === stopId && data.latest_stop.devices?.some(d => d.device_id === device.device_id && d.command_id && d.command_id !== previous));
  }
  function confirmDevice(device, note) {
    const stopId = stop.value?.stop_id;
    return mutate('confirm', { stopId, deviceId: device.device_id, note },
      (id, key) => disposalApi.emergencyConfirm(id, stopId, device.device_id, note, key),
      data => data?.latest_stop?.stop_id === stopId && data.latest_stop.devices?.some(d => d.device_id === device.device_id && d.stop_status === 'MANUALLY_CONFIRMED'));
  }

  watch([eventId, authUser], () => {
    ++generation; ++readSeq; clearTimeout(timer);
    overview.value = null; error.value = ''; uncertain.value = ''; loading.value = false;
    forbidden.value = false; busy.value = false; retryReady.value = false; fingerprint = ''; pending = null;
    onUpdate?.(null); refresh();
  }, { immediate: true });
  onUnmounted(() => { disposed = true; ++generation; ++readSeq; clearTimeout(timer); });
  return { overview, stop, followup, loading, busy, error, uncertain, forbidden, retryReady, refresh, retryPending, requestStop, addNote, retryDevice, confirmDevice };
}
