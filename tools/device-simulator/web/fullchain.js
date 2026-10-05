(function(root){
 'use strict';
 const categories={uav:'无人机与完整轨迹',bird:'单鸟与鸟群',unknown:'未知类别',identifying:'识别中',balloon:'气球',person:'人员',vehicle:'车辆',ship:'船舶',remote_controller:'遥控器',weather:'气象实测、预报和预警',airspaces:'五类空域',device_faults:'设备异常'};
 const coverageText=row=>`已提交 ${row.submitted||0} · 接入确认 ${row.accepted||0} · ${row.processed==null?'平台处理待回读':`平台回读 ${row.processed}`} ${row.processed_label||''} ${row.last_at?'最近 '+new Date(row.last_at).toLocaleTimeString():''} ${Object.entries(row.related||{}).map(([k,v])=>`${k}: ${v}`).join(' / ')} ${row.error||''}`;
 if(typeof module!=='undefined'){module.exports={categories,coverageText};return;}
 const box=document.createElement('section');box.className='realtime-bar fullchain-bar';
 box.innerHTML='<div><strong>全量关联场景</strong><span>正常与异常同时展示</span></div><div class="realtime-actions"><button id="fullchain-load">配置全量场景</button><button id="fullchain-edit">完整资料与接口字段</button><button id="fullchain-start">一键启动全量场景</button><button id="fullchain-verify">回读平台数据</button></div><details><summary>数据覆盖与关联记录</summary><div id="fullchain-coverage">尚未运行全量场景</div></details>';
 document.querySelector('footer').before(box);
 let busy=false;
 function update(data){
  for(const id of ['fullchain-load','fullchain-edit','fullchain-start'])document.getElementById(id).disabled=busy||['PREPARING','RUNNING','PAUSED','STOPPING'].includes(data.phase);
  document.getElementById('fullchain-verify').disabled=busy||!data.connected||!Object.keys(data.manifest?.devices||{}).length;
  const c=data.coverage||{},rows=Object.entries(c.coverage||{});
  document.getElementById('fullchain-coverage').innerHTML=(c.warnings||[]).map(x=>`<p>${esc(x)}</p>`).join('')+`<p>MQTT Broker 确认 ${data.sent||0} 条；通知收到 ${data.realtime?.notifications?.received_count||0} 条；TCP 请求 ${data.realtime?.countermeasure?.received||0} 次</p>`+(rows.length?rows.map(([k,v])=>`<p><b>${esc(v.label||k)}</b>：${esc(coverageText(v))}</p>`).join(''):'<p>尚无本批次输入确认</p>');
 }
 function adopt(next){localStorage.setItem(storeKey+'-before-fullchain',JSON.stringify(state));state=next;selected={kind:'site',id:state.sites[0]?.id};syncSceneFields();dirty();render();window.SimulatorMap?.fit(scenePoints());}
 async function load(){
  const options=liveState?.connected?await api('external/request',{method:'GET',path:'/local-interface-simulator/plan-options'}):{};
  const pilots=options.pilots||[],bindings=options.source_bindings||[];
  openDialog('配置全量关联场景',`<form id="fullchain-form"><p>生成可编辑草稿，启动后通过实际接口提交并持续上报。</p><fieldset><legend>数据分类</legend>${Object.entries(categories).map(([k,v])=>`<label style="display:inline-flex;gap:6px;margin:8px"><input type="checkbox" name="category" value="${k}" checked>${esc(v)}</label>`).join('')}</fieldset><label class="field">执行飞手<select name="pilot"><option value="">未选择（通知可能阻断）</option>${pilots.map(p=>`<option value="${esc(p.contact_id)}">${esc(p.name)}</option>`).join('')}</select></label><label class="field">计划报送单位绑定<select name="binding"><option value="">未选择</option>${bindings.map(b=>`<option value="${esc(b.binding_id)}">${esc(b.org_name||b.external_org_code)}</option>`).join('')}</select></label><label class="field">通知回执策略<select name="policy"><option value="success">正常回执</option><option value="mixed">按请求轮流成功、失败、延迟、无回执</option></select></label><p>飞手与接收方资格仍由平台校验，资料不足显示阻断原因。</p><p class="inline-error"></p><div class="form-actions"><button type="submit" class="primary">生成完整草稿</button></div></form>`);
  document.getElementById('fullchain-form').addEventListener('submit',async event=>{
   event.preventDefault();const f=event.target;
   try{
    const next=await api('full-scene',{categories:[...f.querySelectorAll('[name=category]:checked')].map(n=>n.value)});
    const pilot=pilots.find(p=>p.contact_id===f.elements.pilot.value),binding=bindings.find(b=>b.binding_id===f.elements.binding.value);
    if(pilot)Object.assign(next.fullchain.filing,{pilot_contact_id:pilot.contact_id,pilot_name:pilot.name,operator_org_id:pilot.org_id});
    if(binding)Object.assign(next.fullchain.filing,{source_binding_id:binding.binding_id,source_id:binding.source_id});
    next.fullchain.notificationPolicy=f.elements.policy.value;adopt(next);closeDialog();toast('全量场景已生成，可调整对象后启动');
   }catch(error){f.querySelector('.inline-error').textContent=error.message;}
  });
 }
 function edit(){
  openDialog('完整资料与接口字段',`<form id="fullchain-json"><p>编辑设备、目标、航点高度、停留时长、停报窗口、计划、空域及 fullchain 配套资料。提交仍由服务端校验。</p><textarea name="payload" rows="20" style="width:100%;font-family:monospace">${esc(JSON.stringify(state,null,2))}</textarea><p class="inline-error"></p><div class="form-actions"><button type="submit" class="primary">保存草稿</button></div></form>`);
  document.getElementById('fullchain-json').addEventListener('submit',event=>{event.preventDefault();try{const next=JSON.parse(event.target.elements.payload.value);if(next.version!==1||!['sites','targets','plans','zones','risks'].every(k=>Array.isArray(next[k])))throw Error('不是完整场景');adopt(next);closeDialog();}catch(e){event.target.querySelector('.inline-error').textContent=e.message;}});
 }
 async function act(fn){if(busy)return;busy=true;try{await fn();}catch(e){toast(e.message);}finally{busy=false;await poll();}}
 document.getElementById('fullchain-load').onclick=()=>act(load);
 document.getElementById('fullchain-edit').onclick=edit;
 document.getElementById('fullchain-start').onclick=()=>act(async()=>{if(!liveState?.connected){connectionForm();return;}if(!state.fullchain?.enabled)adopt(await api('full-scene'));applyRuntime(await api('start',state));toast('已提交启动，正在准备资料与连接');});
 document.getElementById('fullchain-verify').onclick=()=>act(async()=>{const r=await api('verify',{});toast(`平台回读：${r.devices.length} 台设备、${r.targets.length} 个目标、${r.track_point_count||0} 个轨迹点；${(r.read_errors||[]).join('；')}`);});
 root.FullChainUI={update};
})(globalThis);
