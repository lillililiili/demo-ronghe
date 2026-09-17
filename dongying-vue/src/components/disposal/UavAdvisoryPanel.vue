<script setup>
import { computed, onUnmounted } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { openFormModal } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';
import AdvisoryRecords from './AdvisoryRecords.vue';
import AutoSmsNotice from './AutoSmsNotice.vue';
import AutoVoiceNotice from './AutoVoiceNotice.vue';
import { autoSmsView } from './autoSmsView.js';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
import { advisoryProgress, advisoryActionView, lastObservation, OBSERVATION_DANGER, OBSERVATION_OUTCOME } from './advisoryView.js';

const props = defineProps({
  eventId: { type: String, required: true }, eventLabel: String, confirmed: Boolean,
  counterBlock: { type: String, default: '' }, counterStatus: { type: String, default: '' },
  authorizationId: { type: String, default: '' }, counterActive: Boolean,
  handoffId: { type: String, default: '' }, handoffBlock: { type: String, default: '' }
});
const emit = defineEmits(['updated', 'counter', 'punish']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, result => emit('updated', result));
let alive = true;
onUnmounted(() => { alive = false; });
const actionView = computed(() => advisoryActionView(data.value, props));
const observation = computed(() => lastObservation(data.value?.records));
const current = computed(() => data.value?.event_id === props.eventId && !loading.value && !error.value);
const writable = computed(() => current.value && props.confirmed && data.value?.can_write);
const counterReason = computed(() => props.counterBlock || data.value?.counter_block_reason || '先记录劝离后的现场情况与风险依据');
const mayCounter = computed(() => current.value && actionView.value.mayCounter);
const progress = computed(() => !props.confirmed ? autoSmsView(data.value).title
  : props.counterActive ? `反制进度：${props.counterStatus}` : advisoryProgress(data.value));
const primaryLabel = computed(() => ({ contact: '记录人工联系', observe: '补充现场情况', counter: '申请反制', authorization: '查看本次授权', punish: '移送处罚', handoff: '查看处罚交接' })[actionView.value.primary]);
const primaryDisabled = computed(() => {
  if (!current.value) return true;
  if (['contact', 'observe'].includes(actionView.value.primary)) return !writable.value;
  if (actionView.value.primary === 'counter') return !mayCounter.value;
  if (actionView.value.primary === 'punish') return !data.value?.can_handoff || !!props.handoffBlock;
  if (actionView.value.primary === 'authorization') return !props.authorizationId;
  return false;
});
function runPrimary() {
  if (primaryDisabled.value) return;
  const action = actionView.value.primary;
  if (action === 'contact') openAction('CONTACT_RECORDED');
  else if (action === 'observe') openAction('OBSERVATION');
  else if (action === 'authorization') openAuthorization();
  else if (action === 'handoff') openHandoff();
  else if (action === 'counter') emit('counter');
  else if (action === 'punish') emit('punish');
}
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';

function openAction(kind, urgent = false) {
  if (!writable.value) return;
  const id = props.eventId, version = data.value.event_version;
  const key = newHandoffIdempotencyKey();
  const observing = kind === 'OBSERVATION';
  const modal = openFormModal({
    title: observing ? (urgent ? '记录紧急处置依据' : '补充现场情况') : '补充人工联系记录',
    confirmText: observing ? '保存观察结果' : '保存联系记录',
    width: '600px',
    notice: observing ? '请结合当前轨迹、视频或现场核查填写；没有看到目标不等于已经飞离。' : '',
    warning: urgent ? '记录紧急事由后可申请反制，仍需按现有授权流程审批；此操作不启动设备。'
      : observing ? '' : '仅记录已经发生的电话、现场等联系情况，不生成短信送达或自动外呼回执。',
    fields: observing ? [
      { key: 'outcome', label: '目标现在的情况', type: 'select', required: true,
        options: Object.entries(OBSERVATION_OUTCOME).map(([value, label]) => ({ value, label })), disabled: urgent },
      { key: 'danger', label: '当前危险度', type: 'select', required: true,
        options: Object.entries(OBSERVATION_DANGER).map(([value, label]) => ({ value, label })), disabled: urgent },
      { key: 'note', label: urgent ? '紧急事由与适用预案依据' : '核查依据与现场说明', type: 'textarea', required: true,
        placeholder: urgent ? '说明紧急危险、为什么不能等待，以及适用预案依据' : '说明查看了什么轨迹、视频或现场反馈，以及得出结论的依据', minRows: 3 }
    ] : [
      { key: 'recipient_name', label: '联系对象', required: true, placeholder: '经核对的实际操控人或负责人' },
      { key: 'contact_basis', label: '联系依据', required: true, placeholder: '例如：通过飞行计划核对负责人，并电话联系' },
      { key: 'content', label: '联系内容与结果', type: 'textarea', required: true, minRows: 4 }
    ],
    initial: observing ? { outcome: urgent ? 'STILL_INSIDE' : null, danger: urgent ? 'HIGH' : null, note: '' }
      : { recipient_name: '', contact_basis: '', content: '' },
    validate: values => {
      const required = observing ? ['outcome', 'danger', 'note'] : ['recipient_name', 'contact_basis', 'content'];
      if (required.some(field => !String(values[field] || '').trim())) return '请将必填信息填写完整';
      if (observing && String(values.note).trim().length < (urgent ? 20 : 10)) return urgent ? '请用至少 20 个字说明紧急事由和预案依据' : '请用至少 10 个字说明核查依据';
      return null;
    },
    onSubmit: async values => {
      const current = () => alive && id === props.eventId && modal.isCurrent();
      if (!current()) throw new Error('已切换事件，请在当前事件中重新操作');
      const body = { expected_version: version, kind, ...values, ...(observing ? { urgent } : {}) };
      try {
        await uavAdvisoryApi.act(id, body, key);
        if (!current()) return;
        modal.close();
        toast('记录已保存', 'ok');
        await load();
      } catch (e) {
        if (!current()) return;
        if (e.code === 'VERSION_CONFLICT') {
          await load();
          throw new Error('这条事件已有新记录，请关闭弹窗，核对后重新填写。');
        }
        throw new Error(e.message || '提交结果尚未确认，请用当前表单重试或刷新记录核查。');
      }
    }
  });
}
function openAuthorization() {
  if (props.authorizationId) window.location.hash = `/punish?authorization=${encodeURIComponent(props.authorizationId)}`;
}
function openHandoff() {
  if (props.handoffId) window.location.hash = `/punish?handoff=${encodeURIComponent(props.handoffId)}`;
}
</script>

<template>
  <section v-if="confirmed || loading || error || data?.auto_sms || data?.auto_voice || data?.records?.length" class="uav-advisory" aria-label="飞手通知与处置进度">
    <header class="ua-head"><div><h3>处置进度</h3><p class="ua-note">{{ eventLabel }}</p><p v-if="confirmed && (counterActive || data?.records?.length)">{{ progress }}</p></div><button type="button" class="ua-link" :disabled="loading" @click="load()">{{ loading ? '正在读取' : error ? '重试' : '更新记录' }}</button></header>
    <p v-if="error" class="ua-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !data" class="ua-note">正在读取联系与观察记录</p>
    <template v-if="data">
      <AutoSmsNotice :data="data" :disabled="!current" @changed="load()" />
      <AutoVoiceNotice :data="data" :disabled="!current" @changed="load()" />
      <div class="ua-parallel-status" aria-label="现场与授权分别记录">
        <section aria-label="现场情况">
          <h4>现场情况</h4>
          <template v-if="observation">
            <p><b>{{ OBSERVATION_OUTCOME[observation.outcome] || '结果未知' }}</b> · 危险度{{ OBSERVATION_DANGER[observation.danger] || '待核查' }}</p>
            <p class="ua-note">记录时间：{{ time(observation.created_at) }}</p>
            <p v-if="actionView.needsObservation" class="ua-note">这条观察早于最近一次联系，需核对最新情况。</p>
          </template>
          <p v-else class="ua-note">尚无现场观察记录，无法确认是否飞离。</p>
        </section>
        <section aria-label="反制授权">
          <h4>反制授权</h4>
          <p v-if="counterStatus">{{ counterActive ? '本次' : '最近一次' }}授权：{{ counterStatus }}</p>
          <p v-else-if="counterBlock" class="ua-note">{{ counterBlock }}</p>
          <p v-else class="ua-note">尚无可查看的反制授权记录。</p>
          <p v-if="counterStatus && counterBlock" class="ua-note">{{ counterBlock }}</p>
          <button v-if="authorizationId && actionView.primary !== 'authorization'" type="button" class="ua-link" @click="openAuthorization">查看授权记录</button>
        </section>
      </div>
      <div v-if="confirmed" class="ua-stages">
        <section class="ua-stage is-current" aria-label="当前需要办理">
          <h4>需要你处理</h4>
          <div class="ua-actions">
            <button v-if="primaryLabel" type="button" class="btn" :class="actionView.primary === 'counter' ? 'danger' : 'pri'" :disabled="primaryDisabled" @click="runPrimary">{{ primaryLabel }}</button>
          </div>
          <template v-if="actionView.needsObservation">
            <p>本次联系后尚未补充现场情况。</p>
          </template>
          <p v-if="actionView.primary === 'observe'" class="ua-note">请结合轨迹、视频或现场反馈核查；失联时记录为结果不明。</p>
          <p v-if="!counterBlock && actionView.observation && !actionView.departed && !mayCounter && !counterActive" class="ua-note">{{ counterReason }}</p>
          <p v-if="!data.can_write && ['contact', 'observe'].includes(actionView.primary)" class="ua-note">当前账号可查看记录，没有联系与观察记录的办理权限。</p>
          <p v-if="actionView.primary === 'punish' && (!data.can_handoff || handoffBlock)" class="ua-note">{{ handoffBlock || '当前账号或事件状态不允许移送处罚。' }}</p>
          <button v-if="writable && !counterBlock && !counterActive && !actionView.departed && !mayCounter" type="button" class="ua-link ua-urgent" @click="openAction('OBSERVATION', true)">紧急情况：记录依据后申请</button>
        </section>
        <details :key="`${eventId}-${actionView.primary}`" class="ua-history ua-more">
          <summary>补充操作与事后移送</summary>
          <div class="ua-actions">
            <button v-if="actionView.primary !== 'observe'" type="button" class="btn" :disabled="!writable" @click="openAction('OBSERVATION')">{{ actionView.departed ? '补充或纠正现场情况' : '补充现场情况' }}</button>
            <template v-if="!actionView.departed">
              <button v-if="actionView.primary !== 'contact'" type="button" class="btn" :disabled="!writable" @click="openAction('CONTACT_RECORDED')">补充人工联系</button>
            </template>
            <button v-if="handoffId && actionView.primary !== 'handoff'" type="button" class="btn" @click="openHandoff">查看处罚交接</button>
            <button v-else-if="!handoffId && actionView.primary !== 'punish'" type="button" class="btn" :disabled="!current || !data.can_handoff || !!handoffBlock" @click="emit('punish')">移送处罚</button>
          </div>
          <p class="ua-note">{{ handoffBlock || '移送可独立办理，无需先完成反制；移送不等于已处罚。' }}</p>
        </details>
      </div>
      <details v-if="data.records?.length" class="ua-history"><summary>飞手通知与现场记录（{{ data.records.length }}）</summary><AdvisoryRecords :records="data.records" /></details>
    </template>
  </section>
</template>

<style scoped>
.ua-parallel-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:12px;margin-top:14px}.ua-parallel-status section{min-width:0;border-top:1px solid var(--line);padding-top:12px}.uav-advisory h4{font-size:13px;margin:0 0 8px}.ua-parallel-status p{font-size:13px;line-height:1.65;margin:7px 0;overflow-wrap:anywhere}
.uav-advisory{margin:12px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-width:0}.ua-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ua-head h3{font-size:16px;margin:0}.ua-head p{font-size:13px;color:var(--cyan);margin:7px 0 0}.ua-stages{margin-top:14px}.ua-stage{padding:14px 0;border-top:1px solid var(--line)}.ua-stage-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.ua-stage-title h4{font-size:14px;margin:0}.ua-number{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--line);border-radius:50%;color:var(--muted);font-variant-numeric:tabular-nums}.is-current .ua-number{color:var(--cyan);border-color:var(--cyan);background:rgba(34,211,238,.08)}.ua-stage.is-current>.ua-actions:first-child{margin:0 0 10px}.ua-stage p{font-size:13px;line-height:1.65;margin:8px 0;overflow-wrap:anywhere}.ua-note{color:var(--muted);font-size:12px!important;line-height:1.6}.ua-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.ua-actions .btn{white-space:normal;min-height:34px;line-height:1.4}.ua-error{font-size:13px;color:var(--red);line-height:1.6}.ua-link{padding:0;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.ua-more{padding-bottom:12px}.ua-urgent{margin-top:12px}.ua-history{padding-top:12px;border-top:1px solid var(--line)}.ua-history summary{font-size:13px;cursor:pointer}.uav-advisory button:focus-visible,.ua-history summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.uav-advisory button:disabled{opacity:.5;cursor:not-allowed}
</style>
