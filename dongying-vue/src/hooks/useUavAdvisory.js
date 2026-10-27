import { onMounted, onUnmounted, ref, watch } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { refreshFailureText, shouldRetryRefresh, useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';

// SSE 更新只读状态；观察窗口跨时点补读结论，短信、电话触发仍由后台负责。
export function useUavAdvisory(eventId, onUpdated = () => {}, interval = 5000, onUnavailable = () => {}, riskCaseId = () => '', expectedRisk = () => null) {
  const data = ref(null), loading = ref(false), error = ref('');
  let alive = true, sequence = 0, timer, failures = 0, inFlight = null, dirty = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  // 同身份在途期间的新信号不可被旧快照吞掉；完成后合并补读一次。
  // 版本变化立即作废旧资格，只有本次读取的相同或更新风险上下文可以发布。
  function outdated(result) {
    const required = expectedRisk(), actual = result?.risk_case;
    if (!required?.risk_case_id) return false;
    if (actual?.risk_case_id !== required.risk_case_id || actual.version == null
      || !Number.isInteger(Number(actual.version))) return true;
    return Number(actual.version) < Number(required.version) || (Number(actual.version) === Number(required.version)
      && ((required.stage && actual.stage !== required.stage)
        || (required.verification_status && actual.verification_status !== required.verification_status)));
  }
  // 断网时退避；有新上下文或未消费的信号必须补读，普通成功仍等待 SSE。
  const nextDelay = () => failures ? Math.min(Math.max(interval, 2000) * 2 ** (failures - 1), 15000) : interval;
  function schedule() {
    clear();
    if ((dirty || failures || data.value?.notify_phase === 'WATCHING' || data.value?.response_order?.voice_status === 'WAITING_START') && alive && eventId() && !document.hidden) timer = setTimeout(() => load(true), nextDelay());
  }
  function load(background = false) {
    const id = eventId(), caseId = riskCaseId();
    if (inFlight?.id === id && inFlight?.caseId === caseId) { dirty = true; return inFlight.promise; }
    const request = { id, caseId, promise: null };
    request.promise = read(background).finally(() => { if (inFlight === request) inFlight = null; });
    inFlight = request;
    return request.promise;
  }
  async function read(background = false) {
    clear(); dirty = false;
    const token = ++sequence, id = eventId(), caseId = riskCaseId(), startedAt = Date.now();
    if (!id || !alive) return;
    if (!background || !data.value) loading.value = true;
    try {
      const result = await uavAdvisoryApi.get(id, caseId);
      if (!alive || token !== sequence || (id !== eventId() || caseId !== riskCaseId())) return;
      if (outdated(result)) {
        data.value = null; error.value = ''; dirty = true;
        return;
      }
      data.value = { ...result, _riskCaseId: caseId }; error.value = ''; failures = 0;
      onUpdated({ ...data.value, _fetchedAt: startedAt });
    } catch (e) {
      if (alive && token === sequence && id === eventId() && caseId === riskCaseId()) {
        const retry = e.code === 'RISK_CASE_CHANGED' || shouldRetryRefresh(e);
        if (!retry) dirty = false;
        failures = retry ? failures + 1 : 0;
        if ([401, 403, 404].includes(e.status)) data.value = null;
        error.value = [404, 501].includes(e.status) ? '处置记录接口暂不可用，请稍后重试。'
          : retry ? `处置记录暂时读不到（${refreshFailureText(e)}），正在自动重试。` : e.message || '读取处置记录失败。';
        onUnavailable(id, startedAt, caseId);
      }
    } finally {
      if (alive && token === sequence) { loading.value = false; schedule(); }
    }
  }
  useRealtimeRefresh(['alarm', 'prediction', 'target', 'disposal', 'punishment'], () => load(true), { minIntervalMs: interval });
  const visibility = () => { clear(); if (!document.hidden) void load(true); };
  watch([eventId, riskCaseId, () => expectedRisk()?.version, () => expectedRisk()?.stage, () => expectedRisk()?.verification_status], (next, previous) => {
    const identityChanged = !previous || next[0] !== previous[0] || next[1] !== previous[1];
    if (identityChanged) { ++sequence; dirty = false; loading.value = false; }
    clear(); failures = 0; error.value = '';
    if (identityChanged || outdated(data.value)) data.value = null;
    void load(!identityChanged);
  }, { immediate: true });
  onMounted(() => document.addEventListener('visibilitychange', visibility));
  onUnmounted(() => { alive = false; ++sequence; clear(); document.removeEventListener('visibilitychange', visibility); });
  return { data, loading, error, load };
}
