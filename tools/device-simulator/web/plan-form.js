'use strict';
(function(root){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names=[['operator_name','申报单位名称'],['pilot_name','申报飞手姓名'],['takeoff_site_name','起飞点名称'],['landing_site_name','降落点名称']];
 // Carried by the 上级 task (D-2); ignored by the platform when the matching archive is selected.
 const carried=[['pilot_phone','飞手手机号',64,'pilot_contact_id','已选执行飞手档案，平台用档案'],['reporting_org_code','报送单位编码',64,'source_binding_id','已选报送单位关联，平台用关联'],['reporting_org_name','报送单位名称',128,'source_binding_id','已选报送单位关联，平台用关联']];
 const coords=[['takeoff_longitude','起飞经度',-180,180],['takeoff_latitude','起飞纬度',-90,90],['landing_longitude','降落经度',-180,180],['landing_latitude','降落纬度',-90,90]];
 function scenePlanWindow(plan,now=Date.now()){
  if(!plan||typeof plan.start!=='string'||typeof plan.end!=='string'||!/^\d{2}:\d{2}$/.test(plan.start)||!/^\d{2}:\d{2}$/.test(plan.end))return null;
  const day=new Date(now+8*3600000).toISOString().slice(0,10);
  const start=Date.parse(`${day}T${plan.start}:00+08:00`),end=Date.parse(`${day}T${plan.end}:00+08:00`);
  if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  return {start_at:start,end_at:end>start?end:end+86400000};
 }
 function scenePlanLabel(plan){return plan?.name||'未命名地图任务';}
 function formatSceneTime(value){return typeof value==='string'&&/^\d{2}:\d{2}$/.test(value)?value:'未设置';}
 function applyScenePlan(data,plan,now=Date.now(),options={}){
  const next=structuredClone(data||{});next.filing={...(next.filing||{})};
  if(!plan||!Array.isArray(plan.points)||plan.points.length<2)return next;
  const first=plan.points[0],last=plan.points[plan.points.length-1];
  if(Array.isArray(first)&&Number.isFinite(Number(first[0]))&&Number.isFinite(Number(first[1]))){next.filing.takeoff_longitude=Number(first[0]);next.filing.takeoff_latitude=Number(first[1]);}
  if(Array.isArray(last)&&Number.isFinite(Number(last[0]))&&Number.isFinite(Number(last[1]))){next.filing.landing_longitude=Number(last[0]);next.filing.landing_latitude=Number(last[1]);}
  const label=scenePlanLabel(plan);if(options.replaceSiteNames||!next.filing.takeoff_site_name)next.filing.takeoff_site_name=label+'起点';if(options.replaceSiteNames||!next.filing.landing_site_name)next.filing.landing_site_name=label+'终点';
  const window=scenePlanWindow(plan,now),start=Number(next.start_at),end=Number(next.end_at),hasWindow=Number.isFinite(start)&&start>0&&Number.isFinite(end)&&end>0;if(window&&(!hasWindow||options.replaceWindow)){next.start_at=window.start_at;next.end_at=window.end_at;}
  return next;
 }
 function select(key,label,value,rows,id,name){return `<label>${esc(label)}<select data-plan-field="${key}" aria-label="${esc(label)}"><option value="">请选择</option>${value&&!rows.some(r=>r[id]===value)?`<option value="${esc(value)}" selected>原关联（当前不可选）</option>`:''}${rows.map(r=>`<option value="${esc(r[id])}" ${r[id]===value?'selected':''}>${esc(r[name])}</option>`).join('')}</select></label>`;}
 function fields(data,catalog={}){
  const f=data.filing||{},orgs=catalog.organizations||[],pilots=(catalog.pilots||[]).filter(p=>p.org_id===f.operator_org_id),bindings=(catalog.source_bindings||[]).filter(b=>b.source_id===f.source_id),scenePlan=catalog.scene_plan;
  const routeCard=scenePlan?`<section class="plan-route-card"><div><span class="plan-route-kicker">地图任务航线（本次报文航线）</span><strong>${esc(scenePlanLabel(scenePlan))}</strong><small>任务飞行时间（北京时间）：${esc(formatSceneTime(scenePlan.start))}—${esc(formatSceneTime(scenePlan.end))} · ${scenePlan.points.length} 个航点</small></div><button type="button" id="draw-plan-route">返回地图编辑航线</button></section>`:`<section class="plan-route-card empty"><div><span class="plan-route-kicker">地图任务航线</span><strong>尚未选择地图任务</strong><small>请选择地图任务，或在接口报文中提供完整航线几何。</small></div><button type="button" id="draw-plan-route">去地图绘制任务航线</button></section>`;
  const coordsLocked=scenePlan?' readonly':'';
  return `${routeCard}<div class="external-grid">${select('source_id','任务来源',f.source_id,catalog.plan_sources||[],'source_id','source_name')}${select('source_binding_id','报送单位关联',f.source_binding_id,bindings,'binding_id','org_name')}${select('operator_org_id','报备单位档案（可选）',f.operator_org_id,orgs,'id','label')}${select('pilot_contact_id','执行飞手档案（可选）',f.pilot_contact_id,pilots,'contact_id','name')}${names.map(([key,label])=>`<label>${label}<input data-plan-field="${key}" aria-label="${label}" maxlength="128" value="${esc(f[key])}" placeholder="填写本次申报资料"></label>`).join('')}${carried.map(([key,label,max,archive,note])=>`<label>${label}<input data-plan-field="${key}" aria-label="${label}" maxlength="${max}" value="${esc(f[key])}" ${f[archive]?`disabled title="${note}"`:'placeholder="上级任务带来的资料"'}></label>`).join('')}${coords.map(([key,label,min,max])=>`<label>${label}（WGS-84）<input data-plan-field="${key}" aria-label="${label}" type="number" step="any" min="${min}" max="${max}" value="${esc(f[key])}"${coordsLocked}></label>`).join('')}</div><p>${scenePlan?'地图任务带入起降点和航线几何；任务时间可在上方直接修改，系统接收后保存航线版本，不与既有航线匹配。':'请选择地图任务，或在接口报文中提供完整航线几何；系统接收任务后保存航线版本。'}没选执行飞手档案时，平台按飞手手机号找或建飞手档案；没选报送单位关联时，按报送单位编码找或建报送单位，再和任务关联（新建的档案写明随上级任务下发）。这几项都不填时只保存申报名称，关联状态保留为待关联。</p>`;
 }
 function update(data,key,value,catalog={}){
  const next=structuredClone(data);next.filing={...(next.filing||{})};
  if(['uav_sn','start_at','end_at'].includes(key)){next[key]=value;return next;}
  next.filing[key]=coords.some(c=>c[0]===key)?(value===''?null:Number(value)):(value||null);
  if(key==='source_id')next.filing.source_binding_id=null;
  if(key==='operator_org_id'){next.filing.pilot_contact_id=null;if(!next.filing.operator_name)next.filing.operator_name=(catalog.organizations||[]).find(o=>o.id===value)?.label||'';}
  if(key==='pilot_contact_id'&&!next.filing.pilot_name)next.filing.pilot_name=(catalog.pilots||[]).find(p=>p.contact_id===value)?.name||'';
  return next;
 }
 function validate(data,options={}){
  const f=data.filing;
  if(!f||typeof f!=='object'||Array.isArray(f))throw Error('请填写任务申报资料');
  if(options.requireWindow!==false&&(!Number.isFinite(Number(data.start_at))||Number(data.start_at)<=0||!Number.isFinite(Number(data.end_at))||Number(data.end_at)<=Number(data.start_at)))throw Error('请填写有效的任务飞行时间');
  const route=data.route&&typeof data.route==='object'&&!Array.isArray(data.route)?data.route:null;
  if(route&&(!route.owner_org_id||!route.district_id))throw Error('请选择航线归属单位与区县；没有可选项时，请先在后台给当前账号分配单位与区县的数据范围');
  if(!f.source_id)throw Error('请选择任务来源；没有可选来源时请先在后台配置模拟或回放来源');
  for(const [key,label] of names)if(typeof f[key]!=='string'||!f[key].trim()||f[key].length>128)throw Error(`请填写${label}（最多 128 字）`);
  if(f.pilot_phone!=null&&f.pilot_phone!==''&&(typeof f.pilot_phone!=='string'||!/^[+0-9 ()-]{6,64}$/.test(f.pilot_phone)))throw Error('飞手手机号格式不正确（6–64 位，只能有数字、空格、横线、括号和 +）');
  for(const [key,label,max] of carried.slice(1))if(f[key]!=null&&f[key]!==''&&(typeof f[key]!=='string'||f[key].length>max))throw Error(`${label}最多 ${max} 个字`);
  if(!f.source_binding_id&&f.reporting_org_name&&!f.reporting_org_code)throw Error('填了报送单位名称，还要填报送单位编码，平台按编码找报送单位');
  for(const prefix of ['takeoff','landing'])if((f[prefix+'_longitude']==null)!=(f[prefix+'_latitude']==null))throw Error('起降点经纬度必须成对填写');
  for(const [key,label,min,max] of coords)if(f[key]!=null&&(!Number.isFinite(f[key])||f[key]<min||f[key]>max))throw Error(`${label}超出 WGS-84 范围`);
  return data;
 }
 function fromDetail(result,messageId){const p=result.plan,s=result.subjects||{};return {message_id:messageId,expected_version:p.version,filing:{...(p.filing||{}),source_id:p.source?.source_id||null,source_binding_id:s.source_binding_id||null,operator_org_id:s.operator_org_id||null,pilot_contact_id:s.pilot_contact_id||null}};}
 const api={fields,update,validate,fromDetail,scenePlanWindow,applyScenePlan};root.PlanForm=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
