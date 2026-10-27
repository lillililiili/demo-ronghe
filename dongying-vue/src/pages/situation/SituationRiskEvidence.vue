<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import SituationRiskProcess from './SituationRiskProcess.vue';
import { emptyRiskContext, evidenceSignature, evidenceDisplay, itemKey, loadRiskEvidence, loadRiskStatus, loadRiskProgress, hasCurrentRiskTarget, riskEvidenceContext, riskEvidenceView } from './riskEvidence.js';
import { ALARM_PROGRESS_LABEL, RISK_STATE_LABEL, ALTITUDE_BAND_LABEL, OBJECT_TREND_LABEL } from '@/ui/labels.js';

const props = defineProps({ item: { type: Object, required: true }, targets: { type: Array, default: () => [] },
  flightPlans: { type: Array, default: () => [] }, predictions: { type: Array, default: () => [] } });
const emit = defineEmits(['context', 'updated', 'locate', 'status']);
const router = useRouter();
const data = ref(null), error = ref(''), loading = ref(false), expanded = ref(false);
const selectedItem=ref(props.item), statusError=ref('');
const statusKnown=ref(false);
let generation = 0, alive = true, statusGeneration=0, statusBusy=false, timer=null;
const view = computed(() => data.value ? riskEvidenceView(data.value) : { reasons: [props.item.reason_text || '正在读取风险原因'], rows: [], checks: [], keyEvidence: [] });
const labels = { ...ALARM_PROGRESS_LABEL, ...RISK_STATE_LABEL, ...ALTITUDE_BAND_LABEL, ...OBJECT_TREND_LABEL,
  PREDICTED: '预测预警', OBSERVED: '实测风险', UNKNOWN: '依据不足', CLEARED: '已解除', ENDED: '已结束',
  CONFIRMED: '告警已确认', FALSE_POSITIVE: '误报', FRESH: '当前观测有效', STALE: '观测已过期', HISTORY: '历史事件',
  CURRENT: '当前有效', ACTIVE: '当前有效', WITHDRAWN: '预测已撤销', ENTERED: '已实测入区',
  PENDING: '待处理', NONE: '尚无', RUNNING: '执行中', STOPPED: '已停止' };
const display = value => labels[value] || evidenceDisplay(value);
const notices = computed(() => data.value?.notices || []);
const uav = computed(() => props.item.kind === 'UAV');
const canLocate = computed(() => {
  if (!data.value || loading.value || error.value || statusError.value || !statusKnown.value || selectedItem.value.current_status!=='CURRENT') return false;
  const context = riskEvidenceContext(data.value);
  return !!(context.airspaces.length || context.flightPlans.length || context.points.length || context.polygons.length || hasCurrentRiskTarget(selectedItem.value,props.targets));
});
const disposalLink = computed(() => ({ path: '/alarms', query: props.item.risk_case_id
  ? { risk_case: props.item.risk_case_id } : { event: data.value?.event?.event_id || props.item.event_id } }));
async function load({ changed = false } = {}) {
  const token = ++generation, key = itemKey(selectedItem.value), selected = selectedItem.value;
  loading.value = true; error.value = '';
  if (changed || !data.value) emit('context', emptyRiskContext(selected));
  try {
    const detail = await loadRiskEvidence(selected);
    if (!alive || token !== generation || key !== itemKey(props.item)) return;
    data.value = detail;
    if (!statusKnown.value || selected.current_status!=='CURRENT') {
      statusError.value=selected.presence_reason || '本事项当前已不生效';
      emit('context',{...emptyRiskContext(selected),notice:statusError.value});
    } else emit('context', riskEvidenceContext(detail));
  } catch (reason) {
    if (!alive || token !== generation) return;
    data.value = null;
    error.value = reason?.status === 403 ? '当前账号没有查看本事件依据的权限。' : reason?.message || '风险依据读取失败，请重试。';
    emit('context', { ...emptyRiskContext(selected), notice: error.value });
  } finally { if (alive && token === generation) loading.value = false; }
}
function updated() { emit('updated'); refreshStatus({force:true}); }
async function refreshStatus({force=false}={}) {
  if (!alive || statusBusy || loading.value || document.visibilityState==='hidden') return;
  const token=++statusGeneration, selected=selectedItem.value, key=itemKey(selected);
  statusBusy=true;
  try {
    const latest=await loadRiskStatus(selected);
    if (!alive || token!==statusGeneration || key!==itemKey(selectedItem.value)) return;
    const progress=await loadRiskProgress(latest.item);
    if (!alive || token!==statusGeneration || key!==itemKey(selectedItem.value)) return;
    const changed=evidenceSignature(latest.item)!==evidenceSignature(selected);
    selectedItem.value=latest.item; statusKnown.value=true; statusError.value=''; emit('status',latest.item);
    if (changed || force || !data.value) await load({changed});
    else {
      data.value={...data.value,...latest,item:latest.item};
      if(progress && data.value.riskCase)data.value={...data.value,riskCase:{...data.value.riskCase,...progress}};
      if (latest.item.current_status!=='CURRENT') emit('context',{...emptyRiskContext(latest.item),notice:latest.item.presence_reason || '本事项当前已不生效'});
      else emit('context',riskEvidenceContext(data.value));
    }
    if (!alive || token!==statusGeneration || key!==itemKey(selectedItem.value)) return;
    if(progress && data.value?.riskCase)data.value={...data.value,riskCase:{...data.value.riskCase,...progress}};
    if (latest.item.current_status!=='CURRENT') { statusError.value=latest.item.presence_reason || '本事项当前已不生效'; emit('context',{...emptyRiskContext(latest.item),notice:statusError.value}); }
  } catch(reason) {
    if (!alive || token!==statusGeneration || key!==itemKey(selectedItem.value)) return;
    statusError.value=reason?.status===403 ? '当前状态无查看权限' : reason?.status===404 ? '当前事项已不可用' : '当前状态暂不可用，请稍后重试';
    selectedItem.value={...selectedItem.value,current_status:'UNKNOWN',presence_reason:statusError.value};
    if(data.value)data.value={...data.value,item:selectedItem.value};
    emit('status',selectedItem.value);
    emit('context',{...emptyRiskContext(selectedItem.value),notice:statusError.value});
  } finally { if (token===statusGeneration) statusBusy=false; }
}
function schedule() { timer=setTimeout(async()=>{ await refreshStatus(); if(alive)schedule(); },5000); }
function visible() { if(document.visibilityState!=='hidden')refreshStatus(); }
watch(() => itemKey(props.item), () => {
  generation++; loading.value=false; statusGeneration++; statusBusy=false; statusKnown.value=false; selectedItem.value=props.item; data.value=null; expanded.value=false; statusError.value='';
  emit('context',emptyRiskContext(props.item)); refreshStatus({force:true});
}, {immediate:true});
onMounted(()=>{ schedule(); document.addEventListener('visibilitychange',visible); });
onUnmounted(() => { alive=false; generation++; statusGeneration++; clearTimeout(timer); document.removeEventListener('visibilitychange',visible); });
</script>

<template>
  <section class="risk-evidence" :data-item-key="itemKey(item)" aria-label="风险详情与判定依据" :aria-busy="loading">
    <header><h3>{{ { UAV: '无人机风险', SPACE_OBJECT: '鸟类与异物风险', WEATHER: '气象风险' }[item.kind] || '风险详情' }}</h3>
      <button type="button" class="btn ghost" :disabled="loading || statusBusy" @click="refreshStatus({force:true})">刷新依据</button></header>
    <div class="risk-reasons" aria-label="完整风险原因"><b>{{ uav ? '本目标完整风险原因' : '为什么产生风险' }}</b>
      <ul><li v-for="reason in view.reasons" :key="reason">{{ reason }}</li></ul>
      <p v-if="uav && (item.area_id || data?.riskCase?.airspace_id)">本事项办理范围：{{ data?.riskCase?.airspace_name || item.area_name || '当前选中空域' }}。地图及下方空域判定仅展示本范围。</p>
    </div>
    <p v-if="error" class="evidence-error" role="alert">{{ error }}</p>
    <p v-if="statusError" class="evidence-error" role="alert">{{ statusError }}。下方保留上次可读取的历史依据，不能代表当前状态。</p>
    <p v-else-if="loading" role="status">正在核对最新事件依据…</p>
    <template v-if="data && !error">
      <div v-if="view.keyEvidence.length" class="key-evidence" aria-label="关键判定实值"><article v-for="(evidence,index) in view.keyEvidence" :key="index">
        <b>{{ evidence.title }}</b><p>{{ evidence.text || '详细数值暂不可用' }}</p><small>依据时刻：{{ evidence.time }}</small>
      </article></div>
      <dl><template v-for="([label, value],index) in view.rows" :key="`${label}:${index}`"><dt>{{ label }}</dt><dd>{{ display(value) }}</dd></template></dl>
      <p v-if="uav && data.riskCase?.manual_counter_only" class="evidence-notice">预测及其衍生风险保持人工核实、人工反制；预测不能作为处罚依据。</p>
      <p v-for="notice in notices" :key="notice" class="evidence-notice" role="status">{{ notice }}</p>
      <div class="evidence-actions"><button type="button" class="btn ghost" :disabled="!canLocate"
        :title="canLocate ? '定位本事件依据' : '缺少有效几何依据，无法定位'" @click="emit('locate', item)">定位事件依据</button>
        <button v-if="uav && (item.risk_case_id || item.event_id || data.event?.event_id)" type="button" class="btn"
          @click="router.push(disposalLink)">查看处置与停止入口</button>
      </div>
      <p v-if="!canLocate && !loading" class="evidence-notice">位置或范围暂不可用，无法定位。</p>
      <details :open="expanded" @toggle="expanded = $event.target.open"><summary>判定事实明细{{ view.checks.length ? `（${view.checks.length}）` : '' }}</summary>
        <p v-if="!view.checks.length">{{ uav ? '报警时的详细判定依据暂不可用。' : '本次判定事实见上方。' }}</p>
        <article v-for="(check, index) in view.checks" :key="index"><b>{{ check.title }}</b><p>{{ check.message }}</p>
          <dl><template v-for="[label, value] in check.rows" :key="label"><dt>{{ label }}</dt><dd>{{ display(value) }}</dd></template></dl>
          <p v-for="param in check.params" :key="param">当时参数：{{ param }}</p>
        </article>
      </details>
      <SituationRiskProcess v-if="!uav && selectedItem.risk_id && statusKnown && selectedItem.current_status==='CURRENT' && !statusError" :key="selectedItem.risk_id" :risk-id="selectedItem.risk_id" :revision="Number(data.risk?.version || 0)" @updated="updated" />
    </template>
  </section>
</template>

<style scoped>
.risk-evidence{padding:12px;min-width:0;font-size:12px;line-height:1.6;color:var(--txt-2);overflow-wrap:anywhere}
header{display:flex;align-items:center;justify-content:space-between;gap:8px}h3{margin:0;color:var(--txt);font-size:14px}
.risk-reasons{margin:12px 0;padding:10px;border-left:3px solid var(--amber);background:var(--surface-2);color:var(--txt)}
.risk-reasons>b{color:var(--amber)}ul{padding-left:18px;margin:6px 0 0}li+li{margin-top:5px}
dl{display:grid;grid-template-columns:84px minmax(0,1fr);gap:7px 10px;margin:12px 0}dt{color:var(--txt-3)}dd{margin:0;color:var(--txt)}
p{margin:8px 0}.evidence-error{color:var(--red)}.evidence-notice{padding:8px;border:1px solid var(--line);border-radius:5px}
.evidence-actions{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.btn{min-height:32px;white-space:normal}.btn:focus-visible,summary:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
details{border-top:1px solid var(--line);padding-top:10px}summary{cursor:pointer;color:var(--txt)}article{padding:10px 0;border-bottom:1px solid var(--line)}
</style>
