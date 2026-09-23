<script>
// 结果未知时保留同一提交键，关闭详情再打开也不产生重复通知。
const pendingNoticeKeys = new Map();
export default {};
</script>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { riskApi } from '@/services/riskApi.js';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { hasPermission, canAccessRoute } from '@/services/accessControl.js';
import { openRiskVerification } from '@/ui/riskVerificationModal.js';
import { openFormModal } from '@/ui/formModal.js';
import { closeModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { ALTITUDE_DATUM_LABEL, HANDOFF_TYPE_LABEL, REASON_CODE_LABEL,
  RECEIPT_RESULT_LABEL, RISK_STATE_LABEL, RISK_TYPE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, sourceDescription, labelOf } from '@/ui/labels.js';
import RiskOpticalPanel from '@/pages/flights/components/RiskOpticalPanel.vue';

const props = defineProps({ riskId: { type: String, required: true } });
const emit = defineEmits(['updated']);
const risk = ref(null), loading = ref(false), error = ref(''), tab = ref('event');
const history = ref([]), historyTotal = ref(0), historyPage = ref(1), historyLoading = ref(false), historyError = ref('');
const notices = ref([]), noticesTotal = ref(0), noticesLoading = ref(false), noticesError = ref('');
const historySize = 10;
let generation = 0, historyRequest = 0, noticeRequest = 0, alive = true;
const stateTags = { PENDING_VERIFICATION: 't-amber', PENDING_NOTIFICATION: 't-blue', NOTIFIED: 't-green', ACKNOWLEDGED: 't-green', EXCLUDED: 't-gray' };
const heightLabels = { UNKNOWN: '高度关系未知', WITHIN: '在航线高度范围内', OUTSIDE: '超出航线高度范围' };
const deliveryLabels = { PENDING_DELIVERY: '等待发送', SUBMITTED: '送达待确认', DELIVERED: '已送达', FAILED: '发送失败' };
const deliveryTags = { PENDING_DELIVERY: 't-amber', SUBMITTED: 't-blue', DELIVERED: 't-green', FAILED: 't-red' };
const receiptLabels = { NOT_EXPECTED: '不需回执', PENDING: '等待回执', ACKNOWLEDGED: '已回执', TIMEOUT: '回执超时' };
const submitted = computed(() => notices.value.find(item => item.delivery_status && item.delivery_status !== 'FAILED'));
const canVerify = computed(() => !loading.value && risk.value?.allowed_actions?.includes('VERIFY'));
// 沿用飞行计划的 NOTIFY / 旧接口待通知兼容；最终权限由服务端裁决。
const canNotify = computed(() => !loading.value && !noticesLoading.value && !noticesError.value && !submitted.value
  && (risk.value?.allowed_actions?.includes('NOTIFY') || risk.value?.state === 'PENDING_NOTIFICATION'));
const notifyReason = computed(() => submitted.value ? `已提交通知（${deliveryLabels[submitted.value.delivery_status] || '状态未知'} · ${receiptText(submitted.value)}），不能重复提交`
  : noticesLoading.value ? '正在读取通知记录' : noticesError.value ? '通知记录读取失败，请刷新核对后再提交'
    : risk.value?.state === 'PENDING_VERIFICATION' ? '人工核验通过后可通知上级'
    : canNotify.value ? '将风险情况通知上级，并等待对方回复处理结果' : '当前状态不允许通知');
const verifyReason = computed(() => canVerify.value
  ? risk.value.state === 'PENDING_NOTIFICATION' ? '将已确认的风险改判为排除，保留原核验记录' : '提交核验通过或排除结论'
  : '未授予核验权限，或当前风险状态不允许核验');
const icon = computed(() => risk.value?.risk_type === 'WEATHER' ? window.UI.icon('alert') : window.UI.targetIcon(risk.value));
const reasonText = computed(() => {
  let text = risk.value?.reason_text || '未提供';
  for (const value of [risk.value?.target_no, risk.value?.target_id, risk.value?.plan_no, risk.value?.plan_id, risk.value?.source_risk_id, risk.value?.risk_id]) {
    if (value) text = text.split(value).join('关联对象');
  }
  return text;
});
function time(value) { return value == null ? '未知' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function altitude(value) { return value?.observed_altitude_m == null ? '未知' : `${value.observed_altitude_m} 米（${labelOf(ALTITUDE_DATUM_LABEL, value.observed_altitude_datum, '基准未知')}）`; }
function receiptText(item) { return [receiptLabels[item.receipt_status] || '回执状态未知', labelOf(RECEIPT_RESULT_LABEL, item.receipt_result, '')].filter(Boolean).join(' · '); }
function message(e, fallback) { return e.status === 401 ? '登录已失效，请重新登录。' : e.status === 403 ? '当前账号没有查看或办理这项记录的权限。' : e.message || fallback; }
async function loadHistory(page = 1) {
  const token = ++historyRequest, id = props.riskId;
  historyLoading.value = true; historyError.value = '';
  try {
    const data = await riskApi.listRiskVerifications(id, { page, size: historySize });
    if (!alive || token !== historyRequest || id !== props.riskId) return;
    history.value = data.items || []; historyTotal.value = data.total || 0; historyPage.value = data.page || page;
  } catch (e) { if (alive && token === historyRequest) historyError.value = message(e, '核验历史读取失败'); }
  finally { if (alive && token === historyRequest) historyLoading.value = false; }
}
async function loadNotices() {
  const token = ++noticeRequest, id = props.riskId;
  noticesLoading.value = true; noticesError.value = '';
  try {
    const data = await handoffApi.listHandoffs({ source_kind: 'RISK', source_id: id, page: 1, size: 20 });
    if (!alive || token !== noticeRequest || id !== props.riskId) return;
    notices.value = data.items || []; noticesTotal.value = data.total || 0;
  } catch (e) { if (alive && token === noticeRequest) noticesError.value = message(e, '通知记录读取失败'); }
  finally { if (alive && token === noticeRequest) noticesLoading.value = false; }
}
async function load() {
  const token = ++generation, id = props.riskId;
  risk.value = null; error.value = ''; loading.value = true;
  try {
    const data = await riskApi.getRisk(id);
    if (!alive || token !== generation || id !== props.riskId) return null;
    risk.value = data;
    await Promise.all([loadHistory(), loadNotices()]);
    return data;
  } catch (e) { if (alive && token === generation) error.value = message(e, '风险详情读取失败'); return null; }
  finally { if (alive && token === generation) loading.value = false; }
}
async function refreshAfterAction(id) {
  const latest = await riskApi.getRisk(id);
  if (alive && id === props.riskId) {
    risk.value = latest;
    await Promise.all([loadHistory(), loadNotices()]);
    if (alive) emit('updated', latest);
  }
  return latest;
}
function verify() {
  if (!canVerify.value) return;
  const id = props.riskId;
  openRiskVerification({ risk: risk.value, refresh: () => refreshAfterAction(id) });
}
function notify() {
  if (!canNotify.value) return;
  const id = props.riskId, expectedVersion = Number(risk.value.version);
  if (!pendingNoticeKeys.has(id)) pendingNoticeKeys.set(id, newHandoffIdempotencyKey());
  openFormModal({
    title: '通知上级', width: '560px', fields: [], confirmText: '提交通知',
    warning: '提交后，请在通知记录中查看是否送达，并等待对方回复处理结果。对方回复“已驱离”后，本次风险通知流程完成。',
    onSubmit: async () => {
      let created;
      try {
        created = await handoffApi.createHandoff({ source_kind: 'RISK', source_id: id, handoff_type: 'RISK_NOTICE', expected_version: expectedVersion }, pendingNoticeKeys.get(id));
      } catch (e) {
        if (['HANDOFF_ALREADY_EXISTS', 'IDEMPOTENCY_REPLAY'].includes(e.code)) {
          pendingNoticeKeys.delete(id); closeModal(); tab.value = 'notice';
          await refreshAfterAction(id); toast('这条风险已有通知，请在通知与回执中核对。', 'err'); return;
        }
        if (['VERSION_CONFLICT', 'INVALID_TRANSITION', 'RECIPIENT_NOT_CONFIGURED', 'RECIPIENT_NOT_FOUND'].includes(e.code)) {
          pendingNoticeKeys.set(id, newHandoffIdempotencyKey()); await refreshAfterAction(id);
          throw new Error(`提交被拒绝，已刷新当前状态：${message(e, '请核对后重试')}`);
        }
        if (isUncertainOutcome(e)) {
          await refreshAfterAction(id);
          throw new Error(`提交结果未确认，请刷新核对：${message(e, '未返回明确结果')}`);
        }
        pendingNoticeKeys.delete(id); throw new Error(message(e, '提交通知失败'));
      }
      pendingNoticeKeys.delete(id); closeModal(); tab.value = 'notice';
      toast(created.delivery_status === 'DELIVERED' ? '通知已提交并送达，请查看通知与回执。' : '通知材料已保存，请在通知与回执中核对发送情况。', 'ok');
      try { await refreshAfterAction(id); } catch (e) { if (alive) noticesError.value = `通知已提交，但刷新失败：${message(e, '请刷新核对')}`; }
    }
  });
}
watch(() => props.riskId, () => { tab.value = 'event'; history.value = []; notices.value = []; load(); }, { immediate: true });
onUnmounted(() => { alive = false; generation++; historyRequest++; noticeRequest++; });
</script>

<template>
  <div class="risk-event-content">
    <div class="tabs workspace-detail-tabs" role="tablist" aria-label="风险详情与处理">
      <button class="tab" :class="{ on: tab === 'event' }" role="tab" :aria-selected="tab === 'event'" type="button" @click="tab = 'event'">风险详情</button>
      <button class="tab" :class="{ on: tab === 'notice' }" role="tab" :aria-selected="tab === 'notice'" type="button" @click="tab = 'notice'">通知与回执<span v-if="noticesTotal && !noticesLoading" class="tag t-gray">{{ noticesTotal }}</span></button>
    </div>
    <div class="rk-detail" :data-risk-id="riskId">
      <div v-if="loading" class="empty" role="status">正在读取风险详情与核验历史…</div>
      <div v-else-if="error" class="warnbox" role="alert">{{ error }}<button class="btn" type="button" @click="load">重试</button></div>
      <template v-else-if="risk">
        <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
          <div class="detail-hero-icon" v-html="icon"></div>
          <div class="detail-hero-copy"><div class="detail-hero-eyebrow">空域风险</div><div class="detail-hero-title">{{ labelOf(RISK_TYPE_LABEL, risk.risk_type, '风险类型未提供') }}</div><div v-if="risk.risk_no" class="detail-hero-id">{{ risk.risk_no }}</div></div>
          <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag" :class="SEVERITY_TAG[risk.severity] || 't-gray'">{{ labelOf(SEVERITY_LABEL, risk.severity, '未知') }}</span><span class="tag" :class="stateTags[risk.state] || 't-gray'">{{ labelOf(RISK_STATE_LABEL, risk.state, '未知') }}</span></div></div>
        </div></div>
        <template v-if="tab === 'event'">
          <RiskOpticalPanel v-if="risk.risk_type !== 'WEATHER'" :key="risk.risk_id" :risk="risk" />
          <section class="sect"><h4>事件信息</h4><dl class="kv kv-surface">
            <dt>来源</dt><dd>{{ sourceDescription(risk.source_name, risk.source_code, risk.source_mode) }}</dd>
            <dt>发生时间</dt><dd>{{ time(risk.occurred_at) }}</dd><dt>接收时间</dt><dd>{{ time(risk.received_at) }}</dd>
            <dt>所属范围</dt><dd>{{ risk.owner_org_name || '未知机构' }} / {{ risk.district_name || '未知区域' }}</dd>
          </dl></section>
          <section class="sect"><h4>风险依据</h4><dl class="kv kv-surface">
            <dt>触发原因</dt><dd>{{ labelOf(REASON_CODE_LABEL, risk.reason_code, '未提供') }}</dd><dt>依据说明</dt><dd>{{ reasonText }}</dd>
            <template v-if="risk.risk_type !== 'WEATHER'"><dt>测得高度</dt><dd>{{ altitude(risk) }}<span v-if="risk.observed_altitude_m == null" class="rk-hint">尚未测得高度，无法判断是否超高</span></dd><dt>高度关系</dt><dd>{{ labelOf(heightLabels, risk.height_relation, '高度关系未知') }}<span v-if="!risk.height_relation || risk.height_relation === 'UNKNOWN'" class="rk-hint">缺高度或 AGL/AMSL 换算依据</span></dd></template>
            <dt>关联计划</dt><dd><a v-if="risk.plan_id && hasPermission('flight:read') && canAccessRoute('flights')" class="btn ghost" :href="`#/flights?plan=${encodeURIComponent(risk.plan_id)}`">查看关联飞行计划 →</a><span v-else>{{ risk.plan_id ? '已关联' : '没有可查看的相关记录' }}</span></dd>
            <dt>航线版本</dt><dd :title="risk.route_version_id">{{ risk.route_version_id ? '已关联' : '没有可查看的相关记录' }}</dd>
            <dt v-if="risk.assessment_id">关联研判</dt><dd v-if="risk.assessment_id">已关联研判记录</dd>
            <dt v-if="risk.target_id">关联目标</dt><dd v-if="risk.target_id">{{ risk.space_fact?.subtype_name || '关联感知目标' }}</dd>
            <dt v-if="risk.track_id">关联轨迹</dt><dd v-if="risk.track_id">已关联轨迹</dd>
          </dl><p class="rk-note">{{ risk.risk_type === 'WEATHER' ? '起飞前请核对最新预警和有效时段。' : '位置为发现时快照；违规结论见合法性研判。' }}</p></section>
          <section class="sect"><h4>核验历史 <span class="tag t-gray">{{ historyTotal }}</span></h4>
            <div v-if="historyLoading" class="empty">正在读取核验历史…</div>
            <div v-else-if="historyError" class="warnbox" role="alert">{{ historyError }}<button class="btn" type="button" @click="loadHistory(historyPage)">重试</button></div>
            <div v-else-if="!history.length" class="empty">尚无已保存的核验记录</div>
            <div v-else class="rk-history"><article v-for="item in history" :key="item.history_id" class="rk-history-item">
              <div class="rk-history-head"><span class="tag" :class="item.conclusion === 'EXCLUDED' ? 't-gray' : 't-green'">{{ item.conclusion === 'EXCLUDED' ? '排除' : item.conclusion === 'CONFIRMED' ? '核验通过' : item.conclusion }}</span><span class="rk-sub">{{ labelOf(RISK_STATE_LABEL, item.previous_state) }} → {{ labelOf(RISK_STATE_LABEL, item.resulting_state) }}</span></div>
              <div>{{ item.note }}</div><div class="rk-sub">{{ time(item.created_at) }} · 操作人 {{ item.actor_name || '操作人员' }}</div>
            </article></div>
            <div v-if="historyTotal > historySize" class="history-pager"><button class="btn ghost" :disabled="historyLoading || historyPage <= 1" @click="loadHistory(historyPage - 1)">上一页</button><span>第 {{ historyPage }} / {{ Math.ceil(historyTotal / historySize) }} 页</span><button class="btn ghost" :disabled="historyLoading || historyPage * historySize >= historyTotal" @click="loadHistory(historyPage + 1)">下一页</button></div>
          </section>
        </template>
        <section v-else class="sect notice-section">
          <div class="workspace-section-heading"><button class="btn ghost" :disabled="noticesLoading" @click="loadNotices">刷新记录</button></div>
          <div v-if="noticesError" class="warnbox" role="alert">{{ noticesError }}</div><div v-else-if="noticesLoading" class="empty">正在读取通知记录…</div><div v-else-if="!notices.length" class="empty">这条风险尚无通知记录。</div>
          <div v-else class="rk-history"><article v-for="notice in notices" :key="notice.handoff_id" class="rk-history-item">
            <div class="rk-history-head"><b>通知上级</b><span class="tag" :class="deliveryTags[notice.delivery_status] || 't-gray'">{{ deliveryLabels[notice.delivery_status] || '发送状态未知' }}</span></div>
            <details v-if="notice.recipient_name && notice.recipient_name !== '上级'"><summary>原通知对象记录</summary><p>{{ notice.recipient_name }}</p></details>
            <p>{{ labelOf(HANDOFF_TYPE_LABEL, notice.handoff_type) }} · {{ time(notice.created_at) }}</p><p>对方回复：{{ receiptText(notice) }}</p>
            <p v-if="notice.blocked_reason">未完成原因：{{ notice.blocked_reason === 'CHANNEL_NOT_CONNECTED' ? '通知渠道未接通' : notice.blocked_reason }}</p>
            <p class="rk-note">风险通知记录留在本页，不进入处罚办理。</p>
          </article></div>
          <p v-if="noticesTotal > notices.length && !noticesLoading" class="rk-note">共 {{ noticesTotal }} 条通知记录，当前展示最近 {{ notices.length }} 条。</p>
        </section>
      </template>
    </div>
    <div v-if="risk && !loading && !error && tab === 'event' && (canVerify || canNotify || ['PENDING_VERIFICATION', 'PENDING_NOTIFICATION'].includes(risk.state))" class="risk-process-actions">
      <p v-if="risk.state === 'PENDING_VERIFICATION' && !canVerify">{{ verifyReason }}</p><p v-else-if="risk.state === 'PENDING_NOTIFICATION' && !canNotify">{{ notifyReason }}</p>
      <p v-if="risk.state === 'PENDING_VERIFICATION' && canVerify">核验通过后可通知上级。</p>
      <button v-if="risk.state === 'PENDING_VERIFICATION' || (risk.state === 'PENDING_NOTIFICATION' && canVerify)" class="btn" :class="{ pri: risk.state === 'PENDING_VERIFICATION', ghost: risk.state === 'PENDING_NOTIFICATION' }" :disabled="!canVerify" :title="verifyReason" @click="verify">{{ risk.state === 'PENDING_NOTIFICATION' ? '改判为排除' : '人工核验' }}</button>
      <button v-if="risk.state === 'PENDING_NOTIFICATION' || canNotify" class="btn" :class="{ pri: canNotify }" :disabled="!canNotify" :title="notifyReason" @click="notify">通知上级</button>
    </div>
  </div>
</template>

<style scoped>
.risk-event-content { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.workspace-detail-tabs { flex: none; padding: 0 10px; }.workspace-detail-tabs .tab { font-size: 12px; padding: 9px 8px; }.workspace-detail-tabs .tag { margin-left: 5px; }
.rk-detail { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.rk-detail .detail-hero-title, .rk-detail .detail-hero-id { display: block; overflow: visible; white-space: normal; text-overflow: unset; -webkit-line-clamp: unset; overflow-wrap: anywhere; }
.kv { grid-template-columns: minmax(70px, auto) minmax(0, 1fr); }.kv dd { min-width: 0; overflow-wrap: anywhere; }
.metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }.metric-copy b { overflow-wrap: anywhere; }
.workspace-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.rk-hint,.rk-note,.rk-sub { color: var(--txt-3); font-size: 11px; line-height: 1.6; }.rk-hint { display: block; }.rk-note { margin: 8px 0; }
.rk-history { display: grid; gap: 8px; margin-top: 8px; }.rk-history-item { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
.rk-history-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }.rk-history-item p { margin: 0; color: var(--txt-3); line-height: 1.6; }
.history-pager { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; }
.risk-process-actions { flex: none; padding: 10px 12px; border-top: 1px solid var(--line); display: flex; gap: 8px; flex-wrap: wrap; }.risk-process-actions p { flex-basis: 100%; margin: 0; color: var(--txt-3); font-size: 12px; line-height: 1.6; }
</style>
