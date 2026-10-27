<script setup>
import { UControl } from '@/components/form/index.js';
import { SEVERITY_LABEL, RISK_STATE_LABEL, labelOf } from '@/ui/labels.js';
import { riskCoverageText } from './situationRiskItems.js';
const props = defineProps({ rows:Array,counts:Object,availability:Object,total:Number,kind:String,page:Number,view:String,error:String,loading:Boolean,
  selected:{type:Array,default:()=>[]},focusedKey:String,device:Object,targets:{type:Array,default:()=>[]} });
const emit=defineEmits(['kind','page','view','focus','check','refresh']);
const tabs=[['ALL','全部','all'],['UAV','无人机','uav'],['SPACE_OBJECT','鸟类异物','space_object'],['WEATHER','气象','weather']];
const checked=row=>props.selected.some(item=>item.key===row.key);
const title=row=>row.kind==='UAV' ? row.target_no || '无人机编号未提供' : row.kind==='WEATHER' ? row.area_name || '气象风险' : row.target_no || '鸟类与异物风险';
const unavailable=()=>props.kind==='ALL' ? false : props.availability?.[({UAV:'uav',SPACE_OBJECT:'space_object',WEATHER:'weather'})[props.kind]]==='UNAVAILABLE';
const phase=row=>({PREDICTED:'预测预警',ENTERED:'实测入区',OBSERVED:'实测风险',UNKNOWN:'依据不足',CLEARED:'已避开',ENDED:'已结束'})[row.stage]
  || (row.current_status==='UNKNOWN'?'当前影响待确认':labelOf(RISK_STATE_LABEL,row.state,''));
</script>
<template>
  <section class="situation-risk-list" aria-label="全部风险事项">
    <div class="risk-tabs" role="tablist" aria-label="风险分类"><button v-for="[value,label,count] in tabs" :key="value" type="button" role="tab"
      :aria-selected="kind===value" @click="emit('kind',value)">{{label}} <b>{{counts?.[count] ?? '—'}}</b></button></div>
    <div class="risk-list-tools"><button type="button" :aria-pressed="view==='ACTIVE'" @click="emit('view','ACTIVE')">当前风险</button>
      <button type="button" :aria-pressed="view==='PROCESSING'" @click="emit('view','PROCESSING')">处理中／待回执</button>
      <button type="button" :disabled="loading" @click="emit('refresh')">刷新</button></div>
    <p v-if="error" role="alert">{{error}}</p><p v-else-if="loading && !rows?.length" role="status">正在读取风险…</p>
    <div class="risk-list-scroll" role="tabpanel">
      <article v-for="row in rows" :key="row.key" :class="{focused:focusedKey===row.key}" :data-risk-key="row.key">
        <UControl v-if="row.kind==='UAV' && row.event_id && row.target_id" type="checkbox" :model-value="checked(row)" :aria-label="`勾选${title(row)}${row.area_name || ''}风险`" @update:model-value="emit('check',row)" />
        <button type="button" class="risk-list-item" :aria-pressed="focusedKey===row.key" @click="emit('focus',row)">
          <span><b>{{title(row)}}</b><em :class="row.severity?.toLowerCase()">{{labelOf(SEVERITY_LABEL,row.severity,'等级未知')}}</em></span>
          <strong>{{row.reason_text || '风险原因未提供'}}</strong>
          <small>{{phase(row)}}<template v-if="row.area_name && row.kind==='UAV'"> · {{row.area_name}}</template><template v-if="row.plan_no"> · 任务 {{row.plan_no}}</template></small>
          <small>{{riskCoverageText(row,device,targets)}}<template v-if="row.simulated"> · 模拟</template></small>
        </button>
      </article>
      <p v-if="!loading && !error && !rows?.length">{{unavailable()?'当前账号没有查看此类风险的权限。':view==='PROCESSING'?'当前没有可读取的未完成办理事项。':'当前没有此类有效风险。'}}</p>
    </div>
    <footer v-if="total!=null"><span>{{view==='PROCESSING'?'办理事项':'风险事项'}} {{total}} 项</span><button type="button" :disabled="page<=1 || loading" @click="emit('page',page-1)">上一页</button>
      <span>{{page}} / {{Math.max(1,Math.ceil(total/20))}}</span><button type="button" :disabled="page*20>=total || loading" @click="emit('page',page+1)">下一页</button></footer>
  </section>
</template>
<style scoped>
.situation-risk-list{min-height:0;flex:none;border-bottom:1px solid var(--line);padding-bottom:10px;color:var(--txt)}
.risk-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:3px}.risk-tabs button{padding:6px 2px!important;font-size:12px!important;white-space:nowrap}.risk-tabs b{font-size:11px;color:var(--txt-2)}
.risk-tabs [aria-selected=true]{border-color:var(--cyan)!important;background:var(--surface-selected)!important;color:var(--cyan)!important}
.risk-list-tools,footer{display:flex;gap:5px;align-items:center;margin-top:8px;font-size:11px}.risk-list-tools button{font-size:11px!important;padding:5px 7px!important}.risk-list-tools button:last-child,footer>span:first-child{margin-right:auto}
.risk-list-scroll{max-height:240px;overflow:auto;overscroll-behavior:contain;margin-top:8px}article{display:flex;gap:7px;padding:8px 5px;border-bottom:1px solid var(--line)}article.focused{background:var(--surface-selected);box-shadow:inset 2px 0 var(--cyan)}
.risk-list-item{display:block;flex:1;min-width:0;border:0!important;text-align:left;background:transparent!important;padding:0!important}.risk-list-item>span{display:flex;justify-content:space-between;gap:5px}.risk-list-item em{font-style:normal;font-size:10px;color:var(--amber)}.risk-list-item em.high{color:var(--red)}
.risk-list-item strong{display:block;font-size:12px;font-weight:500;color:var(--amber);margin:4px 0;line-height:1.5}.risk-list-item small{display:block;font-size:11px;color:var(--txt-2);line-height:1.5}p{color:var(--txt-2);font-size:12px;line-height:1.6}footer button{font-size:11px!important;padding:4px!important}
</style>
