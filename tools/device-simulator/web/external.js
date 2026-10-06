'use strict';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const tabs = {
 plans:['飞行计划输入','填写计划与申报资料，或读取已有模拟计划补录。'],
 weather:['气象预报输入','提交指定区域的模拟预报，系统按预报区域判断哪些计划受到影响。'],
 sms:['飞手短信','查看平台模拟短信的接收内容，未送达与结果未知的记录单独展示。'],
 voice:['飞手电话','查看模拟电话录音通知内容，接通与播放结果以记录为准。'],
 risk:['风险通知','查看通知上级的模拟消息与已保存内容。'],
 punishment:['处罚通知','查看处罚接收对象收到的模拟消息与已保存材料。'],
 plan_feedback:['计划回告','查看报送单位的计划核实回告及平台保存的送达回执。'],
 device_maintenance:['设备运维','查看模拟设备运维通知的各次发送与回执；通知送达不代表设备已恢复。']
};
let tab=window.SimulatorExternalView?.tab||'risk', context=null, connected=false, busy=false, requestSerial=0, refreshTimer=null, sessionVersion=null, checkingStatus=false;
let inbox=null, inboxPage=1, refreshing=false, showOther=false;
const drafts={plans:'',weather:''};
let planOptions=null, editingPlan=null, createPlanDraft=null, scenePlans=[], selectedScenePlanId='';

function message(text,error=false){const el=$('#external-message');el.textContent=text;el.classList.toggle('error',error);}
function id(){return 'sim-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);}
function formatTime(ms){return Number.isFinite(Number(ms))&&ms?new Date(Number(ms)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间未知';}
function options(rows,key,label){return (rows||[]).map(row=>`<option value="${escapeHtml(row[key])}">${escapeHtml(row[label]||row[key])}</option>`).join('');}
async function call(path, body, signal){const requestedSession=sessionVersion;const writing=body!==undefined&&!(path==='request'&&body.method==='GET');let response;try{response=await fetch('/api/external/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});}catch(error){if(error.name==='AbortError')throw error;throw Error(writing?'本机模拟器服务不可用；本次提交结果未知，请恢复后刷新记录核对。':'本机模拟器服务不可用，请恢复后刷新记录。');}let data;try{data=await response.json();}catch{throw Error(writing?'系统响应无法读取；提交结果未知，请刷新记录核对。':'系统响应无法读取，请刷新重试。');}if(response.status===401&&path!=='connect'&&requestedSession===sessionVersion){requestSerial++;setConnection({connected:false});context=null;inbox=null;message('系统登录已失效，请重新登录；当前报文草稿已保留。',true);render();throw Error('系统登录已失效，请重新登录；当前报文草稿已保留。');}if(!response.ok)throw Error(data.error||'系统请求失败');return data;}
function backend(method,path,body,key){return call('request',{method,path,...(body===undefined?{}:{body,key})});}
function setConnection(value){
 const changed=value.session_version!==undefined&&value.session_version!==sessionVersion;
 if(changed||(!value.connected&&connected)){requestSerial++;context=null;inbox=null;planOptions=null;editingPlan=null;if(createPlanDraft!==null){drafts.plans=createPlanDraft;createPlanDraft=null;}}
 if(value.session_version!==undefined)sessionVersion=value.session_version;
 connected=!!value.connected;
 $('#external-status').textContent=connected?`已登录 ${value.user?.name||value.user?.account||'系统'}`:'尚未登录系统';
 $('#login-toggle').textContent=connected?'切换账号':'登录系统';
 if(value.api)$('#login-form [name=api]').value=value.api;
 if(changed){if(connected&&$('#login-dialog').open){$('#login-form [name=password]').value='';$('#login-dialog').close();}render();}
}
async function status(){
 if(checkingStatus||busy)return;checkingStatus=true;
 try{const serial=requestSerial;const value=await call('status');if(serial!==requestSerial)return;setConnection(value);if(connected)await refresh();else render();}
 catch(error){message(error.message,true);render();}finally{checkingStatus=false;}
}
async function refresh(){
 if(!connected||document.hidden||busy||refreshing||window.SimulatorExternalView?.visible===false)return;
 const serial=++requestSerial, requestedTab=tab, requestedPage=inboxPage;refreshing=true;
 try{
  const isInput=tab==='plans'||tab==='weather';
  const next=isInput?await backend('GET','/local-interface-simulator/context'):await call('inbox?kind='+tab+'&page='+inboxPage);
  const nextOptions=requestedTab==='plans'?await backend('GET','/local-interface-simulator/plan-options'):planOptions;
  if(serial!==requestSerial)return;
  const changed=JSON.stringify(isInput?context:inbox)!==JSON.stringify(next)||JSON.stringify(planOptions)!==JSON.stringify(nextOptions);
  if(isInput&&requestedTab==='plans'&&!editingPlan&&drafts.plans){
   const draft=readDraft();
   const updated=window.ExternalContract.refreshUpstreamRouteDraft(draft,context?.routes,next?.routes);
   if(updated!==draft)drafts.plans=JSON.stringify(updated,null,2);
  }
  planOptions=nextOptions;
  if(isInput)context=next;else inbox=next;
  if(changed&&!$('#external-body').contains(document.activeElement))render();
 }catch(error){if(serial===requestSerial){message(error.message,true);render();}}
 finally{refreshing=false;if((requestedTab!==tab||requestedPage!==inboxPage)&&connected)refresh();}
}
function setTab(next){
 if(!tabs[next]||tab===next||busy)return;
 if(tab==='plans'||tab==='weather'){const editor=$('#payload-editor');if(editor)drafts[tab]=editor.value;}
 tab=next;inbox=null;inboxPage=1;showOther=false;requestSerial++;message('');render();if(connected)refresh();
}
function samplePlan(route=context?.routes?.[0]){return window.ExternalContract.planSampleForRoute(route,Date.now(),id());}
function sampleWeather(){return window.ExternalContract.weatherSample(Date.now(),id());}
function sectionProblem(words){return (context?.unavailable_sections||[]).find(value=>typeof value==='string'&&words.some(word=>value.includes(word)))||'';}
function selectedScenePlan(){return scenePlans.find(plan=>plan.id===selectedScenePlanId)||null;}
function syncScenePlanDraft(options={}){
 const plan=selectedScenePlan();if(!plan||editingPlan||!drafts.plans)return readDraft();
 const next=window.ExternalContract.applyScenePlanRoute(
  window.PlanForm.applyScenePlan(readDraft(),plan,Date.now(),options),
  plan,
  context?.routes?.[0]
 );
 drafts.plans=JSON.stringify(next,null,2);return next;
}
function buildInput(){return tab==='weather'?buildWeatherInput():buildPlanInput();}
function buildPlanInput(){
 let warning='';if(!drafts.plans){try{drafts.plans=JSON.stringify(samplePlan(),null,2);}catch(error){warning=error.message;drafts.plans=JSON.stringify({message_id:id(),uav_sn:'',filing:{}},null,2);}}
 const rows=context?.routes||[],scenePlan=selectedScenePlan();if(scenePlan&&!editingPlan)syncScenePlanDraft();const data=readDraft();
 const route=rows.find(row=>row.route_version_id===data.route_version_id);
 const routeField=data.route?.geometry?`<p class="external-note">本次计划报文将直接携带地图计划的航线几何；系统接收计划后保存航线版本，不与既有航线做几何匹配。</p>`:data.route_version_id?`<input id="input-target" type="hidden" value="${escapeHtml(data.route_version_id)}"><p class="external-note">当前报文仍使用已有航线版本${route?`：${escapeHtml(route.name||route.route_version_id)}`:'。'}，仅用于兼容旧报文。</p>`:'<input id="input-target" type="hidden" value=""><p class="external-note warn">计划报文缺少航线几何；请选择地图计划生成完整 route，或在接口报文中补充 route。</p>';
 const sceneSelector=scenePlans.length?`<label>地图计划航线<select id="scene-plan-target"><option value="">请选择地图航线</option>${scenePlans.map(plan=>`<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} · ${escapeHtml(plan.start||'未设置')}—${escapeHtml(plan.end||'未设置')}</option>`).join('')}</select></label>`:'';
 const basic=editingPlan?`<p>补录计划：${escapeHtml(editingPlan.plan_no)} · ${escapeHtml(editingPlan.uav_sn)}。原航线、时间和状态保持不变。计划飞行时间（北京时间）：${escapeHtml(window.WeatherForm.localTime(editingPlan.start_at).replace('T',' '))}—${escapeHtml(window.WeatherForm.localTime(editingPlan.end_at).replace('T',' '))}</p><button id="cancel-plan-edit" type="button">返回新建计划</button>`:`<div class="external-grid">${routeField}${sceneSelector}<label>无人机 SN<input data-plan-field="uav_sn" value="${escapeHtml(data.uav_sn)}" maxlength="128"></label><label>计划开始时间（北京时间）<input data-plan-field="start_at" type="datetime-local" step="1" value="${window.WeatherForm.localTime(data.start_at)}"></label><label>计划结束时间（北京时间）<input data-plan-field="end_at" type="datetime-local" step="1" value="${window.WeatherForm.localTime(data.end_at)}"></label></div><button id="new-sample" type="button">生成新样本</button>`;
 const alignment=scenePlan?'<p class="external-note">地图计划用于生成本次上级计划报文的时间、起降点和航线几何；系统接收后保存航线版本，不与既有航线匹配。</p>':'';
 const blocked=!editingPlan&&!data.route&&!data.route_version_id;
 return `<section class="panel external-card"><h3>${editingPlan?'补录计划资料':'新建飞行计划'}</h3>${basic}${alignment}${warning?`<p class="external-note warn">${escapeHtml(warning)}</p>`:''}${!editingPlan&&blocked?`<p class="external-note warn">${escapeHtml(sectionProblem(['航线'])||'当前计划没有航线几何；请选择地图计划，或直接编辑接口报文补充 route。')}</p>`:''}</section><section class="panel external-card"><h3>申报资料</h3>${(planOptions?.unavailable_sections||[]).map(x=>`<p class="external-note warn">${escapeHtml(x)}</p>`).join('')}<div id="plan-fields">${window.PlanForm.fields(data,{...(planOptions||{}),scene_plan:scenePlan})}</div><details><summary>接口报文</summary><label>模拟消息编号<input id="input-message-id" value="${escapeHtml(data.message_id)}" maxlength="64"></label><label>请求内容<textarea id="payload-editor" spellcheck="false">${escapeHtml(drafts.plans)}</textarea></label></details><div class="external-actions"><button id="submit-input" class="primary" type="button" ${blocked?'disabled':''}>${editingPlan?'保存补录资料':'提交计划'}</button></div></section><section class="panel external-card"><h3>已有模拟计划</h3><label>选择计划<select id="existing-plan"><option value="">请选择</option>${options(context?.plans||[],'plan_id','plan_no')}</select></label><button id="load-plan-filing" type="button">读取并补录资料</button></section>${renderMessages('FLIGHT_PLAN')}`;
}
function planFieldsChanged(){if(tab==='plans'&&$('#plan-fields'))$('#plan-fields').innerHTML=window.PlanForm.fields(readDraft(),{...(planOptions||{}),scene_plan:selectedScenePlan()});}
async function loadPlanFiling(planId){
 if(!planId||busy)return;busy=true;const requested=sessionVersion;
 try{const result=await backend('GET','/local-interface-simulator/plans/'+encodeURIComponent(planId)+'/filing');if(requested!==sessionVersion)return;if(createPlanDraft===null)createPlanDraft=drafts.plans;editingPlan=result.plan;drafts.plans=JSON.stringify(window.PlanForm.fromDetail(result,id()),null,2);message('已读取当前资料，可填写缺失项后保存。');render();$('#external-body').scrollIntoView({block:'start'});}catch(error){message(error.message,true);}finally{busy=false;}
}
function buildWeatherInput(){
 if(!drafts.weather)drafts.weather=JSON.stringify(sampleWeather(),null,2);
 let data;try{data=JSON.parse(drafts.weather);if(!data||typeof data!=='object'||Array.isArray(data))data={};}catch{data={};}
 return `<section class="panel external-card"><h3>预报范围</h3><div class="external-grid"><label>模拟消息编号<input id="input-message-id" value="${escapeHtml(data.message_id||'')}" maxlength="64"></label><div id="weather-area-field">${window.WeatherForm.areaField(data)}</div></div><p id="weather-coverage">${escapeHtml(window.WeatherForm.coverage(data))}</p><div class="external-actions"><button id="new-sample" type="button">生成新样本</button></div></section><section class="panel external-card"><h3>天气预报</h3><div id="weather-fields">${window.WeatherForm.fields(data)}</div><details id="weather-json"><summary>接口报文</summary><p>POST /api/v1/local-interface-simulator/weather</p><label>请求内容<textarea id="payload-editor" spellcheck="false">${escapeHtml(drafts.weather)}</textarea></label></details><div class="external-actions"><button id="submit-input" class="primary" type="button">提交预报</button></div></section>${renderMessages('WEATHER_FORECAST')}`;
}
function weatherFieldsChanged(){
 if(tab!=='weather')return;
 try{const data=JSON.parse(drafts.weather);$('#weather-area-field').innerHTML=window.WeatherForm.areaField(data);$('#weather-fields').innerHTML=window.WeatherForm.fields(data);$('#weather-coverage').textContent=window.WeatherForm.coverage(data);}
 catch{message('接口报文不是有效 JSON，请修正后再填写表单。',true);}
}
function readDraft(){try{const value=JSON.parse(drafts[tab]);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
function readDraftId(){return readDraft().message_id||'';}
function syncInputFields(){
 const editor=$('#payload-editor'),data=JSON.parse(editor.value);
 if(!data||Array.isArray(data)||typeof data!=='object')throw Error('报文必须是 JSON 对象');
 if(tab==='plans'&&editingPlan){data.message_id=$('#input-message-id').value.trim();drafts.plans=JSON.stringify(data,null,2);editor.value=drafts.plans;return data;}
 const target=$('#input-target')?.value||'',messageId=$('#input-message-id')?.value.trim()||'';
 const plan=null;
 const route=tab==='plans'?(context?.routes||[]).find(row=>row.route_version_id===target):null;
 const next=window.ExternalContract.applyInputFields(data,{kind:tab,target,messageId,plan,route,now:Date.now()});
 drafts[tab]=JSON.stringify(next,null,2);editor.value=drafts[tab];return next;
}
function renderMessages(kind){const rows=(context?.messages||[]).filter(row=>row.kind===kind||(kind==='FLIGHT_PLAN'&&row.kind==='PLAN_FILING'));return `<section class="panel external-card"><h3>系统接收记录</h3>${rows.length?`<div class="external-results">${rows.map(row=>renderRecord(row)+(kind==='FLIGHT_PLAN'?`<button type="button" data-edit-plan="${escapeHtml(row.subject_id)}">补录计划资料</button>`:'')).join('')}</div>`:'<div class="external-empty">尚无此类接收记录。提交后刷新系统数据查看实际结果。</div>'}</section>`;}
function stateText(item){const map={SUBMITTED:'已提交，等待业务处理',DELIVERED:'已送达，等待签收回执',ACKNOWLEDGED:'已签收',FAILED:'发送失败',TIMEOUT:'回执超时，结果未知',ACCEPTED:'系统已受理',REJECTED:'系统已拒绝'};return map[item.state]||item.state||'状态未知';}
function detail(item){return `<details><summary>查看原始报文与处理结果</summary><pre>${escapeHtml(JSON.stringify({message_id:item.message_id,version:item.version,payload:item.payload,result:item.result},null,2))}</pre></details>`;}
function renderRecord(item){const outgoing=item.direction==='OUT',subject=item.subject_id,kind=item.kind;let link='';if(['FLIGHT_PLAN','PLAN_FILING'].includes(kind)&&item.result?.plan_id)link=`<a target="_blank" rel="noopener" href="http://localhost:5173/#/flights?plan=${encodeURIComponent(item.result.plan_id)}">查看飞行计划</a>`;if(kind==='UAV_PUNISHMENT'&&subject)link=`<a target="_blank" rel="noopener" href="http://127.0.0.1:5173/#/punish?handoff=${encodeURIComponent(subject)}">查看移送与处罚</a>`;return `<article class="external-record"><header><div><strong>${escapeHtml(kind)} · ${escapeHtml(stateText(item))}</strong><small>${escapeHtml(formatTime(item.created_at))} · 模拟消息</small></div><span class="badge">${outgoing?'平台发出':'平台接收'}</span></header><p>${escapeHtml(item.result?.message||item.result?.status||'业务结果请查看系统记录')}</p>${link}${detail(item)}</article>`;}
function inboxRecord(item){
 const subject=item.kind==='risk'&&String(item.subject||'').includes(':')?'风险通知':item.subject;
 const alarmLabels={UAV_INTRUSION:'无人机入侵',UAV:'无人机告警',RULE_LEGALITY:'飞行违规'};
 const content=item.kind==='punishment'&&alarmLabels[item.content]?'移送事由：'+alarmLabels[item.content]:item.content;
 const status={SIMULATED_DELIVERED:'模拟短信已送达',SIMULATED_PLAYED:'模拟接通并完成播放',DELIVERED:'模拟通知已送达',SUBMITTED:'已发出，送达待确认',PENDING_DELIVERY:'待发送',FAILED:'发送失败',UNKNOWN:'结果未知',TIMEOUT:'回执超时，结果未知',ANSWERED:'已接通，播放待确认'};
 const receipt={NOT_EXPECTED:'未进入签收',PENDING:'等待签收回执',ACKNOWLEDGED:'已签收',TIMEOUT:'签收回执超时'};
 return `<article class="inbox-message"><header><div><strong>${escapeHtml(subject||'关联事项未提供')}</strong><small>${escapeHtml(item.time_label||'记录时间')} · ${escapeHtml(formatTime(item.at))}</small></div><span class="inbox-state ${item.received?'received':''}">${escapeHtml(status[item.status]||item.status||'状态未知')}</span></header><div class="inbox-recipient">接收对象 <b>${escapeHtml(item.recipient||'未提供')}</b></div><p class="inbox-content">${escapeHtml(content||'通知内容未提供')}</p>${item.receipt_status?`<p class="inbox-receipt">签收回执：${escapeHtml(receipt[item.receipt_status]||item.receipt_status)}</p>`:''}${item.reason?`<p class="external-note warn">${escapeHtml(item.reason)}</p>`:''}<details data-record="${escapeHtml(item.id)}"><summary>查看完整记录</summary><pre>${escapeHtml(JSON.stringify({subject:item.subject,...item.details},null,2))}</pre></details></article>`;
}
function buildOutput(){
 if(!inbox)return '<div class="external-empty">正在读取通知记录。</div>';
 const received=inbox.items.filter(item=>item.received), other=inbox.items.filter(item=>!item.received),rows=showOther?other:received;
 return `${inbox.errors?.length?`<div class="external-note warn">部分记录读取失败，以下结果可能不完整。${inbox.errors.map(escapeHtml).join('；')}</div>`:''}<div class="inbox-toolbar"><div class="inbox-filters"><button data-inbox-filter="received" aria-pressed="${!showOther}">已收到 <b>${received.length}</b></button><button data-inbox-filter="other" aria-pressed="${showOther}">其他发送记录 <b>${other.length}</b></button></div><span class="muted">${escapeHtml(inbox.scope)}</span></div>${rows.length?`<div class="inbox-list">${rows.map(inboxRecord).join('')}</div>`:`<div class="inbox-empty"><img src="assets/document.svg" alt=""><h3>${inbox.errors?.length?'暂无法确认完整接收情况':showOther?'当前范围没有其他发送记录':'当前范围暂未收到通知'}</h3><p>${inbox.errors?.length?'恢复读取后刷新查看。':'平台产生模拟通知后，可在这里查看相应内容。'}</p></div>`}${['risk','punishment','plan_feedback','device_maintenance'].includes(tab)?`<div class="inbox-pagination"><button id="inbox-previous" ${inboxPage===1?'disabled':''}>上一页</button><span>第 ${inboxPage} 页</span><button id="inbox-next" ${!inbox.has_more?'disabled':''}>下一页</button></div>`:''}`;
}
function render(){
 const title=tabs[tab],draft=readDraft(),isInput=tab==='plans'||tab==='weather';
 const access=isInput?window.ExternalContract.unavailableNotice(context):'';
 const openRecords=[...document.querySelectorAll('details[data-record][open]')].map(node=>node.dataset.record);
 $('#external-access').textContent=access;$('#external-access').hidden=!access;
 $('#tab-title').textContent=title[0];$('#tab-intro').textContent=title[1];
 document.querySelectorAll('[data-tab]').forEach(el=>{el.classList.toggle('active',el.dataset.tab===tab);el.setAttribute('aria-current',el.dataset.tab===tab?'page':'false');});
 $('#external-body').innerHTML=!connected?'<div class="external-empty">请先登录本机测试系统，读取通知与业务资料。</div>':isInput?(!context?'<div class="external-empty">正在读取系统数据。</div>':buildInput()):buildOutput();
 const currentDraft=readDraft(),wanted=tab==='plans'?currentDraft.route_version_id:'';
 if(wanted&&[...($('#input-target')?.options||[])].some(option=>option.value===wanted))$('#input-target').value=wanted;
 if(tab==='plans'&&selectedScenePlanId&&[...($('#scene-plan-target')?.options||[])].some(option=>option.value===selectedScenePlanId))$('#scene-plan-target').value=selectedScenePlanId;
 document.querySelectorAll('details[data-record]').forEach(node=>{node.open=openRecords.includes(node.dataset.record);});
}
async function submit(body,path,key){if(busy)return;busy=true;document.querySelectorAll('button').forEach(button=>{if(button.id==='submit-input')button.disabled=true;});try{const result=await backend('POST',path,body,key);message(window.ExternalContract.submitResultText(path,result)||'系统已返回结果：'+stateText(result)+'。请查看下方记录和业务页面。');if(tab==='plans'&&editingPlan&&path.endsWith('/filing')){drafts.plans=JSON.stringify({...body,message_id:id(),expected_version:result.result.version},null,2);}await refreshAfterWrite();}catch(error){message(error.message+(connected?'；如为版本冲突，请重新读取计划资料后重试。':''),true);if(connected)await refreshAfterWrite();}finally{busy=false;render();}}
async function refreshAfterWrite(){if(!connected)return;const serial=++requestSerial;try{const next=await backend('GET','/local-interface-simulator/context');if(serial===requestSerial)context=next;}catch(error){message(error.message,true);}}
$('#login-toggle').addEventListener('click',()=>$('#login-dialog').showModal());$('#login-cancel').addEventListener('click',()=>$('#login-dialog').close());
$('#login-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;$('#login-error').textContent='';try{requestSerial++;const result=await call('connect',Object.fromEntries(new FormData(form)));setConnection(result);form.querySelector('[name=password]').value='';$('#login-dialog').close();message('已登录系统。');await refreshAfterWrite();render();}catch(error){$('#login-error').textContent=error.message;}finally{busy=false;button.disabled=false;if(connected)refresh();}});
$('#refresh').addEventListener('click',()=>{message('');status();});document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.tab)));
$('#external-body').addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||busy)return;
 if(button.id==='draw-plan-route'){
  window.parent?.postMessage({type:'simulator-plan-draw',id:selectedScenePlanId||null},location.origin);return;
 }
 if(button.dataset.editPlan||button.id==='load-plan-filing'){loadPlanFiling(button.dataset.editPlan||$('#existing-plan')?.value);return;}
 if(button.id==='cancel-plan-edit'){editingPlan=null;drafts.plans=createPlanDraft||'';createPlanDraft=null;render();return;}
 if(button.id==='new-sample'){
  const target=$('#input-target')?.value;
  const row=tab==='plans'?(context?.routes||[]).find(item=>item.route_version_id===target):null;
  try{drafts[tab]=JSON.stringify(tab==='plans'?samplePlan(row):sampleWeather(),null,2);if(tab==='plans')syncScenePlanDraft();render();}
  catch(error){message(error.message,true);}return;
 }
 if(button.id==='sync-preview'){
  try{syncInputFields();render();message('所选资料与消息编号已写入报文。');}
  catch(error){message('报文不是有效 JSON：'+error.message,true);}return;
 }
 if(button.id==='submit-input'){
  let data;try{data=syncInputFields();}catch(error){message('报文不是有效 JSON：'+error.message,true);return;}
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(data.message_id||'')){message('请填写有效的模拟消息编号。',true);return;}
  if(tab==='weather'){try{window.WeatherForm.validate(data);}catch(error){message(error.message,true);return;}}
  if(tab==='plans'){try{window.PlanForm.validate(data,{requireWindow:!editingPlan});}catch(error){message(error.message,true);return;}}
  submit(data,tab==='plans'?(editingPlan?'/local-interface-simulator/plans/'+encodeURIComponent(editingPlan.plan_id)+'/filing':'/local-interface-simulator/plans'):'/local-interface-simulator/weather',data.message_id);return;
 }
 if(button.id==='weather-add-period'||button.hasAttribute('data-weather-remove')){
  try{const data=JSON.parse(drafts.weather);if(button.id==='weather-add-period'){if(data.periods.length>=48)return;const last=data.periods.at(-1);data.periods.push({...last,from:last.to,to:last.to+3600000});}else data.periods.splice(Number(button.dataset.weatherRemove),1);drafts.weather=JSON.stringify(data,null,2);$('#payload-editor').value=drafts.weather;weatherFieldsChanged();}catch(error){message('请先修正接口报文：'+error.message,true);}return;
 }
 if(button.dataset.inboxFilter){showOther=button.dataset.inboxFilter==='other';render();return;}
 if(button.id==='inbox-next'||button.id==='inbox-previous'){inboxPage+=button.id==='inbox-next'?1:-1;requestSerial++;inbox=null;render();refresh();}

});
$('#external-body').addEventListener('input',event=>{
 const target=event.target;
 if(target.dataset.planField){try{const key=target.dataset.planField,value=['start_at','end_at'].includes(key)?(target.value?window.WeatherForm.timestamp(target.value):null):target.value;const data=window.PlanForm.update(JSON.parse(drafts.plans),key,value,planOptions||{});drafts.plans=JSON.stringify(data,null,2);$('#payload-editor').value=drafts.plans;if(target.tagName==='SELECT')planFieldsChanged();}catch(error){message(error.message,true);}return;}
 if(target.dataset.weatherField){try{const data=window.WeatherForm.update(JSON.parse(drafts.weather),target.dataset.weatherField,target.dataset.period,target.value);drafts.weather=JSON.stringify(data,null,2);$('#payload-editor').value=drafts.weather;$('#weather-coverage').textContent=window.WeatherForm.coverage(data);}catch(error){message(error.message,true);}return;}
 if(target.id==='payload-editor'){
  drafts[tab]=target.value;
  try{const data=JSON.parse(target.value),field=tab==='plans'?'route_version_id':'plan_id';
   if(typeof data.message_id==='string'&&$('#input-message-id'))$('#input-message-id').value=data.message_id;
   if(data[field]&&[...($('#input-target')?.options||[])].some(option=>option.value===data[field]))$('#input-target').value=data[field];
  }catch{}return;
 }
 if(target.id==='input-message-id'){
  try{syncInputFields();}catch{message('请先修正 JSON 报文，再修改消息编号。',true);}
 }
});
$('#external-body').addEventListener('change',event=>{
 if(event.target.id==='payload-editor'){weatherFieldsChanged();planFieldsChanged();if(tab==='plans')render();}
 if(event.target.id==='scene-plan-target'){
  selectedScenePlanId=event.target.value;
  try{syncScenePlanDraft({replaceSiteNames:true,replaceWindow:true});render();message(selectedScenePlanId?'已将地图计划的起降点和航线几何写入上级计划报文；计划时间可继续修改。':'已取消地图计划关联。');}catch(error){message(error.message,true);}
  return;
 }
 if(event.target.id==='input-target'){
  try{syncInputFields();if(tab==='plans')syncScenePlanDraft();weatherFieldsChanged();if(tab==='plans')render();message('已将选择写入报文。');}catch{message('请先修正 JSON 报文，再更改关联资料。',true);}
 }
});
if(typeof window.addEventListener==='function')window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='simulator-plan-drafts')return;
 const hasSelectedId=Object.prototype.hasOwnProperty.call(event.data,'selected_id');
 const selectedId=typeof event.data.selected_id==='string'?event.data.selected_id:'';
 const previousSelectedScenePlanId=selectedScenePlanId;
 scenePlans=Array.isArray(event.data.plans)?event.data.plans.filter(plan=>plan&&typeof plan.id==='string'&&Array.isArray(plan.points)&&plan.points.length>=2):[];
 if(hasSelectedId)selectedScenePlanId=selectedId&&scenePlans.some(plan=>plan.id===selectedId)?selectedId:'';
 else if(!scenePlans.some(plan=>plan.id===selectedScenePlanId))selectedScenePlanId=scenePlans.length===1?scenePlans[0].id:'';
 if(tab==='plans'&&!editingPlan&&selectedScenePlanId)syncScenePlanDraft({replaceSiteNames:previousSelectedScenePlanId!==selectedScenePlanId,replaceWindow:previousSelectedScenePlanId!==selectedScenePlanId});
 if(tab==='plans')render();
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)status();});refreshTimer=setInterval(()=>{if(!document.hidden)status();},3000);status();
