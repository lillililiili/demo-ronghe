<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { NModal } from 'naive-ui';
import { UField, UFormFooter } from '@/components/form/index.js';
import { eoWorkspaceApi } from '@/services/eoWorkspaceApi.js';
import { deviceApi, newIdempotencyKey } from '@/services/deviceApi.js';
import { disposalApi } from '@/services/disposalApi.js';
import { authSession, authUser } from '@/services/auth.js';
import { deviceOptions } from '@/ui/disposalAuthModal.js';
import { COUNTERMEASURE_MODE_LABEL, disposalStatusText } from '@/ui/labels.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
const props=defineProps({selected:{type:Array,default:()=>[]}, focusedId:String});
const emit=defineEmits(['updated']);
const identity=row=>row.riskCaseId?`risk:${row.riskCaseId}`:row.risk_case_id?`risk:${row.risk_case_id}`:`event:${row.eventId || row.event_id}`;
const signature=()=>props.selected.map(r=>`${identity(r)}:${r.eventId}:${r.riskCaseVersion ?? ''}`).join('|');
const requestIdentity=row=>({event_id:row.eventId,...(row.riskCaseId?{risk_case_id:row.riskCaseId,expected_case_version:row.riskCaseVersion}:{})});
const checks=ref({}), results=ref({}), progress=ref({}), error=ref(''), busy=ref(false), loading=ref(false), dialog=ref(''), drafts=ref([]), formError=ref(''), devices=ref([]), policyText=ref('');
const opening=ref(false);
let alive=true, generation=0, timer;
const storageKey=()=>`eo-batch-pending:${authUser.value?.user_id || 'unknown'}`;
function pending(actor=storageKey()) { try { const value=JSON.parse(sessionStorage.getItem(actor) || '{}');return value && typeof value==='object' && !Array.isArray(value)?value:null; } catch { return null; } }
function savePending(value) { sessionStorage.setItem(storageKey(),JSON.stringify(value)); }
function isPending(kind,id) { const value=pending();return !value || Object.keys(value).some(key=>key.startsWith(`${kind}:`) && !key.startsWith(`${kind}:risk:`)) || !!value[`${kind}:${id}`] || (id.startsWith('risk:') && props.selected.some(r=>identity(r)===id && value[`${kind}:${r.eventId}`])); }
const legacyPending=computed(()=>Object.keys(pending() || {}).filter(key=>/^(verify|counter):/.test(key) && !/^(verify|counter):risk:/.test(key)));
const rows=computed(()=>props.selected.map(row=>({...row,check:checks.value[identity(row)],result:results.value[identity(row)]})));
const verifyRows=computed(()=>rows.value.filter(row=>!row.unavailable && row.check?.status==='READY' && row.check.allowed_conclusions?.length && !isPending('verify',identity(row))));
const counterRows=computed(()=>rows.value.filter(row=>!row.unavailable && row.check?.status==='READY' && (row.check.counter?.can_direct || row.check.counter?.can_request) && !isPending('counter',identity(row))));
function block(row,kind) {
  if(isPending(kind,identity(row))) return '上次提交结果待核对，请查看告警处置记录';
  if(row.unavailable) return '当前观测或告警关联已变化，请重新选择';
  if(!row.check) return error.value || '正在读取办理条件';
  if(row.check.status!=='READY') return row.check.error?.message || '无法读取办理条件';
  return kind==='verify' ? row.check.verification_block_reason || '当前事件无需核实' : row.check.counter?.block_reason || '当前不可反制';
}
async function refresh() {
  clearTimeout(timer);
  if(!alive || busy.value) return;
  const selected=props.selected.slice(), ids=selected.map(identity), token=++generation;
  if(!ids.length) { checks.value={}; return; }
  loading.value=true;
  try {
    const value=await eoWorkspaceApi.precheck(selected);
    if(!alive || token!==generation) return;
    if(!Array.isArray(value?.items) || value.items.length!==ids.length || new Set(value.items.map(identity)).size!==ids.length || value.items.some(row=>!ids.includes(identity(row)))) throw new Error('批量办理条件不完整，请重读');
    checks.value=Object.fromEntries(value.items.map(row=>[identity(row),row])); error.value='';
    await Promise.all(ids.map(async id=>{
      const authorizationId=results.value[id]?.data?.authorization_id;
      if(!authorizationId)return;
      try {
        const detail=await disposalApi.detail(authorizationId);
        if(alive && token===generation && detail?.authorization_id===authorizationId && detail.subject_kind==='UAV_EVENT' && detail.subject_id===selected.find(row=>identity(row)===id)?.eventId && (!selected.find(row=>identity(row)===id)?.riskCaseId || detail.risk_case_id===selected.find(row=>identity(row)===id)?.riskCaseId)) progress.value={...progress.value,[id]:disposalStatusText(detail)};
      } catch { if(alive && token===generation)progress.value={...progress.value,[id]:'当前进度读取失败，请查看处置记录'}; }
    }));
  } catch(cause) { if(alive && token===generation) { checks.value={};error.value=cause.message || '办理条件读取失败'; } }
  finally { if(alive && token===generation) {loading.value=false;timer=setTimeout(refresh,5000);} }
}
watch([()=>signature(),authSession],()=>{++generation;checks.value={};dialog.value='';refresh();},{immediate:true});
watch(authSession,()=>{results.value={};progress.value={};});
// Availability changes do not change the user's selection or discard a draft for another event.
// The opening precheck and submit guards still exclude each unavailable event individually.
watch(()=>props.selected.map(r=>`${identity(r)}:${!!r.unavailable}`).join('|'),()=>{
  if(!opening.value && !dialog.value) refresh();
});
onUnmounted(()=>{alive=false;++generation;clearTimeout(timer);});
async function open(kind) {
  if(opening.value || busy.value) return;
  opening.value=true;
  error.value='';
  const originalSession=authSession.value,originalIds=signature();
  try {
  await refresh();
  if(!alive) return;
  if(originalSession!==authSession.value || originalIds!==signature()) {
    error.value='账号或所选告警已变化，请重新读取办理条件后操作。';return;
  }
  const eligible=kind==='verify'?verifyRows.value:counterRows.value;
  if(!eligible.length) {
    error.value=error.value || rows.value.map(row=>`${row.label}：${block(row,kind)}`).join('；') || '当前没有满足办理条件的告警，请重新选择。';
    return;
  }
  formError.value='';
  drafts.value=eligible.map(row=>({...row,expected_version:row.check.event.version,expected_case_version:row.check.case_version,prediction_id:row.check.prediction_id,conclusion:'',note:'',mode:row.check.counter?.can_direct?'DIRECT':'REQUEST',channel:'COUNTERMEASURE_4CH',device_id:null,countermeasure_mode:'FORCE_LAND',reason:''}));
  if(kind==='counter') {
    loading.value=true;
    try {
      const session=authSession.value, ids=signature();
      const all=[], seen=new Set();
      for(let page=1;page<=100;page++) {
        const value=await deviceApi.list({page,size:200,enabled:true,sort:'device_no_asc'});
        if(!Array.isArray(value?.items)) throw new Error('执行设备列表不完整');
        let added=0;
        for(const d of value.items) if(d.device_id && !seen.has(d.device_id)){seen.add(d.device_id);all.push(d);added++;}
        if(all.length>=value.total || value.items.length<200) break;
        if(!added || page===100) throw new Error('执行设备列表未读取完整，请重试');
      }
      // 策略说明只是展示；没有处置读取权限不缩减已有申请/直接反制资格。
      const policy=await disposalApi.policies().catch(()=>null);
      if(!alive) return;
      if(session!==authSession.value || ids!==signature()) {
        error.value='账号或所选告警已变化，请重新读取办理条件后操作。';return;
      }
      devices.value=all;
      const current=Array.isArray(policy)?policy[0]:policy;
      const minutes=(current?.params || current)?.time_limit_min?.COUNTERMEASURE;
      policyText.value=minutes?`授权有效时长 ${minutes} 分钟；以实际设备回执为准。`:'以当前授权策略和实际设备回执为准。';
    } catch(cause) {error.value=cause.message || '读取执行设备失败';return;}
    finally{loading.value=false;}
  }
  dialog.value=kind;
  } finally {opening.value=false;}
}
function options(row) {return deviceOptions(devices.value,row.channel,Number.isFinite(row.lon)&&Number.isFinite(row.lat)?{lon:row.lon,lat:row.lat}:null);}
function unify(conclusion) { for(const row of drafts.value) row.conclusion=row.check.allowed_conclusions.includes(conclusion)?conclusion:''; }
function resultText(result) {
  if(!result) return '';
  if(result.status==='UNKNOWN') return '结果未知，请核对记录';
  if(result.status!=='SUCCEEDED') return result.error?.message || '本项未受理';
  return result.data?.authorization_id ? disposalStatusText(result.data) || '已受理，等待设备回执' : result.data?.state==='FALSE_POSITIVE'?'已核实为误报':'核实已提交';
}
async function submit() {
  if(busy.value || !dialog.value) return;
  const kind=dialog.value;
  for(const row of drafts.value) {
    if(!props.selected.some(r=>identity(r)===identity(row) && !r.unavailable)) {formError.value='目标关联已变化，请关闭后重新读取';return;}
    if(kind==='verify' && !row.check.allowed_conclusions.includes(row.conclusion)) {formError.value=`${row.label}：请明确选择核实结论`;return;}
    if(kind==='counter' && !options(row).some(o=>o.value===row.device_id && !o.disabled)) {formError.value=`${row.label}：请选择可用执行设备`;return;}
    if(!props.selected.some(r=>identity(r)===identity(row) && r.eventId===row.eventId && r.riskCaseVersion===row.riskCaseVersion)){formError.value='风险办理版本已变化，请关闭后重新读取';return;}
    const note=(kind==='verify'?row.note:row.reason).trim();
    if(kind==='verify'?note.length>1000:note.length>500 || note.length===1) {formError.value=`${row.label}：说明长度不符合要求`;return;}
  }
  const session=authSession.value, actor=storageKey(), saved=pending();
  if(!saved){formError.value='无法读取上次提交标识，未提交；请先核对处置记录';return;}
  if(drafts.value.some(row=>isPending(kind,identity(row)))){formError.value='上次提交仍待核对，请查看告警处置记录';return;}
  const items=drafts.value.map(row=>{
    const key=`${kind}:${identity(row)}`;
    const idempotency_key=newIdempotencyKey(`eo-batch-${kind}`);
    saved[key]={idempotency_key,at:Date.now()};
    const association={...requestIdentity(row),...(row.riskCaseId?{expected_case_version:row.expected_case_version}:{})};
    return kind==='verify'?{...association,...(row.prediction_id?{prediction_id:row.prediction_id}:{}),expected_version:row.expected_version,conclusion:row.conclusion,note:row.note.trim(),idempotency_key}
      :{...association,expected_version:row.expected_version,mode:row.mode,idempotency_key,request:{action_type:'COUNTERMEASURE',subject_kind:'UAV_EVENT',subject_id:row.eventId,device_id:row.device_id,channel:row.channel,reason:row.reason.trim(),countermeasure_mode:row.countermeasure_mode}};
  });
  try {savePending(saved);} catch {formError.value='无法保存提交标识，未提交；请检查浏览器存储';return;}
  busy.value=true;clearTimeout(timer);formError.value='';
  let value;
  try {
    value=await eoWorkspaceApi[kind](items);
    if(!Array.isArray(value?.items) || value.items.length!==items.length || new Set(value.items.map(identity)).size!==items.length || value.items.some(row=>!items.some(i=>identity(i)===identity(row)) || !['SUCCEEDED','FAILED','UNKNOWN'].includes(row.status))) throw new Error('未取得完整提交结果，请核对记录');
  } catch(cause) {
    const uncertain=isUncertainOutcome(cause) || !cause.status || cause.status>=500;
    value={items:items.map(item=>({...item,status:uncertain?'UNKNOWN':'FAILED',error:{message:cause.message || '未取得提交结果'}}))};
  }
  try {
    const stored=pending(actor);
    if(!stored)throw new Error('storage');
    for(const row of value.items) {
      if(row.status!=='UNKNOWN' && row.error?.code!=='IDEMPOTENCY_REPLAY') delete stored[`${kind}:${identity(row)}`];
    }
    sessionStorage.setItem(actor,JSON.stringify(stored));
  } catch { if(alive && session===authSession.value)error.value='办理结果已返回，但本地提交标识未更新，请先核对处置记录'; }
  if(alive && session===authSession.value) {
    results.value={...results.value,...Object.fromEntries(value.items.map(row=>[identity(row),row]))};
    dialog.value='';busy.value=false;emit('updated');await refresh();
  } else busy.value=false;
}
</script>
<template>
  <section class="eo-batch-actions" aria-label="告警办理">
    <p v-if="error" role="alert">{{error}}</p>
    <p v-if="legacyPending.length" role="alert">有 {{legacyPending.length}} 项旧版提交结果待核对，暂不继续同类提交；请在告警处置记录核对，旧标识不会自动关联到新风险。</p>
    <p v-if="!selected.length">在地图或 AI 画面中选择告警无人机后办理，最多 20 项风险。</p>
    <template v-else>
      <p>核实与反制分别提交</p>
      <p v-if="opening" role="status">正在重新核对所选告警的办理条件…</p>
      <button type="button" class="eo-primary" :disabled="busy||loading||opening||!verifyRows.length" @click="open('verify')">{{selected.length>1?'批量核实':'核实'}}（{{verifyRows.length}}）</button>
      <button type="button" class="eo-counter" :disabled="busy||loading||opening||!counterRows.length" @click="open('counter')">{{selected.length>1?'批量反制':'发起反制'}}（{{counterRows.length}}）</button>
      <div class="eo-result-list" aria-live="polite">
        <div v-for="row in rows" :key="identity(row)">
          <b>{{row.label}}<template v-if="row.airspaceName"> · {{row.airspaceName}}</template></b>
          <span v-if="row.result" :class="{'error':row.result.status!=='SUCCEEDED'}">{{resultText(row.result)}}</span>
          <span v-if="progress[identity(row)]">当前进度：{{progress[identity(row)]}}</span>
          <span v-if="!verifyRows.some(r=>identity(r)===identity(row)) && row.check?.event?.state==='PENDING_VERIFICATION'">核实：{{block(row,'verify')}}</span>
          <span v-if="!counterRows.some(r=>identity(r)===identity(row))">反制：{{block(row,'counter')}}</span>
          <a :href="`#/alarms?event=${encodeURIComponent(row.eventId)}${row.riskCaseId?`&risk_case_id=${encodeURIComponent(row.riskCaseId)}`:''}`">查看处置记录</a>
        </div>
      </div>
      <button type="button" class="eo-text-button" :disabled="busy||loading" @click="refresh">重读办理状态</button>
    </template>
    <NModal v-if="dialog" :show="true" preset="card" :title="dialog==='verify'?'核实所选告警':'确认所选目标的反制方式与设备'" class="eo-batch-modal" :style="{width:'min(920px,94vw)'}" :mask-closable="!busy" :closable="!busy" @update:show="value=>{if(!value&&!busy)dialog=''}">
      <p v-if="dialog==='verify'">统一结论：<button type="button" @click="unify('CONFIRMED')">属实</button> <button type="button" @click="unify('FALSE_POSITIVE')">误报</button>；可在下方逐项调整。</p>
      <p v-else>“直接反制”提交后按现有资格下发；“申请审批”提交后等待审批。{{policyText}}</p>
      <div class="eo-draft-list">
        <section v-for="row in drafts" :key="identity(row)" class="eo-draft-row">
          <header><strong>{{row.label}}<template v-if="row.airspaceName"> · {{row.airspaceName}}</template></strong><span>{{row.reasonText}}</span></header>
          <template v-if="dialog==='verify'">
            <UField :id="`eo-conclusion-${identity(row)}`" v-model="row.conclusion" type="select" label="核实结论" required :options="row.check.allowed_conclusions.map(value=>({value,label:value==='CONFIRMED'?'属实':'误报'}))" :disabled="busy" />
            <UField :id="`eo-note-${identity(row)}`" v-model="row.note" type="textarea" label="核实依据与说明" :input-props="{maxlength:1000}" :disabled="busy" placeholder="选填，最多1000字" />
          </template>
          <template v-else>
            <div class="eo-form-grid">
              <UField :id="`eo-mode-${identity(row)}`" v-model="row.mode" type="select" label="授权方式" :disabled="busy" :options="[{value:'DIRECT',label:'直接反制',allowed:row.check.counter.can_direct},{value:'REQUEST',label:'申请审批',allowed:row.check.counter.can_request}].filter(o=>o.allowed)" />
              <UField :id="`eo-counter-mode-${identity(row)}`" v-model="row.countermeasure_mode" type="select" label="反制方式" :disabled="busy" :options="Object.entries(COUNTERMEASURE_MODE_LABEL).map(([value,label])=>({value,label}))" />
              <UField :id="`eo-channel-${identity(row)}`" v-model="row.channel" type="select" label="执行通道" :disabled="busy" :options="[{value:'COUNTERMEASURE_4CH',label:'四通道反制设备'},{value:'LINGYUN_B',label:'凌云协议 B 设备'}]" @update:model-value="row.device_id=null" />
              <UField :id="`eo-device-${identity(row)}`" v-model="row.device_id" type="select" label="执行设备" required :options="options(row)" :disabled="busy" filterable placeholder="请选择设备" />
            </div>
            <UField :id="`eo-reason-${identity(row)}`" v-model="row.reason" type="textarea" label="事由" :input-props="{maxlength:500}" :disabled="busy" placeholder="选填；填写时为2–500字" />
          </template>
        </section>
      </div>
      <p v-if="selected.length>drafts.length">另 {{selected.length-drafts.length}} 项不满足当前办理条件，仍保留在目标清单中。</p>
      <p v-if="formError" role="alert">{{formError}}</p>
      <template #footer><UFormFooter :loading="busy" :hide-cancel="busy" :danger="dialog==='counter'" :confirm-text="busy?'正在提交':dialog==='verify'?`提交 ${drafts.length} 项核实结论`:`确认提交 ${drafts.length} 项反制`" @cancel="dialog=''" @confirm="submit" /></template>
    </NModal>
  </section>
</template>
<style scoped>
.eo-batch-actions{padding-top:12px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}.eo-batch-actions p{margin:0;color:var(--txt-2);font-size:12px;line-height:1.6}.eo-batch-actions button,.eo-batch-modal button{font:inherit;min-height:36px;border:1px solid var(--control-line);border-radius:5px;color:var(--txt);background:var(--surface-2);cursor:pointer;padding:7px 12px}.eo-batch-actions .eo-primary,.eo-batch-modal .eo-primary{background:#1266cc;border-color:#168fff;color:#fff}.eo-batch-actions .eo-counter,.eo-batch-modal .eo-counter{background:#c84635;border-color:#f26b58;color:#fff}button:disabled{opacity:.45;cursor:not-allowed}.eo-result-list{display:flex;flex-direction:column;gap:8px;max-height:180px;overflow:auto;font-size:12px}.eo-result-list>div{display:flex;flex-direction:column;gap:3px}.eo-result-list span{color:var(--txt-2);line-height:1.55}.eo-result-list .error,[role=alert]{color:var(--amber)}.eo-result-list a{color:var(--cyan)}.eo-draft-list{max-height:58vh;overflow:auto}.eo-draft-row{padding:14px 0;border-top:1px solid var(--line)}.eo-draft-row header{display:flex;gap:14px;margin-bottom:10px}.eo-draft-row header span{color:var(--amber)}.eo-draft-row label{display:flex;flex-direction:column;gap:7px;margin-top:9px}.eo-draft-row select,.eo-draft-row textarea{font:inherit;color:var(--txt);background:var(--surface-2);border:1px solid var(--control-line);border-radius:5px;padding:8px}.eo-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}.eo-modal-footer{display:flex;justify-content:flex-end;gap:12px}@media(max-width:600px){.eo-form-grid{grid-template-columns:1fr}}
</style>
