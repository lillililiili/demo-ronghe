<script setup>
import { userFacingMessage } from '@/ui/labels.js';
import { computed, onUnmounted } from 'vue';
import AutoSmsNotice from './AutoSmsNotice.vue';
import AutoVoiceNotice from './AutoVoiceNotice.vue';
import AdvisoryRecords from './AdvisoryRecords.vue';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
import { autoHandoffView, handoffSubmitError, partyWarning } from './autoHandoffView.js';
import { openFormModal } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';

const props = defineProps({
  eventId: { type: String, required: true }, confirmed: Boolean,
  handoffId: { type: String, default: '' },
  interval: { type: Number, default: 5000 }
});
const emit = defineEmits(['updated']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, result => emit('updated', result), props.interval);
let alive = true;
onUnmounted(() => { alive = false; });
const current = computed(() => data.value?.event_id === props.eventId && !loading.value && !error.value);
const historicalObservations = computed(() => data.value?.event_id === props.eventId
  ? (data.value.records || []).filter(row => row.kind === 'OBSERVATION') : []);
const handoff = computed(() => autoHandoffView(data.value, props.handoffId));
function openHandoff() {
  if (handoff.value.handoffId) window.location.hash = `/punish?handoff=${encodeURIComponent(handoff.value.handoffId)}`;
}
const escText = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* 启用了多个处罚接收单位时，后台不替人选（决策 18-14），由有移送权限的人在这里选定后提交。 */
async function submitHandoff() {
  const view = handoff.value;
  if (!view.canSubmit || !current.value) return;
  const id = data.value.event_id, version = data.value.event_version;
  let recipients;
  try {
    recipients = (await handoffApi.listHandoffRecipients('UAV_PUNISHMENT'))?.items || [];
  } catch (listError) {
    toast(listError.status === 403 ? '当前账号没有查看处罚接收单位的权限' : listError.message || '读取处罚接收单位失败，请稍后重试', 'err');
    return;
  }
  if (!alive || id !== data.value?.event_id) return;
  if (!recipients.length) { toast('还没有启用的处罚接收单位，请联系管理员配置', 'err'); load(); return; }
  const key = newHandoffIdempotencyKey();
  const unidentified = view.partyUnidentified;
  const modal = openFormModal({
    title: '选择接收单位并移送到处罚', confirmText: '提交移送', width: '560px',
    warning: unidentified ? escText(partyWarning(view)) : '',
    notice: '提交后，移送材料按现在的事实保存，并发给所选单位。发出和签收结果以移送记录为准。',
    fields: [
      { key: 'recipient_id', label: '处罚接收单位', type: 'select', required: true, placeholder: '请选择接收单位',
        options: recipients.map(item => ({ label: item.display_name || item.recipient_id, value: item.recipient_id })) },
      ...(unidentified ? [{ key: 'party_confirmed', label: '当事人', type: 'checkbox', boxLabel: '我已知道当事人不明，按待补线索移送' }] : [])
    ],
    initial: { recipient_id: null, party_confirmed: false },
    submitEnabled: value => !!value.recipient_id && (!unidentified || value.party_confirmed === true),
    validate: value => !value.recipient_id ? '请选择处罚接收单位'
      : unidentified && value.party_confirmed !== true ? '请先确认已知道当事人不明' : null,
    onSubmit: async value => {
      const stillCurrent = () => alive && id === data.value?.event_id && modal.isCurrent();
      if (!stillCurrent()) throw new Error('事件已切换，请关闭后重新操作');
      try {
        await handoffApi.createHandoff({ source_kind: 'UAV_EVENT', source_id: id, handoff_type: 'UAV_PUNISHMENT',
          recipient_id: value.recipient_id, expected_version: version }, key);
        if (!stillCurrent()) return;
        modal.close(); load(); toast('已移送到处罚，请在“移送与处罚”查看发出结果', 'ok');
      } catch (submitError) {
        if (!stillCurrent()) return;
        load();
        throw new Error(handoffSubmitError(submitError));
      }
    }
  });
}
</script>

<template>
  <section v-if="confirmed || loading || error || data || handoffId" class="uav-advisory" aria-label="飞手通知与处置进度">
    <header class="ua-head"><h3>处置进度</h3><button type="button" class="ua-link" :disabled="loading" @click="load()">{{ loading ? '正在读取' : error ? '重试' : '更新记录' }}</button></header>
    <p v-if="error" class="ua-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !data" class="ua-note">正在读取通知与处置进度</p>
    <template v-if="data">
      <AutoSmsNotice compact :data="data" :disabled="!current" @changed="load()" />
      <AutoVoiceNotice compact :data="data" :disabled="!current" @changed="load()" />
      <details v-if="historicalObservations.length" class="ua-history">
        <summary>历史现场观察记录（{{ historicalObservations.length }}）</summary>
        <AdvisoryRecords :records="historicalObservations" />
      </details>
      <div v-if="confirmed || data.auto_handoff || handoff.handoffId" class="ua-handoff" aria-label="处罚移送进度" :data-state="data.auto_handoff?.status">
        <p><span :class="`ua-${handoff.tone}`">{{ handoff.title }}</span><button v-if="handoff.handoffId" type="button" class="ua-link" @click="openHandoff">查看处罚交接</button></p>
        <p v-if="handoff.reason" class="ua-note">{{ userFacingMessage(handoff.reason) }}</p>
        <p v-if="handoff.partyUnidentified" class="ua-note">当事人不明：{{ handoff.partyReasons.join('；') || '没有可用的当事人信息' }}。移送时会写明按待补线索移送。</p>
        <button v-if="handoff.canSubmit" type="button" class="btn sm ua-submit" :disabled="!current" @click="submitHandoff">选择接收单位并移送</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.uav-advisory{margin:12px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-width:0}
.ua-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ua-head h3{font-size:16px;margin:0}
.ua-note{color:var(--muted);font-size:12px!important;line-height:1.6}.ua-error{font-size:13px;color:var(--red);line-height:1.6}
.ua-link{padding:0;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;white-space:normal}
.ua-handoff{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.ua-handoff p{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:13px;line-height:1.65;margin:0;overflow-wrap:anywhere}.ua-handoff .ua-note{margin-top:6px}
.ua-success{color:var(--green,#52d6a5)}.ua-warning{color:var(--amber,#ffc160)}.ua-muted{color:var(--txt)}
.ua-submit{margin-top:8px;white-space:normal;height:auto;min-height:30px}
.ua-history{margin-top:12px}.ua-history summary{cursor:pointer;font-size:13px;line-height:1.6}.ua-history summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
.uav-advisory button:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.uav-advisory button:disabled{opacity:.5;cursor:not-allowed}
</style>
