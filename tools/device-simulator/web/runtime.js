'use strict';
const phaseNames={IDLE:'未运行',PREPARING:'配套资料中',RUNNING:'MQTT 发送中',PAUSED:'已暂停发送',STOPPING:'正在停止',STOPPED:'已停止',COMPLETED:'运行完成',FAILED:'运行失败'};
let runtimeBusy=false, polling=false, displayedBatch=null;
const running=()=>['PREPARING','RUNNING','PAUSED','STOPPING'].includes(liveState?.phase);
async function api(path,body){
 const write=body!==undefined;
 const outcome=write?'本次操作结果未知，请恢复连接后核对运行记录，不要重复提交。':'';
 const options={method:write?'POST':'GET',headers:write?{'Content-Type':'application/json'}:{},body:write?JSON.stringify(body):undefined};
 let response;
 try{response=await fetch('/api/'+path,options);}
 catch{throw Error('模拟器服务未连接，请先启动本机模拟器服务（8766 端口）。'+outcome);}
 let data;
 try{data=await response.json();}
 catch{throw Error('模拟器响应无法读取，请检查服务状态。'+outcome);}
 if(!response.ok)throw Error(data?.error||'模拟器服务响应异常');
 return data;
}
function download(name,value){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function connectionForm(relogin=false){
 const authenticated=liveState?.connected&&!relogin;
 const account=liveState?.user?.name||liveState?.user?.account||'系统';
 openDialog(authenticated?'系统连接':'登录系统',`<p class="field-note">${authenticated?`已登录 ${esc(account)}`:'登录一次，即可使用信号地图、计划与气象输入和通知收件箱。'}</p><form id="mqtt-connect-form" data-login="${!authenticated}">${authenticated?'':`${field('系统 API 地址','api',liveState?.api||'http://127.0.0.1:8081/api/v1','url','required')}${field('系统账号','account',liveState?.user?.account||'','text','required autocomplete="username"')}${field('系统密码','password','','password','required autocomplete="current-password"')}`}${authenticated?`<details><summary>MQTT 连接设置</summary><p class="field-note">${liveState?.broker?esc(liveState.broker.name):'启动模拟时读取本机回放连接。'}</p>${field('MQTT 用户名（如需）','mqtt_user','')}${field('MQTT 密码（如需）','mqtt_password','','password','autocomplete="off"')}</details>`:''}<p class="inline-error" role="alert"></p><div class="form-actions">${btn('close-dialog','取消')}${authenticated?'<button type="button" id="switch-system-account">切换账号</button>':''}<button type="submit" class="primary">${authenticated?'保存 MQTT 设置':'登录系统'}</button></div></form>`);
 document.querySelector('#switch-system-account')?.addEventListener('click',()=>connectionForm(true));
}
function applyRuntime(data){if(data.batch&&data.batch!==displayedBatch&&data.scene?.version===1){const adopt=displayedBatch!==null||!restoredDraft||['PREPARING','RUNNING','PAUSED','STOPPING'].includes(data.phase);displayedBatch=data.batch;if(adopt){state=structuredClone(data.scene);showRunPositions=true;selected={kind:'site',id:state.sites[0]?.id};$('#scene-name').value=state.name;$('#duration').value=state.duration;render();window.SimulatorMap?.fit(scenePoints());}}liveState=data;$('#run-status').textContent=phaseNames[data.phase]||data.phase;document.querySelector('.connection').textContent=data.connected?`已登录 ${data.user?.name||data.user?.account||'系统'}`:'尚未登录系统';document.querySelector('[data-action=connection]').textContent=data.connected?'系统连接':'登录系统';const lock=running();document.querySelector('main').inert=false;window.NotificationUI.lock();window.NotificationUI.progress();$('#scene-name').disabled=lock;$('#duration').disabled=lock;$('#stop-button').disabled=!lock;document.querySelector('[data-action=integration]').disabled=lock;document.querySelector('[data-action=connection]').disabled=lock;$('#preview-button').disabled=lock;$('#pause-mqtt').hidden=!['RUNNING','PAUSED'].includes(data.phase);$('#pause-mqtt').textContent=data.phase==='PAUSED'?'继续发送':'暂停发送';$('#mqtt-summary').textContent=data.batch?`${phaseNames[data.phase]} · ${Math.floor(data.elapsed)} / ${Math.floor(data.duration)} 秒 · Broker 确认 ${data.sent} 条`:'未启动 MQTT 任务';$('#mqtt-error').textContent=data.error||'';renderMap();if(!$('#dialog-shell').hidden&&$('#runtime-log'))renderLog();}
function renderLog(){const data=liveState||{};const snap=data.snapshot||{};const fingerprint=JSON.stringify([data.logs?.length,data.logs?.at(-1)?.at,snap.at]);const log=document.querySelector("#runtime-log");if(log.dataset.fingerprint===fingerprint)return;log.dataset.fingerprint=fingerprint;if($('#readback-details'))$('#readback-details').innerHTML=(snap.targets||[]).map(t=>`<div class="readout">${esc(t.target_no||t.target_id)}<br>系统研判：${esc(({UNDETERMINED:'不可判定',LEGAL:'合法',ILLEGAL:'非法',ABNORMAL:'异常'})[t.legality_summary?.legal_status]||t.legality_summary?.legal_status||'尚无研判')}<br>观测时间：${new Date(t.last_seen_at).toLocaleString()}</div>`).join('');$('#runtime-log').innerHTML=(data.logs||[]).slice().reverse().map(l=>`<article class="mqtt-log"><b>${new Date(l.at).toLocaleTimeString()} · ${esc(l.message)}</b>${l.topic?`<code>${esc(l.topic)}</code><details><summary>查看报文</summary><pre>${esc(JSON.stringify(l.payload,null,2))}</pre></details>`:''}</article>`).join('')||'<p class="field-note">尚无发送记录</p>';$('#runtime-manifest').textContent=JSON.stringify(data.manifest||{},null,2);}
function showRuntime(){openDialog('运行记录与系统回读',`<div class="readout">Broker 确认表示 MQTT 已接收，不代表系统已产生目标或告警。暂停会停止所有上报，系统可能按超时判离线。</div><div class="runtime-actions">${btn('verify-system','回读系统结果','cyan-button')}${btn('export-run','导出本批次')}</div><div id="readback-result" class="readout">${liveState?.snapshot?.at?`最近回读：${new Date(liveState.snapshot.at).toLocaleString()}，本批次目标 ${liveState.snapshot.targets?.length||0} 个，告警 ${liveState.snapshot.alarms?.length||0} 条`:'尚未回读系统'}</div><details><summary>批次与系统关联编号</summary><pre id="runtime-manifest"></pre></details><div id="readback-details"></div><div id="runtime-log"></div>`);renderLog();}
const bar=document.createElement('div');bar.className='mqtt-bar';bar.innerHTML='<span id="mqtt-summary">未启动 MQTT 任务</span><span id="mqtt-error" role="alert"></span><button id="pause-mqtt" data-action="pause-mqtt" hidden>暂停发送</button><button data-action="runtime-log">运行记录</button><button data-action="load-demo">载入演示样本</button><button data-action="restore-draft">恢复载入前草稿</button><button data-action="export-scene">导出场景</button><button data-action="import-scene">导入场景</button><input id="scene-file" type="file" accept="application/json,.json" hidden>';
document.querySelector('footer').before(bar);
async function poll(){if(polling)return;polling=true;try{applyRuntime(await api('status'));}catch(error){$('#mqtt-error').textContent='模拟器连接中断，发送状态未知；请恢复连接确认任务状态';}finally{polling=false;}}
document.addEventListener('submit',async event=>{if(event.target.id!=='mqtt-connect-form')return;event.preventDefault();if(runtimeBusy)return;runtimeBusy=true;const form=event.target,submit=form.querySelector('[type=submit]');submit.disabled=true;try{const login=form.dataset.login==='true';const data=await api(login?'external/connect':'connect',formValues(form));form.reset();closeDialog();toast(login?'已登录，各页面共用当前账号':`MQTT 设置已保存：${data.name}`);await poll();}catch(error){$('.inline-error',form).textContent=error.message;}finally{runtimeBusy=false;submit.disabled=false;}},true);
document.addEventListener('click',async event=>{const el=event.target.closest('[data-action]');if(!el)return;const action=el.dataset.action;if(!['connection','integration','stop','pause-mqtt','runtime-log','export-scene','import-scene','verify-system','export-run','load-demo','restore-draft'].includes(action))return;event.preventDefault();event.stopImmediatePropagation();if(runtimeBusy)return;
 if(action==='connection'){connectionForm();return;}
 if(action==='runtime-log'){showRuntime();return;}
 if(action==='export-scene'){download('mqtt-scene.json',state);return;}
 if(action==='import-scene'){if(running())return toast('请先停止运行');$('#scene-file').click();return;}
 runtimeBusy=true;el.disabled=true;
 try{
  if(action==='load-demo'||action==='restore-draft'){
   if(running())throw Error('请先停止当前运行');
   let next;
   if(action==='load-demo'){
    const response=await fetch('/demo-samples.json',{cache:'no-store'});
    if(!response.ok)throw Error('演示样本读取失败');
    next=await response.json();
    if(state.name!==next.name)localStorage.setItem(storeKey+'-before-demo',JSON.stringify(state));
   }else{
    const saved=localStorage.getItem(storeKey+'-before-demo');
    if(!saved)throw Error('没有载入前的草稿');
    next=JSON.parse(saved);
   }
   stop();progress=0;showRunPositions=false;displayedBatch=liveState?.batch||displayedBatch;
   state=next;selected={kind:'risk',id:state.risks[0]?.id};filter='全部';
   $('#scene-name').value=state.name;$('#duration').value=state.duration;
   cancelDraw();dirty();render();window.SimulatorMap?.fit(scenePoints());
   toast(action==='load-demo'?'五组样本已载入，运行时长 15 分钟':'已恢复载入前草稿');
  }
  if(action==='integration'){if(!liveState?.connected){connectionForm();return;}if(draw)throw Error('请先完成或取消地图绘制');stop();state.name=$('#scene-name').value.trim()||'未命名场景';state.duration=Number($('#duration').value);applyRuntime(await api('start',state));toast('正在配套本批次资料，完成后开始 MQTT 发送');}
  if(action==='stop'){if(running())applyRuntime(await api('control',{action:'stop'}));else{stop();progress=0;$('#preview-bar').hidden=true;renderMap();}}
  if(action==='pause-mqtt')applyRuntime(await api('control',{action:liveState.phase==='PAUSED'?'resume':'pause'}));
  if(action==='verify-system'){const result=await api('verify',{});$('#readback-result').textContent=`系统回读：${result.devices.length} 台设备，${result.plans.length} 条计划，${result.zones.length} 个区域，本批次目标 ${result.targets.length} 个、研判 ${result.evaluations.length} 条、告警 ${result.alarms.length} 条。${result.read_errors.length?result.read_errors.join("；"):""}只核对最近 100 个候选目标；详细事实请导出查看。`;await poll();}
  if(action==='export-run')download((liveState?.batch||'mqtt-run')+'.json',await api('export'));
 }catch(error){toast(error.message);if(action==='verify-system')$('#readback-result').textContent=error.message;}finally{runtimeBusy=false;el.disabled=false;await poll();}
},true);
$('#scene-file').addEventListener('change',async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>2000000)throw Error('场景文件不能超过 2 MB');const next=JSON.parse(await file.text());if(next.version!==1||!['sites','plans','zones','targets','risks'].every(k=>Array.isArray(next[k])))throw Error('不是有效场景文件');if(!Number.isFinite(Number(next.duration))||Number(next.duration)<=0||Number(next.duration)>20)throw Error('缺少有效时长');for(const key of ['sites','plans','zones','targets','risks']){if(next[key].length>200||next[key].some(x=>!x||typeof x.id!=='string'||typeof x.name!=='string'))throw Error('场景对象格式错误');}if(next.sites.some(s=>!Array.isArray(s.devices)||s.devices.some(d=>!d||!labels[d.kind]&&d.kind!=='5da'||typeof d.id!=='string'||typeof d.name!=='string')))throw Error('设备数据格式错误');if(next.targets.some(t=>!Array.isArray(t.path)||!labels[t.kind])||next.plans.some(p=>!Array.isArray(p.points))||next.zones.some(z=>!Array.isArray(z.points))||next.risks.some(r=>!getType(r.type)))throw Error('轨迹、计划或风险格式错误');next.sites.forEach(s=>s.devices.forEach(d=>{if(d.kind==='5da'){d.kind='5ga';d.name=d.name.replace('5D-A','5G-A');}}));displayedBatch=liveState?.batch||displayedBatch;state=next;liveState=null;selected={kind:'site',id:state.sites[0]?.id};$('#scene-name').value=state.name;$('#duration').value=state.duration;cancelDraw();dirty();render();toast('场景已导入，请检查配置后启动');}catch(error){toast(error.message);}finally{e.target.value='';}});
poll();setInterval(poll,1500);
