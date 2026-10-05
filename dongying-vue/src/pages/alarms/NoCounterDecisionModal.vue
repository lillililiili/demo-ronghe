<script setup>
import { ref, onUnmounted } from 'vue';
import { NButton } from 'naive-ui';
import { noCounterApi } from '@/services/noCounterApi.js';
import { newDisposalIdempotencyKey } from '@/services/disposalApi.js';
import { userFacingMessage } from '@/ui/labels.js';
import NoCounterBasis from './NoCounterBasis.vue';

const props = defineProps({ status: { type: Object, required: true }, eventLabel: String, isCurrent: { type: Function, required: true } });
const emit = defineEmits(['saved', 'refreshed', 'close']);
const busy = ref(false), error = ref(''), mustReload = ref(false);
const eventId = props.status.event_id;
// 固定用户实际看到的依据与版本；超时重试沿用原请求，不偷偷换成更新后的依据。
const body = { expected_version: props.status.event_version, expected_evaluation_id: props.status.basis?.evaluation_id };
const requestKey = newDisposalIdempotencyKey('no-counter');
let alive = true;
onUnmounted(() => { alive = false; });
const current = () => alive && props.isCurrent();

async function submit() {
  if (busy.value || mustReload.value || !current() || props.status.can_decide !== true) return;
  busy.value = true; error.value = '';
  try {
    const result = await noCounterApi.decide(eventId, body, requestKey);
    if (!current()) return;
    if (result?.event_id !== eventId || !result.decision?.decision_id) throw new Error('没有取得已保存的决定，请回读核查');
    emit('saved', result);
  } catch (cause) {
    if (!current()) return;
    const conflict = cause.status === 409;
    const uncertain = !cause.status || cause.status >= 500 || cause.status === 408 || ['TIMEOUT', 'NETWORK_ERROR'].includes(cause.code);
    const message = userFacingMessage(cause.message) || '未返回明确结果';
    if (conflict) {
      mustReload.value = true;
      error.value = `${message}。请返回核对最新状态，再重新打开确认。`;
    } else if (uncertain) error.value = `提交结果未确认，请回读记录核查：${message}`;
    else {
      mustReload.value = true;
      error.value = `${message}。请返回核对后重新操作。`;
    }
    try {
      const latest = await noCounterApi.get(eventId);
      if (!current() || latest?.event_id !== eventId) return;
      emit('refreshed', latest);
      if (latest.decision_active === true) {
        mustReload.value = true;
        error.value = '当前事件已有不反制决定，请返回核对决定人员和时间；本次请求结果未单独确认。';
      } else if (latest.event_version !== body.expected_version || latest.basis?.evaluation_id !== body.expected_evaluation_id || latest.can_decide !== true) {
        mustReload.value = true;
        error.value = `${message}。当前状态或依据已变化，请返回核对后重新确认。`;
      }
    } catch { /* 未知结果保留原幂等键，不能猜测保存成功。 */ }
  } finally { if (alive) busy.value = false; }
}
</script>

<template>
  <section class="no-counter-modal" aria-label="确认不反制">
    <div class="decision-event"><strong>{{ eventLabel || '当前告警事件' }}</strong><span>本次决定只作用于当前事件</span></div>
    <h3>请核对本次决定依据</h3>
    <NoCounterBasis :basis="status.basis" />
    <div class="decision-conclusion"><span>处置决定</span><b>人工确认当前无风险，决定不反制</b></div>
    <div class="decision-outcome"><strong>确认后，结束本次处置</strong><p>保留原告警和本次决定，持续监测；出现新的风险依据时重新判断。</p></div>
    <p class="decision-note">记录操作者、时间与上述依据。是否移送另按事件事实判断；本次决定不代表目标已飞离。</p>
    <p v-if="error" class="decision-error" role="alert">{{ error }}</p>
    <footer><NButton :disabled="busy" @click="emit('close')">返回查看</NButton><NButton type="primary" :loading="busy" :disabled="busy || mustReload || status.can_decide !== true" @click="submit">{{ busy ? '正在保存' : '确认不反制' }}</NButton></footer>
  </section>
</template>

<style scoped>
.no-counter-modal{min-width:0}.decision-event{padding:13px 15px;background:var(--input-bg);border:1px solid var(--line);border-radius:var(--r)}.decision-event strong{display:block;font-size:14px;font-weight:500;overflow-wrap:anywhere}.decision-event span{display:block;margin-top:5px;font-size:12px;color:var(--txt-3)}.no-counter-modal h3{font-size:13px;font-weight:500;margin:20px 0 12px}.decision-conclusion{border-top:1px solid var(--line);padding-top:12px;display:flex;gap:14px;font-size:12px;line-height:1.7}.decision-conclusion span{color:var(--txt-3);flex:none;width:70px}.decision-conclusion b{font-weight:400;color:var(--txt-2)}.decision-outcome{border-left:3px solid var(--cyan);background:var(--surface-selected);padding:13px 15px;margin-top:22px}.decision-outcome strong{font-size:13px;font-weight:500}.decision-outcome p,.decision-note{margin:7px 0 0;font-size:12px;line-height:1.8;color:var(--txt-2)}.decision-note{margin:16px 0;color:var(--txt-3)}.decision-error{font-size:13px;line-height:1.75;color:var(--red);overflow-wrap:anywhere}.no-counter-modal footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:16px;margin-top:18px}
</style>
