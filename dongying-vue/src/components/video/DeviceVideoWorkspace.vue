<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { NModal } from 'naive-ui';
import { UControl } from '@/components/form/index.js';
import { CloseOutline, ContractOutline, ExpandOutline, LocateOutline, RefreshOutline } from '@vicons/ionicons5';
import { eoWorkspaceApi } from '@/services/eoWorkspaceApi.js';
import { deviceApi, newIdempotencyKey } from '@/services/deviceApi.js';
import { authSession } from '@/services/auth.js';
import { hasModuleAction } from '@/services/accessControl.js';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { displayTargetNo } from '@/ui/deviceNumber.js';
import AuthenticatedHlsVideo from './AuthenticatedHlsVideo.vue';
import EoVideoDetections from './EoVideoDetections.vue';
import EoDispatchControls from './EoDispatchControls.vue';
import EoBatchActions from './EoBatchActions.vue';
import { deviceVideoState, matchingVideoFrame } from './deviceVideoState.js';
import { eoCameraText } from '@/pages/situation/eoCameraState.js';
import SituationRiskList from '@/pages/situation/SituationRiskList.vue';
import { selectionKey } from '@/pages/situation/eoSelection.js';
const props=defineProps({device:{type:Object,required:true},expanded:Boolean,candidates:{type:Array,default:()=>[]},selected:{type:Array,default:()=>[]},focusedId:String,mode:String,mapView:{type:Object,default:()=>({targets:[]})},riskState:Object,riskFocus:Object,targets:{type:Array,default:()=>[]}});
const emit=defineEmits(['expanded','close','select','focus','remove','clear','mode','locate','updated','risk-kind','risk-page','risk-view','risk-focus','risk-check','risk-refresh']);
const video=ref(null), error=ref(''), loading=ref(false), expanded=computed(()=>props.expanded), windowEl=ref(null), endChoice=ref(null), stopping=ref(false), stopMessage=ref('');
const playback=ref({playing:false,playingAt:null,width:0,height:0});
const playerRevision=ref(0);
let generation=0,timer,controller,alive=true,previousFocus;
const state=computed(()=>deviceVideoState(props.device.deviceId,video.value));
const focused=computed(()=>props.selected.find(row=>selectionKey(row)===props.focusedId)||props.selected[0]);
const selectedTargets=computed(()=>new Set(props.selected.map(row=>row.targetId)).size);
// 默认解释本机正在跟踪的告警；查看说明不自动加入核实、反制选择清单。
const alarmContext=computed(()=>focused.value || props.candidates.find(row=>row.targetId===video.value?.target_id));
const activeFrame=computed(()=>playback.value.playing?matchingVideoFrame(video.value,video.value?.metadata,
  playback.value.playingAt):null);
const visibleIds=computed(()=>new Set((activeFrame.value?.detections||[]).filter(d=>d.association_status==='LINKED').map(d=>d.target_id)));
const unresolvedFrame=computed(()=>!activeFrame.value || (activeFrame.value.detections||[]).some(d=>d.association_status!=='LINKED'));
const trackingLabel=computed(()=>{
  const target=props.candidates.find(row=>row.targetId===video.value?.target_id);
  return target?.label || displayTargetNo(video.value?.target_no) || (video.value?.target_id?'已关联目标':'无跟踪目标');
});
const eventId=computed(()=>props.candidates.find(row=>row.targetId===video.value?.target_id)?.eventId || '');
const canOperate=computed(()=>hasModuleAction('devices','op'));
async function refresh(quiet=false) {
  clearTimeout(timer);controller?.abort();
  const id=props.device.deviceId,token=++generation;
  if(!alive || !id) return;
  controller=new AbortController();
  const currentController=controller, deadline=setTimeout(()=>currentController.abort(),12000);
  if(!quiet) { loading.value=true;playerRevision.value++; }
  try {
    const value=await eoWorkspaceApi.video(id,{signal:controller.signal,dedupe:false});
    if(!alive || token!==generation || id!==props.device.deviceId) return;
    if(value?.device_id!==id) throw new Error('视频与当前光电设备不一致');
    video.value=value;error.value='';
    if(endChoice.value && endChoice.value.taskId!==value.task_id) endChoice.value=null;
  } catch(cause) {if(alive && token===generation){video.value=null;error.value=cause.message || '设备视频读取失败';}}
  finally {clearTimeout(deadline);if(alive && token===generation){loading.value=false;timer=setTimeout(()=>refresh(true),1000);}}
}
watch([()=>props.device.deviceId,authSession],()=>{
  ++generation;controller?.abort();clearTimeout(timer);video.value=null;playback.value={playing:false};endChoice.value=null;stopMessage.value='';refresh();
},{immediate:true});
watch([()=>video.value?.stream_id,()=>video.value?.task_id],()=>{playback.value={playing:false};},{flush:'sync'});
useRealtimeRefresh(['tracking','device_state','disposal'],()=>refresh(true),{minIntervalMs:1000});
async function toggleExpanded() {
  emit('expanded',!expanded.value);
  await nextTick();window.dispatchEvent(new Event('resize'));
}
function close(){emit('expanded',false);emit('close');}
function keyboard(event){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(endChoice.value)return;if(expanded.value)toggleExpanded();else close();}}
function chooseEnd(){if(!video.value?.task_id || !canOperate.value)return;endChoice.value={taskId:video.value.task_id,label:trackingLabel.value,key:newIdempotencyKey('eo-workspace-end')};}
async function endTrack(){
  const choice=endChoice.value;
  if(!choice || stopping.value || video.value?.task_id!==choice.taskId)return;
  stopping.value=true;
  try{await deviceApi.endEoTrack(choice.taskId,choice.key);stopMessage.value='结束请求已提交，请以上方实际跟踪状态为准。';endChoice.value=null;await refresh();}
  catch(cause){stopMessage.value=cause.message || '结束结果未确认，请重读跟踪状态';}
  finally{stopping.value=false;}
}
onMounted(()=>{previousFocus=document.activeElement;windowEl.value?.focus();});
onUnmounted(()=>{alive=false;++generation;clearTimeout(timer);controller?.abort();if(previousFocus?.isConnected)previousFocus.focus();});
</script>
<template>
  <section ref="windowEl" class="eo-workspace" :class="{expanded}" role="region" aria-label="光电实时视频工作区" tabindex="-1" @keydown="keyboard">
    <header class="eo-workspace-heading">
      <div><strong>光电实时视频</strong><span>{{device.name}}</span></div>
      <div class="eo-window-actions">
        <button type="button" :disabled="loading" aria-label="重连设备视频" @click="refresh(false)"><RefreshOutline /></button>
        <button type="button" :aria-expanded="expanded" :aria-label="expanded?'缩小视频窗口':'放大视频与操作栏'" @click="toggleExpanded"><ContractOutline v-if="expanded"/><ExpandOutline v-else/><span>{{expanded?'缩小':'放大'}}</span></button>
        <button type="button" aria-label="关闭设备视频" @click="close"><CloseOutline/></button>
      </div>
    </header>
    <div class="eo-device-status"><span>{{device.status || '状态未知'}}</span><span>任务目标：{{trackingLabel}}</span><span>{{eoCameraText(device.eoView)}}</span><em v-if="device.simulated || video?.simulated">测试视频 · 非现场</em></div>
    <div class="eo-workspace-body">
      <div class="eo-view-column">
        <div class="eo-camera-view">
          <AuthenticatedHlsVideo v-if="state.playable" :key="playerRevision" :device-id="device.deviceId" :video="video" :event-id="eventId" workspace @frame="playback=$event">
            <template #overlay>
              <EoVideoDetections v-if="video.stream_kind==='AI'" :frame="activeFrame" :playback="playback" :mode="mode" :candidates="candidates" :selected="selected" @select="emit('select',$event)" />
            </template>
          </AuthenticatedHlsVideo>
          <div v-else class="eo-video-unavailable" :role="error?'alert':'status'"><strong>{{loading?'正在连接设备视频':error?'视频读取失败':'视频暂不可用'}}</strong><p>{{error || state.message}}</p><button type="button" :disabled="loading" @click="refresh(false)">重连视频</button></div>
          <div v-if="state.playable && video.stream_kind==='AI'" class="eo-pick-toolbar" aria-label="目标选择方式">
            <button type="button" :aria-pressed="mode==='point'" @click="emit('mode','point')">点选</button><button type="button" :aria-pressed="mode==='box'" @click="emit('mode','box')">框选</button><button type="button" :disabled="!selected.length" @click="emit('clear')">清除选择</button>
          </div>
        </div>
        <p v-if="video?.reason && state.playable" class="eo-stream-notice">{{video.reason}}</p>
        <div v-show="expanded" class="eo-map-footer">
          <div class="eo-mini-map-panel"><b>光电覆盖范围 · {{mapView.coverageLabel || (mapView.reason ? '未知' : mapView.targets.length + ' 架无人机')}}</b><div id="eo-video-mini-map" /></div>
          <div class="eo-map-guide"><strong>{{mapView.summary}}</strong><p>范围内目标来自融合感知<br>扇形随镜头实时上报朝向转动；视频识别框须与告警关联</p>
            <div class="eo-map-modes"><button type="button" :aria-pressed="mode==='point'" @click="emit('mode','point')">地图点选</button><button type="button" :aria-pressed="mode==='box'" @click="emit('mode','box')">地图框选</button></div>
            <span id="eo-weather-control"></span>
            <small>{{mapView.airspaceNotice || '地图显示当前生效空域，告警原因以右侧记录为准'}}</small>
            <small>{{mapView.notice || '选择目标不会自动切换跟踪'}}</small>
          </div>
        </div>
        <div v-if="!expanded" class="eo-compact-summary"><span>已选 {{selectedTargets}} 架 · {{selected.length}} 项风险</span><button type="button" @click="toggleExpanded">展开操作栏</button><button type="button" :aria-pressed="mode==='box'" @click="emit('mode',mode==='box'?'point':'box')">{{mode==='box'?'结束地图框选':'地图框选'}}</button></div>
      </div>
      <aside v-show="expanded" class="eo-action-column" aria-label="风险事项与操作">
        <SituationRiskList v-if="riskState" v-bind="riskState" :selected="selected" :focused-key="riskFocus?.key" :device="device" :targets="targets"
          @kind="emit('risk-kind',$event)" @page="emit('risk-page',$event)" @view="emit('risk-view',$event)" @focus="emit('risk-focus',$event)" @check="emit('risk-check',$event)" @refresh="emit('risk-refresh')" />
        <div class="eo-risk-detail"><slot name="risk-detail" /></div>
        <header><strong>已勾选 {{selected.length}} 项 · {{selectedTargets}} 架</strong><button type="button" :disabled="!selected.length" @click="emit('clear')">清空</button></header>
        <div class="eo-selected-list">
          <div v-for="row in selected" :key="selectionKey(row)" class="eo-selected-row" :class="{focused:selectionKey(row)===focusedId}">
            <UControl type="checkbox" :model-value="true" :aria-label="`取消选择${row.label}${row.airspaceName || ''}`" @update:model-value="emit('remove',selectionKey(row))" />
            <button type="button" @click="emit('focus',selectionKey(row))"><span><b>{{row.label}}</b><em>{{row.eventState==='CONFIRMED'?'已核实':row.eventState==='FALSE_POSITIVE'?'误报':'待核实'}}</em></span><small class="eo-selected-reason">{{row.reasonText || '告警原因未提供'}}</small><small v-if="row.airspaceName">关联区域：{{row.airspaceName}}</small><small>{{row.unavailable?'当前观测或关联已变化':video?.stream_kind==='RAW'?'原始流无识别信息':visibleIds.has(row.targetId)?'当前画面内':unresolvedFrame?'画面关联待确认':'当前画面外'}}</small></button>
            <EoDispatchControls v-if="expanded && !row.unavailable" class="eo-row-observation" summary-only :target-id="row.targetId" />
          </div>
          <p v-if="!selected.length">可在地图点选、框选告警无人机，也可点击已关联告警的 AI 识别框。</p>
        </div>
        <section v-if="alarmContext && !riskFocus" class="eo-focus-detail"><h3>{{focused?'当前查看':'当前跟踪'}} {{alarmContext.label}}</h3>
          <div class="eo-alarm-context" aria-label="告警原因与关联区域"><strong>告警原因</strong><p class="eo-alarm-reason">{{alarmContext.reasonText || '原因未提供'}}</p>
            <p v-if="alarmContext.airspaceName" class="eo-alarm-area">关联区域：{{alarmContext.airspaceName}}</p>
            <p v-else-if="alarmContext.airspaceId">关联区域名称未提供</p>
            <small v-if="alarmContext.riskStageText">{{alarmContext.riskStageText}}</small>
            <small v-if="alarmContext.unavailable">当前观测或告警关联已变化，以上保留原告警信息。</small>
          </div>
          <p>光电设备：{{device.name}}</p><button type="button" class="eo-locate" @click="emit('locate',alarmContext)"><LocateOutline/>定位目标</button>
          <EoDispatchControls v-if="focused && !focused.unavailable" :key="focused.targetId" :target-id="focused.targetId" :device-id="device.deviceId" @updated="refresh" />
        </section>
        <EoDispatchControls v-if="riskFocus?.kind==='UAV' && riskFocus.target_id && riskFocus.current_status==='CURRENT' && !riskFocus.unavailable" :key="riskFocus.target_id" :target-id="riskFocus.target_id" :device-id="device.deviceId" @updated="refresh" />
        <button v-if="video?.task_id && canOperate" type="button" class="eo-end-track" @click="chooseEnd">结束本机跟踪 {{trackingLabel}}</button>
        <p v-if="stopMessage" class="eo-stream-notice" role="status">{{stopMessage}}</p>
        <EoBatchActions :selected="selected" :focused-id="focusedId" @updated="emit('updated')" />
      </aside>
    </div>
    <NModal v-if="endChoice" :show="true" preset="dialog" title="确认结束本机跟踪" :mask-closable="!stopping" @update:show="v=>{if(!v&&!stopping)endChoice=null}"><p>{{device.name}} 正在跟踪 {{endChoice?.label}}。结束后收到设备停止回执才释放任务；关闭视频窗口不需要结束跟踪。</p><template #action><button type="button" :disabled="stopping" @click="endChoice=null">保持跟踪</button><button type="button" :disabled="stopping" @click="endTrack">确认结束跟踪</button></template></NModal>
  </section>
</template>
<style scoped>
.eo-alarm-context{padding:12px;border:1px solid var(--red);border-left-width:3px;border-radius:5px;background:var(--surface-2);overflow-wrap:anywhere}.eo-alarm-context>strong{font-size:12px;color:var(--txt-2)}.eo-alarm-context>small{display:block;color:var(--txt-2);line-height:1.7}.eo-focus-detail .eo-alarm-area{color:var(--txt);font-size:13px;line-height:1.6}.eo-selected-row .eo-selected-reason{color:var(--amber);font-weight:600}.eo-selected-row>button{min-width:0;overflow-wrap:anywhere}
.eo-selected-row{flex-wrap:wrap}.eo-row-observation{width:100%;padding-left:24px}.eo-row-observation :deep(p){margin:0;color:var(--cyan);font-size:12px}
.eo-workspace{position:absolute;right:20px;bottom:64px;width:min(560px,calc(100% - 40px));max-height:calc(100% - 100px);overflow:auto;z-index:40;background:var(--surface-1);border:1px solid var(--control-line);border-radius:8px;box-shadow:0 10px 40px #0008;color:var(--txt);font-size:13px}.eo-workspace.expanded{position:fixed;inset:2.5vh 2.5vw;width:95vw;height:95vh;max-height:none;z-index:1100;display:flex;flex-direction:column;overflow:hidden}.eo-workspace-heading{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);gap:12px}.eo-workspace-heading>div:first-child{display:flex;align-items:center;gap:14px}.eo-workspace-heading strong{font-size:17px}.eo-workspace-heading span{color:var(--txt-2)}.eo-window-actions{display:flex;gap:6px}.eo-workspace button{font:inherit;min-height:32px;background:var(--surface-2);border:1px solid var(--control-line);border-radius:5px;color:var(--txt);padding:5px 9px;cursor:pointer}.eo-workspace button:disabled{opacity:.45;cursor:not-allowed}.eo-workspace button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}.eo-window-actions button{display:flex;align-items:center;gap:5px}.eo-window-actions svg,.eo-locate svg{width:18px;height:18px}.eo-device-status{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 16px;border-bottom:1px solid var(--line);font-size:12px}.eo-device-status em{font-style:normal;color:var(--amber)}.eo-workspace-body{min-height:0;flex:1}.expanded .eo-workspace-body{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;padding:14px;overflow:hidden}.eo-view-column{min-width:0;min-height:0;overflow:auto}.eo-camera-view{position:relative;background:#030713}.eo-camera-view :deep(.external-video>p),.eo-camera-view :deep(.eo-capture){padding:0 12px}.eo-video-unavailable{aspect-ratio:16/9;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--txt-2);gap:12px}.eo-video-unavailable strong{font-size:18px;color:var(--txt)}.eo-video-unavailable p{max-width:480px;line-height:1.7}.eo-pick-toolbar{position:absolute;left:10px;top:10px;display:flex;gap:5px;z-index:5}.eo-pick-toolbar button{background:#08122ce8}.eo-workspace button[aria-pressed=true]{background:#1266cc;color:#fff;border-color:#168fff}.eo-stream-notice{color:var(--amber);padding:4px 12px;line-height:1.6;font-size:12px}.eo-compact-summary{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:8px 12px}.eo-compact-summary>span{margin-right:auto}.eo-map-footer{display:grid;grid-template-columns:minmax(200px,1fr) minmax(180px,.8fr);gap:12px;margin-top:12px;min-height:160px}.eo-mini-map-panel{position:relative;border:1px solid var(--line);min-height:160px;overflow:hidden;border-radius:6px}.eo-mini-map-panel>b{position:absolute;top:8px;left:10px;z-index:10;padding:4px;background:var(--surface-1)}#eo-video-mini-map{height:180px;position:relative}.eo-map-guide{padding:10px;display:flex;flex-direction:column;justify-content:center;gap:8px}.eo-map-guide p{margin:0;color:var(--txt-2);font-size:12px}.eo-map-guide small{line-height:1.8;color:var(--txt-2)}.eo-map-modes{display:flex;gap:6px}.eo-action-column{overflow:auto;min-height:0;display:flex;flex-direction:column;gap:12px;border-left:1px solid var(--line);padding-left:14px}.eo-action-column>header{display:flex;align-items:center;justify-content:space-between;font-size:17px}.eo-selected-list{max-height:240px;overflow:auto;flex-shrink:0}.eo-selected-row{display:flex;gap:8px;padding:8px;border-bottom:1px solid var(--line)}.eo-selected-row.focused{background:var(--surface-selected);outline:1px solid var(--cyan);outline-offset:-1px}.eo-selected-row>button{flex:1;text-align:left;background:transparent;border:0;padding:0}.eo-selected-row span{display:flex;justify-content:space-between;gap:10px}.eo-selected-row em{font-style:normal;font-size:11px;color:var(--cyan)}.eo-selected-row small{display:block;color:var(--txt-2);line-height:1.6;margin-top:3px}.eo-selected-list p{color:var(--txt-2);line-height:1.7}.eo-focus-detail{border-top:1px solid var(--line);padding-top:12px}.eo-focus-detail h3{font-size:15px;margin:0 0 14px}.eo-focus-detail>small{color:var(--txt-2)}.eo-focus-detail p{font-size:12px;color:var(--txt-2);margin:7px 0}.eo-focus-detail .eo-alarm-reason{font-size:16px;font-weight:600;color:#ff855f}.eo-locate{display:inline-flex;align-items:center;gap:5px;margin:6px 0 12px}.eo-end-track{color:#ff855f!important}.eo-focus-detail :deep(.eo-dispatch){margin-top:5px}@media(max-width:1000px){.expanded .eo-workspace-body{grid-template-columns:minmax(0,1fr) 300px;padding:10px;gap:10px}.eo-map-footer{grid-template-columns:1fr}.eo-map-guide{display:none}}@media(max-width:700px){.expanded .eo-workspace-body{display:flex;flex-direction:column;overflow:auto}.eo-view-column{overflow:visible;flex:none}.eo-action-column{overflow:visible;border-left:0;padding-left:0}.eo-workspace-heading>div:first-child{flex-direction:column;align-items:flex-start;gap:3px}.eo-device-status{gap:6px}.eo-workspace.expanded{inset:1vh 1vw;width:98vw;height:98vh}.eo-map-footer{min-height:140px}#eo-video-mini-map{height:150px}}
</style>
<style scoped>
.expanded .eo-workspace-body{grid-template-columns:minmax(0,1fr) 390px}.eo-action-column>header{font-size:14px;flex:none}.eo-risk-detail:empty{display:none}.eo-risk-detail{flex:none;min-width:0}.eo-selected-list{max-height:160px}.eo-action-column :deep(.eo-batch-actions){position:sticky;bottom:0;background:var(--surface-1);padding-bottom:8px;z-index:2}.eo-action-column :deep(.risk-evidence){padding:0 2px}
@media(max-width:1000px) and (min-width:701px){.expanded .eo-workspace-body{grid-template-columns:minmax(0,1fr) 340px}}
</style>
<style scoped>
.eo-workspace{position:fixed}
.eo-workspace-heading,.eo-device-status{flex:none}
@media(min-width:701px){
  .expanded .eo-view-column{display:flex;flex-direction:column;overflow:hidden}
  .expanded .eo-camera-view{flex:1;min-height:160px;overflow:hidden}
  .expanded .eo-camera-view :deep(.external-video){height:100%;display:flex;flex-direction:column}
  .expanded .eo-camera-view :deep(.is-workspace .video-stage){flex:1;min-height:0;aspect-ratio:auto;overflow:hidden}
  .expanded .eo-camera-view :deep(.is-workspace video){position:absolute;inset:0}
  .expanded .eo-video-unavailable{height:100%;aspect-ratio:auto;box-sizing:border-box}
  .expanded .eo-map-footer{flex:none;height:210px;min-height:210px}
  .expanded #eo-video-mini-map{height:210px}
  .expanded .eo-stream-notice{flex:none;margin:6px 0}
}
</style>
