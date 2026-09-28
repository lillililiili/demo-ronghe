'use strict';
(function(root){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names=[['operator_name','申报单位名称'],['pilot_name','申报飞手姓名'],['takeoff_site_name','起飞点名称'],['landing_site_name','降落点名称']];
 const coords=[['takeoff_longitude','起飞经度',-180,180],['takeoff_latitude','起飞纬度',-90,90],['landing_longitude','降落经度',-180,180],['landing_latitude','降落纬度',-90,90]];
 function select(key,label,value,rows,id,name){return `<label>${esc(label)}<select data-plan-field="${key}" aria-label="${esc(label)}"><option value="">请选择</option>${value&&!rows.some(r=>r[id]===value)?`<option value="${esc(value)}" selected>原关联（当前不可选）</option>`:''}${rows.map(r=>`<option value="${esc(r[id])}" ${r[id]===value?'selected':''}>${esc(r[name])}</option>`).join('')}</select></label>`;}
 function fields(data,catalog={}){
  const f=data.filing||{},orgs=catalog.organizations||[],pilots=(catalog.pilots||[]).filter(p=>p.org_id===f.operator_org_id),bindings=(catalog.source_bindings||[]).filter(b=>b.source_id===f.source_id);
  return `<div class="external-grid">${select('source_id','计划来源',f.source_id,catalog.plan_sources||[],'source_id','source_name')}${select('source_binding_id','报送单位关联',f.source_binding_id,bindings,'binding_id','org_name')}${select('operator_org_id','报备单位档案（可选）',f.operator_org_id,orgs,'id','label')}${select('pilot_contact_id','执行飞手档案（可选）',f.pilot_contact_id,pilots,'contact_id','name')}${names.map(([key,label])=>`<label>${label}<input data-plan-field="${key}" aria-label="${label}" maxlength="128" value="${esc(f[key])}" placeholder="填写本次申报资料"></label>`).join('')}${coords.map(([key,label,min,max])=>`<label>${label}（WGS-84）<input data-plan-field="${key}" aria-label="${label}" type="number" step="any" min="${min}" max="${max}" value="${esc(f[key])}"></label>`).join('')}</div><p>经纬度按起飞点、降落点分别成对填写。档案选项由后台单位机构维护；无对应档案时可先保存申报名称，关联状态保留为待关联。</p>`;
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
 function validate(data){
  const f=data.filing;
  if(!f||typeof f!=='object'||Array.isArray(f))throw Error('请填写计划申报资料');
  if(!f.source_id)throw Error('请选择计划来源；没有可选来源时请先在后台配置模拟或回放来源');
  for(const [key,label] of names)if(typeof f[key]!=='string'||!f[key].trim()||f[key].length>128)throw Error(`请填写${label}（最多 128 字）`);
  for(const prefix of ['takeoff','landing'])if((f[prefix+'_longitude']==null)!=(f[prefix+'_latitude']==null))throw Error('起降点经纬度必须成对填写');
  for(const [key,label,min,max] of coords)if(f[key]!=null&&(!Number.isFinite(f[key])||f[key]<min||f[key]>max))throw Error(`${label}超出 WGS-84 范围`);
  return data;
 }
 function fromDetail(result,messageId){const p=result.plan,s=result.subjects||{};return {message_id:messageId,expected_version:p.version,filing:{...(p.filing||{}),source_id:p.source?.source_id||null,source_binding_id:s.source_binding_id||null,operator_org_id:s.operator_org_id||null,pilot_contact_id:s.pilot_contact_id||null}};}
 const api={fields,update,validate,fromDetail};root.PlanForm=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
