'use strict';
(function(root){
 const time=value=>{if(!value)return null;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))throw Error('时间格式无效');const ms=Date.parse(value+(value.length===16?':00':'')+'+08:00');if(!Number.isFinite(ms))throw Error('时间格式无效');return ms;};
 const local=value=>value==null?'':new Date(Number(value)+8*3600000).toISOString().slice(0,19);
 // Round upward so the displayed second remains strictly beyond the previous effective instant.
 const nextEffective=(item,now=Date.now())=>Math.ceil(Math.max(now,Number(item?.payload?.valid_from||item?.payload?.effective_at||0)+1000)/1000)*1000;
 function geometry(value){let g=typeof value==='string'?JSON.parse(value):value;if(g?.type==='Feature')g=g.geometry;if(g?.type==='FeatureCollection'){if(g.features?.length!==1)throw Error('请导入只包含一片空域的文件');g=g.features[0]?.geometry;}if(!['Polygon','MultiPolygon'].includes(g?.type))throw Error('边界必须为 Polygon 或 MultiPolygon');const polygons=g.type==='Polygon'?[g.coordinates]:g.coordinates;if(!Array.isArray(polygons)||!polygons.length)throw Error('边界不能为空');for(const rings of polygons){if(!Array.isArray(rings)||!rings.length)throw Error('边界不能为空');for(const ring of rings){if(!Array.isArray(ring)||ring.length<4)throw Error('边界环至少四点且闭合');for(const p of ring)if(!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>90)throw Error('边界必须使用有效 WGS84 经纬度');if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw Error('边界环必须闭合');}}return g;}
 function payload(values,scopes){const b={message_id:values.message_id.trim(),revision:Number(values.revision),action:values.action,airspace_no:values.airspace_no.trim(),change_reason:values.change_reason.trim()};if(!/^[A-Za-z0-9_-]{1,64}$/.test(b.message_id)||!Number.isSafeInteger(b.revision)||b.revision<1)throw Error('消息编号或修订次序无效');if(!b.airspace_no||!b.change_reason)throw Error('请填写空域编号与原因');if(b.action==='WITHDRAW'){b.effective_at=time(values.effective_at);if(!b.effective_at)throw Error('请选择撤销生效时间');return b;}if(b.action!=='UPSERT')throw Error('操作无效');if(!['PROHIBITED','RESTRICTED','ALTITUDE_LIMIT','PERMITTED','TEMPORARY_CONTROL'].includes(values.kind_code))throw Error('请先选择空域类型');const scope=values.scope!==''&&values.scope!=null?scopes[Number(values.scope)]:null;if(!scope)throw Error('请选择授权范围内的归属单位与区县');Object.assign(b,{name:values.name.trim(),kind_code:values.kind_code,boundary:geometry(values.boundary),min_altitude_m:values.min_altitude_m===''?null:Number(values.min_altitude_m),max_altitude_m:values.max_altitude_m===''?null:Number(values.max_altitude_m),altitude_datum:values.altitude_datum||null,valid_from:time(values.valid_from),valid_to:time(values.valid_to),owner_org_id:scope.owner_org_id,district_id:scope.district_id});if([b.min_altitude_m,b.max_altitude_m].some(v=>v!==null&&!Number.isFinite(v)))throw Error('高度必须为有效数字');if(b.min_altitude_m===null&&b.max_altitude_m===null)b.altitude_datum=null;else if(b.min_altitude_m===null||b.max_altitude_m===null||!b.altitude_datum)throw Error('填写高度时须同时填写最低、最高高度与高度基准');if(!b.name||!b.valid_from)throw Error('请填写名称与生效时间');if(b.valid_to!==null&&b.valid_to<=b.valid_from)throw Error('结束时间须晚于生效时间');if(b.min_altitude_m!==null&&b.max_altitude_m!==null&&b.min_altitude_m>b.max_altitude_m)throw Error('最低高度不得超过最高高度');return b;}
 // Key-order independent JSON, matching how the platform compares a resent message with the stored one.
 const canonical=value=>JSON.stringify(value,(key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const sameContent=(a,b)=>canonical(a)===canonical(b);
 const latestFor=(items,no)=>(Array.isArray(items)?items:[]).find(item=>item?.airspace_no===no)||null;
 // Same identity as fullchain.stable_airspace_no, so the form and the full-chain run update one airspace per map zone.
 async function stableAirspaceNo(zoneId,subtle=root.crypto?.subtle){const text=String(zoneId),value='sim-map-airspace-'+(text.replace(/[^A-Za-z0-9_-]/gu,'-').replace(/^[-_]+|[-_]+$/g,'')||'zone');if(value.length<=64)return value;const digest=[...new Uint8Array(await subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,10);return value.slice(0,64-digest.length-1)+'-'+digest;}
 // A zone already issued under another number (same name and boundary) keeps that number instead of becoming a second airspace.
 function zoneAirspaceNo(zone,items,stable){const list=Array.isArray(items)?items:[];if(list.some(item=>item?.airspace_no===stable))return stable;const match=list.find(item=>item?.action==='UPSERT'&&item.payload?.name===zone?.name&&sameContent(item.payload?.boundary,zone?.boundary));return match?match.airspace_no:stable;}
 const scopeIndex=(scopes,ref)=>{if(!ref?.owner_org_id||!ref?.district_id)return '';const index=(Array.isArray(scopes)?scopes:[]).findIndex(s=>s.owner_org_id===ref.owner_org_id&&s.district_id===ref.district_id);return index>=0?String(index):'';};
 // Updates must keep the airspace's owner; a new airspace follows the simulator connection's unit and district.
 function defaultScope(scopes,latest,connection){const list=Array.isArray(scopes)?scopes:[];return scopeIndex(list,latest?.payload)||scopeIndex(list,connection)||(list.length===1?'0':'');}
 // Reconcile one submission with the platform's latest receipts for this simulator source. Resending an accepted
 // message unchanged is a replay (the platform answers with the original receipt); anything else is a new delivery
 // and needs an unused message ID, a higher revision and an effective time after the previous one and not in the past.
 function prepareIssue(body,items,options={}){
  const list=Array.isArray(items)?items:[],latest=latestFor(list,body.airspace_no),next={...body},changes=[];
  if(latest&&latest.message_id===body.message_id&&sameContent(latest.payload,body))return {body:next,replay:true,changes};
  if(list.some(item=>item?.message_id===next.message_id)){next.message_id=options.id();changes.push('message_id');}
  if(!latest)return {body:next,replay:false,changes};
  const old=latest.payload||{};
  if(next.action==='WITHDRAW'&&latest.action==='WITHDRAW')throw Error('该空域已撤销，无需重复撤销；如需恢复，请切换为“新增或更新”后再下发');
  if(next.action==='UPSERT'&&latest.action==='UPSERT'&&(old.name!==next.name||old.owner_org_id!==next.owner_org_id||old.district_id!==next.district_id))throw Error('空域编号 '+next.airspace_no+' 已按“'+old.name+'”及原归属单位与区县下发；更新须保持原名称和归属，或改用新的空域编号');
  if(next.revision<=Number(latest.revision)){next.revision=Number(latest.revision)+1;changes.push('revision');}
  const key=next.action==='WITHDRAW'?'effective_at':'valid_from',earliest=nextEffective(latest,options.now??Date.now());
  if(next[key]<earliest){next[key]=earliest;changes.push(key);}
  if(next.action==='UPSERT'&&next.valid_to!==null&&next.valid_to<=next.valid_from)throw Error('结束时间须晚于生效时间；再次下发的生效时间不早于当前时间');
  return {body:next,replay:false,changes};
 }
 const api={time,local,nextEffective,geometry,payload,sameContent,latestFor,stableAirspaceNo,zoneAirspaceNo,scopeIndex,defaultScope,prepareIssue};if(typeof module!=='undefined')module.exports=api;else root.AirspaceForm=api;
})(globalThis);
