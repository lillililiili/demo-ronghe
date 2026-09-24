'use strict';
const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const image = (kind, cls = '') => `<img class="${cls}" src="assets/${kind}.svg" alt="">`;
const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
const types = [
  {id:'zone',name:'进入限飞区域',group:'无人机',icon:'uav'},
  {id:'deviation',name:'偏离计划路线',group:'无人机',icon:'uav'},
  {id:'no-plan',name:'无匹配飞行计划',group:'无人机',icon:'uav'},
  {id:'height',name:'超高飞行',group:'无人机',icon:'uav'},
  {id:'time',name:'超出计划时段',group:'无人机',icon:'uav'},
  {id:'bird',name:'鸟群进入航线',group:'空中异物',icon:'bird'},
  {id:'balloon',name:'气球靠近航线',group:'空中异物',icon:'balloon'},
  {id:'offline',name:'设备离线',group:'设备',icon:'tdoa'},
  {id:'fault',name:'设备故障',group:'设备',icon:'radar'}
];
const riskIcons={zone:'area',deviation:'route','no-plan':'document',height:'height',time:'clock',bird:'bird',balloon:'balloon',offline:'offline',fault:'fault'};
const labels={uav:'无人机',bird:'鸟群',balloon:'气球',radar:'雷达',tdoa:'TDOA',rid:'Remote ID',weather:'气象设备','5ga':'5G-A',eo:'光电'};
const deviceKinds=['weather','5ga','eo','tdoa','radar'];
function deviceSummary(items){return [...new Set([...deviceKinds,...items.map(d=>d.kind)])].map(kind=>({kind,count:items.filter(d=>d.kind===kind).length})).filter(x=>x.count).map(x=>`${labels[x.kind]} × ${x.count}`).join(' · ');}
function createDevice(kind,queued=[]){const used=new Set([...devices(),...queued].filter(d=>d.kind===kind).map(d=>d.name));let number=1;while(used.has(`${labels[kind]} ${String(number).padStart(2,'0')}`))number++;return {id:uid('d'),kind,name:`${labels[kind]} ${String(number).padStart(2,'0')}`,health:'正常',heartbeat:'持续上报',interval:5};}
const initial = {
  version:1,name:'东营低空风险联调',duration:10,
  sites:[{id:'s1',name:'点位 A',x:250,y:310,devices:[{id:'d1',kind:'5ga',name:'5G-A 01',health:'正常',heartbeat:'持续上报',interval:5},{id:'d2',kind:'tdoa',name:'TDOA 01',health:'正常',heartbeat:'持续上报',interval:5},{id:'d5',kind:'radar',name:'雷达 01',health:'正常',heartbeat:'持续上报',interval:5}]},{id:'s2',name:'点位 B',x:827,y:526,devices:[{id:'d3',kind:'eo',name:'光电 01',health:'正常',heartbeat:'持续上报',interval:5},{id:'d4',kind:'weather',name:'气象设备 01',health:'正常',heartbeat:'持续上报',interval:5}]}],
  plans:[{id:'p1',name:'巡检计划 01',points:[[260,470],[361,429],[475,419],[611,402],[729,368],[825,318]],min:20,max:120,width:100,start:'09:00',end:'09:30'}],
  zones:[{id:'z1',name:'限飞区域 A',points:[[660,180],[728,64],[891,117],[933,241],[882,332],[718,299]],max:120,start:'08:00',end:'18:00'}],
  targets:[{id:'t1',kind:'uav',name:'无人机 01',path:[[630,214],[711,232],[758,232],[798,288],[857,285]],height:150,speed:8,count:1,planId:'p1',deviceId:'d1'},
    {id:'t2',kind:'uav',name:'无人机 02',path:[[361,429],[475,419],[550,446],[610,475],[652,518]],height:90,speed:8,count:1,planId:'p1',deviceId:'d1'},
    {id:'t3',kind:'uav',name:'无人机 03',path:[[112,209],[192,185],[251,211],[311,225]],height:80,speed:6,count:1,planId:'',deviceId:'d1'},
    {id:'t4',kind:'bird',name:'鸟群 01',path:[[338,381],[377,436],[446,454],[509,449]],height:60,speed:6,count:20,planId:'p1',deviceId:'d1'},
    {id:'t5',kind:'balloon',name:'气球 01',path:[[848,399],[882,418],[933,410]],height:55,speed:2,count:1,planId:'p1',deviceId:'d1'}],
  risks:types.map((t,i)=>({id:`r${i+1}`,type:t.id,name:t.name,enabled:i===5,targetId:['t1','t2','t3','t1','t2','t4','t5','',''][i],planId:['','p1','','','p1','p1','p1','',''][i],zoneId:['z1','','','z1','','','','',''][i],deviceId:i===7?'d2':'d1',basis:'zone',height:150,mode:'结束后继续飞行',offset:2,at:2,seconds:60}))
};
let state=structuredClone(initial), selected={kind:'risk',id:'r6'}, filter='全部', draw=null, zoom=1, progress=0, timer=null, dialogType=null, returnFocus=null, toastTimer;
const storeKey='dongying-mqtt-simulator-v1';
let liveState=null, showRunPositions=false, restoredDraft=false;
try {const s=JSON.parse(localStorage.getItem(storeKey));if(s?.version===1 && ['sites','plans','zones','targets','risks'].every(k=>Array.isArray(s[k]))){state=s;restoredDraft=true;$('#save-status').textContent='已恢复本地草稿';selected={kind:'risk',id:state.risks[0]?.id};}} catch {$('#save-status').textContent='本地草稿无法读取，使用示例场景';}
$('#scene-name').value=state.name;$('#duration').value=state.duration;
const devices = () => state.sites.flatMap(s=>s.devices.map(d=>({...d,siteId:s.id,siteName:s.name})));
const lookup = (kind,id) => (kind==='site'?state.sites:kind==='target'?state.targets:kind==='plan'?state.plans:kind==='zone'?state.zones:state.risks).find(x=>x.id===id);
const getType = id => types.find(t=>t.id===id);
const targetFor = risk => state.targets.find(t=>t.id===risk?.targetId);
const deviceFor = id => devices().find(d=>d.id===id);
const riskObjects = r => {
  if(getType(r.type)?.group==='设备'){const d=deviceFor(r.deviceId);return d?`${d.siteName} · ${d.name}`:'请选择模拟设备';}
  const t=targetFor(r), related=(r.type==='zone'||r.type==='height'&&r.basis!=='plan')?lookup('zone',r.zoneId):r.type==='no-plan'?null:lookup('plan',r.planId);
  return `${t?.name||'未关联目标'}${related?' → '+related.name:r.type==='no-plan'?' · 不关联计划':''}`;
};
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3800);}
function dirty(){showRunPositions=false; $('#save-status').textContent='本地草稿有未保存修改'; }
function field(label,name,value,type='text',extra=''){return `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;}
function selectField(label,name,value,options){return `<label class="field"><span>${esc(label)}</span><select name="${name}">${options.map(o=>{const v=typeof o==='string'?o:o.value;return `<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(typeof o==='string'?o:o.label)}</option>`;}).join('')}</select></label>`;}
const opts = (items,empty) => [...(empty?[{value:'',label:empty}]:[]),...items.map(x=>({value:x.id,label:x.name}))];
const btn = (action,text,cls='') => `<button type="button" class="${cls}" data-action="${action}">${text}</button>`;
function row(kind,item,icon,sub=''){return `<button class="object-row ${selected.kind===kind&&selected.id===item.id?'active':''}" data-action="select" data-kind="${kind}" data-id="${item.id}">${image(icon)}<span class="object-text"><strong>${esc(item.name)}</strong>${sub?`<small>${esc(sub)}</small>`:''}</span></button>`;}
function renderTree(){
  const groups=[['设备组',state.sites.map(s=>row('site',s,s.devices[0]?.kind||'radar',deviceSummary(s.devices))),state.sites.length],['飞行计划',state.plans.map(p=>row('plan',p,'route','计划航线 · 模拟配套')),state.plans.length],['模拟目标',state.targets.map(t=>row('target',t,t.kind,labels[t.kind])),state.targets.length],['限飞区域',state.zones.map(z=>row('zone',z,'area','模拟区域')),state.zones.length]];
  $('#object-tree').innerHTML=groups.map(([title,rows,n],i)=>`<section data-object-group="${['site','plan','target','zone'][i]}"><div class="group-title">${title}<small>${n}</small></div>${rows.join('')}</section>`).join('');
}
function label(x,y,text){const w=Math.max(80,text.length*13+20);return `<g class="map-label" transform="translate(${x},${y})"><rect x="${-w/2}" y="0" width="${w}" height="28" rx="4"/><text text-anchor="middle" y="19">${esc(text)}</text></g>`;}
function marker(kind,id,icon,x,y,name,active,offset=0){return `<g class="map-marker" data-action="select" data-kind="${kind}" data-id="${id}" tabindex="0" role="button" aria-label="选择${esc(name)}"><circle cx="${x}" cy="${y}" r="27" fill="transparent"/>${active?`<circle cx="${x}" cy="${y}" r="24" fill="#23cce815" stroke="#66e9ff" stroke-width="2"/>`:''}<image href="assets/${icon}.svg" x="${x-19+offset}" y="${y-20}" width="38" height="38"/>${label(x,y+24,name)}</g>`;}
function siteMarker(site){const kinds=[...new Set(site.devices.map(d=>d.kind))],width=Math.max(52,kinds.length*35+12),active=selected.kind==='site'&&selected.id===site.id;return `<g class="map-marker" data-action="select" data-kind="site" data-id="${site.id}" tabindex="0" role="button" aria-label="选择${esc(site.name)} · ${site.devices.length} 台设备"><rect x="${site.x-width/2}" y="${site.y-28}" width="${width}" height="56" rx="8" fill="transparent"/>${active?`<path d="M${site.x-width/2} ${site.y+20}h${width}" stroke="#68e6ff" stroke-width="2"/>`:''}${kinds.map((kind,i)=>`<image href="assets/${kind}.svg" x="${site.x+(i-(kinds.length-1)/2)*35-17}" y="${site.y-20}" width="34" height="34"/>`).join('')}${label(site.x,site.y+24,`${site.name} · ${site.devices.length} 台设备`)}</g>`;}
function position(t){if(showRunPositions&&liveState?.positions?.[t.id]&&['RUNNING','PAUSED','STOPPING','COMPLETED','STOPPED','FAILED'].includes(liveState.phase))return liveState.positions[t.id];const path=t.path;if(!path.length)return [500,325];if(path.length===1)return path[0];const segs=path.slice(1).map((p,i)=>Math.hypot(p[0]-path[i][0],p[1]-path[i][1]));const total=segs.reduce((a,b)=>a+b,0);const included=state.risks.some(r=>r.enabled&&r.targetId===t.id);let dist=total*(included?progress:0)/100;for(let i=0;i<segs.length;i++){if(dist<=segs[i]||i===segs.length-1){const u=segs[i]?dist/segs[i]:0;return [path[i][0]+u*(path[i+1][0]-path[i][0]),path[i][1]+u*(path[i+1][1]-path[i][1])];}dist-=segs[i];}return path[0];}
function activeTarget(){return selected.kind==='target'?selected.id:selected.kind==='risk'?lookup('risk',selected.id)?.targetId:null;}
function scenePoints(){return [...state.sites.map(s=>[s.x,s.y]),...state.plans.flatMap(p=>p.points),...state.zones.flatMap(z=>z.points),...state.targets.flatMap(t=>[...t.path,...(t.departurePath||[])])];}
function renderMap(){
  const map=window.SimulatorMap;
  if(!map?.ready){$('#map-layers').innerHTML='';$('#draw-layer').innerHTML='';return;}
  const project=p=>map.project(p), points=items=>items.map(project), attr=items=>items.map(p=>p.join(',')).join(' ');
  let svg='';
  state.zones.forEach(z=>{const ps=points(z.points);svg+=`<polygon class="map-geometry" data-action="select" data-kind="zone" data-id="${z.id}" points="${attr(ps)}" fill="#e5ad432b" stroke="#efb849" stroke-width="2.5"/>`;const p=ps[1]||ps[0];if(p)svg+=label(p[0]+20,p[1]+35,z.name);});
  state.plans.forEach(p=>{const ps=points(p.points);svg+=`<polyline class="map-geometry" data-action="select" data-kind="plan" data-id="${p.id}" points="${attr(ps)}" fill="none" stroke="#b4c3d5" stroke-width="3" stroke-dasharray="10 7"/>`;svg+=ps.map(([x,y])=>`<circle cx="${x}" cy="${y}" r="4" fill="#285076" stroke="#e5f3ff" stroke-width="1.5"/>`).join('');const q=ps[Math.floor(ps.length/2)];if(q)svg+=label(q[0],q[1]-40,p.name);});
  state.targets.forEach(t=>{const ps=points(t.path),color=t.kind==='bird'?'#41ddbf':t.kind==='balloon'?'#c797ff':'#39dafa';svg+=`<polyline class="map-geometry" data-action="select" data-kind="target" data-id="${t.id}" points="${attr(ps)}" fill="none" stroke="${color}" stroke-width="2.5"/>`;svg+=ps.map(([x,y])=>`<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="#b6f5ff" stroke-width="1.4"/>`).join('');});
  const departing=state.targets.find(t=>t.id===activeTarget());
  if(departing?.departurePath?.length){const ps=points(departing.departurePath);svg+=`<polyline points="${attr(ps)}" fill="none" stroke="#c1a2ff" stroke-width="2.5" stroke-dasharray="5 5"/>`+ps.map(([x,y])=>`<circle cx="${x}" cy="${y}" r="4" fill="#c1a2ff"/>`).join('');const last=ps.at(-1);svg+=label(last[0],last[1]+25,'撤离航线（预设）');}
  state.sites.forEach(s=>{const [x,y]=project([s.x,s.y]);svg+=siteMarker({...s,x,y});});
  state.targets.forEach(t=>{const p=project(position(t));svg+=marker('target',t.id,t.kind,p[0],p[1],t.name,activeTarget()===t.id);});
  $('#map-layers').innerHTML=svg;
  const drawn=points(draw?.points||[]);
  $('#draw-layer').innerHTML=drawn.length?`<polyline points="${attr(drawn)}" fill="none" stroke="${draw.mode==='zone'?'#ffd470':'#71e9ff'}" stroke-width="3" stroke-dasharray="6 4"/>${drawn.map(([x,y])=>`<circle cx="${x}" cy="${y}" r="5" fill="#e1faff"/>`).join('')}`:'';
}
window.addEventListener('simulator-map:render',renderMap);
window.addEventListener('simulator-map:ready',()=>{window.SimulatorMap.fit(scenePoints());renderMap();});

function renderRisks(){
  $('#risk-count').textContent=`${state.risks.length}`;
  $('#risk-enabled-count').textContent=`本次启用 ${state.risks.filter(r=>r.enabled).length} 项`;
  $('#risk-filters').innerHTML=['全部','无人机','空中异物','设备'].map(g=>`<button class="${filter===g?'active':''}" data-action="filter" data-filter="${g}">${g} ${state.risks.filter(r=>g==='全部'||getType(r.type).group===g).length}</button>`).join('');
  const rows=state.risks.filter(r=>filter==='全部'||getType(r.type).group===filter);
  $('#risk-list').innerHTML=rows.length?rows.map(r=>`<article class="risk-card ${selected.kind==='risk'&&selected.id===r.id?'active':''}"><input type="checkbox" aria-label="本次预演包含${esc(r.name)}" data-risk-toggle="${r.id}" ${r.enabled?'checked':''}>${image(getType(r.type).icon)}<button class="risk-select" data-action="select" data-kind="risk" data-id="${r.id}"><strong>${esc(r.name)}</strong><small>${esc(riskObjects(r))}</small></button><button class="risk-remove" data-action="remove-risk" data-id="${r.id}" aria-label="移除${esc(r.name)}">移除</button></article>`).join(''):'<div class="empty">当前分类没有风险场景<br>点击“添加风险”配置一个场景</div>';
}
function riskFields(r){
  const type=getType(r.type),t=targetFor(r),dev=type.group==='设备';let html=field('风险名称','name',r.name,'text','required maxlength="60"');
  if(dev){html+=selectField('关联设备','deviceId',r.deviceId,opts(devices(),'请选择模拟设备'));html+=field('任务开始后触发（秒）','at',r.at??2,'number','min="0" max="1200" required');html+=field('持续时间（秒）','seconds',r.seconds??60,'number','min="1" max="1200" required');html+=r.type==='offline'?'<div class="readout">停止该设备心跳。实际离线状态以系统超时判定为准；离线期间暂停该设备全部上报。</div>':selectField('模拟工作状态','fault','故障',['故障'])+'<p class="field-note">雷达、TDOA、5G-A 使用协议 workState=2；光电故障码未确认，启动时会阻止该组合。</p>';return html;}
  const kind=type.group==='无人机'?'uav':r.type;
  html+=selectField('关联目标','targetId',r.targetId,opts(state.targets.filter(x=>x.kind===kind),'请选择目标'));
  if(r.type==='height')html+=selectField('比较依据','basis',r.basis||'zone',[{value:'zone',label:'空域限高'},{value:'plan',label:'计划高度'}]);
  if(r.type==='zone'||r.type==='height'&&r.basis!=='plan')html+=selectField('关联区域','zoneId',r.zoneId,opts(state.zones,'请选择限飞区域'));
  if(['deviation','time','bird','balloon'].includes(r.type)||r.type==='height'&&r.basis==='plan')html+=selectField('关联飞行计划','planId',r.planId,opts(state.plans,'请选择飞行计划'));
  if(r.type==='no-plan')html+='<div class="readout">本场景不关联飞行计划。联调后的匹配结果由平台返回。</div>';
  html+=selectField('上报设备','deviceId',r.deviceId||t?.deviceId,opts(devices(),'请选择模拟设备'));
  if(r.type==='height'){const b=r.basis==='plan'?lookup('plan',r.planId):lookup('zone',r.zoneId);html+=`<div class="readout">${r.basis==='plan'?'计划高度上限':'区域限高'}　<strong>${b?esc(b.max)+' m':'未选择'}</strong><br>高度基准　海拔高度</div>`;html+=field('模拟高度（米，协议原值）','height',r.height??150,'number','min="0" max="10000" required');}
  if(['bird','balloon'].includes(r.type)){html+='<div class="field-grid">'+field(r.type==='bird'?'鸟群数量（只）':'气球数量（个）','count',t?.count??1,'number','min="1" max="10000" required')+field('观测高度（米，协议原值）','height',t?.height??60,'number','min="0" max="10000" required')+'</div><div class="readout">平台高度基准尚未确认，以实际研判为准</div>';}
  if(r.type==='time'){html+=selectField('时间场景','mode',r.mode||'结束后继续飞行',['开始前提前飞行','结束后继续飞行']);html+=field('超出时长（分钟）','offset',r.offset??2,'number','min="1" max="1440" required');const p=lookup('plan',r.planId);html+=`<div class="readout">计划时段：${p?`${esc(p.start)}—${esc(p.end)}`:'未选择计划'}<br>示例业务时区：Asia/Shanghai</div>`;}
  if(['deviation','zone','bird','balloon'].includes(r.type))html+=`<button type="button" class="wide cyan-button" data-action="edit-risk-path" data-target="${esc(r.targetId)}">在地图上编辑轨迹</button>`;
  return html;
}
function context(icon,title,sub){return `<div class="inspector-context">${image(icon)}<div><h3>${esc(title)}</h3><p>${esc(sub)}</p></div></div>`;}
function renderInspector(){
  const x=lookup(selected.kind,selected.id);if(!x){$('#inspector-title').textContent='对象属性';$('#inspector').innerHTML='<div class="empty">选择地图对象或风险场景<br>在这里编辑参数</div>';return;}
  let html='';$('#inspector-title').textContent=x.name;
  if(selected.kind==='risk'){html=riskFields(x);}
  if(selected.kind==='site'){
    html=context(x.devices[0]?.kind||'radar',x.name,`${x.devices.length} 台模拟设备`)+field('设备组名称','name',x.name,'text','required maxlength="60"');
    html+='<div class="field-grid">'+field('经度（WGS84）','lon',(118.56+x.x*.00012).toFixed(6),'number','step="0.000001" min="-180" max="180" required')+field('纬度（WGS84）','lat',(37.50-x.y*.00012).toFixed(6),'number','step="0.000001" min="-85" max="85" required')+'</div>';
    html+=btn('relocate-site','在地图上重新定位','wide cyan-button')+'<div class="subheading">该点位的设备（气象 MQTT 待接入）</div>';
    x.devices.forEach(d=>{html+=`<h3 style="margin:12px 0">${esc(d.name)}</h3>`+selectField('工作状态',`health_${d.id}`,d.health,['正常','故障'])+selectField('心跳模式',`heartbeat_${d.id}`,d.heartbeat,['持续上报','停止心跳'])+field('心跳间隔（秒）',`interval_${d.id}`,d.interval,'number','min="1" max="300" required');});
    html+='<div class="subheading">添加一台设备</div>'+selectField('设备类型','newKind',deviceKinds[0],deviceKinds.map(v=>({value:v,label:labels[v]})))+btn('add-device','添加到此点位','wide');
  }
  if(selected.kind==='target')html=context(x.kind,x.name,'模拟目标')+field('目标名称','name',x.name,'text','required maxlength="60"')+selectField('上报设备','deviceId',x.deviceId,opts(devices(),'请选择上报设备'))+selectField('关联计划','planId',x.planId,opts(state.plans,'不关联计划'))+'<div class="field-grid">'+field('高度（米，协议原值）','height',x.height,'number','min="0" max="10000" required')+field('速度（米/秒）','speed',x.speed,'number','min="0" max="100" required')+'</div>'+(x.kind==='uav'?'':field(x.kind==='bird'?'数量（只）':'数量（个）','count',x.count,'number','min="1" max="10000" required'))+btn('edit-target-path','在地图上编辑轨迹','wide cyan-button')+`<p class="field-note">当前轨迹包含 ${x.path.length} 个观测点。实际 MQTT 运行按速度推进，轨迹终点保持停留。</p>`;
  if(selected.kind==='target')html+=selectField('辅助上报设备','secondaryDeviceId',x.secondaryDeviceId||'',opts(devices().filter(d=>['radar','tdoa','5ga'].includes(d.kind)&&d.id!==x.deviceId),'不使用辅助设备'))+'<div class="field-grid">'+field('模拟离地高度（米，可留空）','heightAgl',x.heightAgl??'','number','min="0" max="10000" step="0.1"')+field('模拟识别概率（0—1，可留空）','probability',x.probability??'','number','min="0" max="1" step="0.01"')+'</div>';
  if(selected.kind==='target')html+=window.NotificationUI.fields(x);
  if(['plan','zone'].includes(selected.kind)){
    html=field(selected.kind==='plan'?'计划名称':'区域名称','name',x.name,'text','required maxlength="60"')+'<div class="field-grid">'+field('开始时间','start',x.start,'time','required')+field('结束时间','end',x.end,'time','required')+'</div><p class="field-note">示例时区：Asia/Shanghai。日期与真实生效范围待联调接口接入。</p>';
    if(selected.kind==='plan')html+='<div class="field-grid">'+field('最低高度（米）','min',x.min,'number','min="0" required')+field('最高高度（米）','max',x.max,'number','min="0" max="10000" required')+'</div>'+field('走廊宽度（米）','width',x.width,'number','min="1" required');else html+=field('区域限高（米）','max',x.max,'number','min="0" max="10000" required');
    html+=selectField('计划或区域高度基准','altitudeDatum',x.altitudeDatum||'AMSL',[{value:'AMSL',label:'海拔高度 AMSL'},{value:'AGL',label:'离地高度 AGL'}]);
    html+='<div class="readout">与目标同基准高度比较；缺失时由系统保留未知</div>'+btn('redraw-object',selected.kind==='plan'?'重新绘制航线':'重新绘制区域','wide cyan-button');
  }
  $('#inspector').innerHTML=`<section id="notification-progress" class="notification-progress" hidden></section><form id="inspector-form">${html}<p class="inline-error" role="alert"></p><div class="form-actions"><button type="submit" class="primary">${selected.kind==='risk'?'保存风险设置':'应用设置'}</button></div></form>`;
  window.NotificationUI.estimate();window.NotificationUI.progress();window.NotificationUI.lock();
}
function render(){renderTree();renderMap();renderRisks();renderInspector();$('#totals').textContent=`${state.sites.length} 个点位 · ${devices().length} 台设备 · ${state.targets.length} 个目标`;}
function stop(){clearInterval(timer);timer=null;$('#run-status').textContent='编辑中';$('#stop-button').disabled=true;$('#preview-button').textContent='本地预演';}
function select(kind,id){window.dispatchEvent(new CustomEvent('simulator:selection',{detail:{kind}}));if(!(typeof running==='function'&&running()))stop();selected={kind,id};const object=lookup(kind,id);const target=kind==='risk'?targetFor(object):null;const ps=kind==='site'?[[object.x,object.y]]:object?.points||object?.path||target?.path;render();if(ps?.length)window.SimulatorMap?.fit(ps);}
function openDialog(title,html){returnFocus=document.activeElement;$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;$('#dialog-shell').hidden=false;document.body.style.overflow='hidden';$('#dialog button').focus();}
function closeDialog(){ $('#dialog-shell').hidden=true;document.body.style.overflow='';dialogType=null;returnFocus?.focus(); }
function defaultRisk(type){const t=state.targets.find(t=>t.kind===(getType(type).group==='无人机'?'uav':type)&&(type!=='no-plan'||!t.planId));return {id:uid('r'),type,name:getType(type).name,enabled:true,targetId:t?.id||'',planId:['deviation','time','bird','balloon'].includes(type)?state.plans[0]?.id||'':'',zoneId:['zone','height'].includes(type)?state.zones[0]?.id||'':'',deviceId:devices()[0]?.id||'',basis:'zone',height:150,at:2,seconds:60,offset:2};}
let newRisk;
function openDeviceGroup(group){
  stop();const config=group||{name:`设备组 ${state.sites.length+1}`,counts:Object.fromEntries(deviceKinds.map(kind=>[kind,1]))};
  if(draw)cancelDraw();
  openDialog('放置设备组',`<p class="group-intro">选择设备与数量，再点击地图放下整组。同一个位置可以放置多种设备。</p><form id="device-group-form">${field('设备组名称','groupName',config.name,'text','required maxlength="40"')}<div class="group-table-heading"><span>设备类型</span><span>数量</span></div><div class="device-options">${deviceKinds.map(kind=>`<div class="device-option ${config.counts[kind]?'chosen':''}" data-device-option="${kind}"><label class="device-choice"><input type="checkbox" name="include_${kind}" ${config.counts[kind]?'checked':''}>${image(kind)}<span>${labels[kind]}</span></label><label class="device-quantity"><span class="sr-only">${labels[kind]}数量</span><input type="number" name="qty_${kind}" min="1" max="20" step="1" value="${config.counts[kind]||1}" ${config.counts[kind]?'':'disabled'} required><span>台</span></label></div>`).join('')}</div><div class="group-summary"><span class="muted">待放置设备</span><strong id="group-summary-count"></strong><p id="group-summary-types"></p></div><p class="field-note">只选择一种设备、数量设为 1，即可放置单台。</p><p class="inline-error" role="alert"></p><div class="form-actions">${btn('close-dialog','取消')}<button type="submit" class="primary" id="place-device-group">在地图上放置</button></div></form>`);
  dialogType='devices';updateDeviceGroupSummary();
}
function groupFormConfig(){const f=$('#device-group-form');return {name:$('[name=groupName]',f).value.trim(),counts:Object.fromEntries(deviceKinds.map(kind=>[kind,$(`[name=include_${kind}]`,f).checked?Number($(`[name=qty_${kind}]`,f).value):0]))};}
function updateDeviceGroupSummary(){const f=$('#device-group-form');if(!f)return;deviceKinds.forEach(kind=>{const checked=$(`[name=include_${kind}]`,f).checked;$(`[name=qty_${kind}]`,f).disabled=!checked;$(`[data-device-option="${kind}"]`,f).classList.toggle('chosen',checked);});const config=groupFormConfig(),valid=deviceKinds.every(k=>Number.isInteger(config.counts[k])&&config.counts[k]>=0&&config.counts[k]<=20),total=Object.values(config.counts).reduce((a,b)=>a+b,0);$('#group-summary-count').textContent=valid?`${total} 台设备`:'请填写有效数量';$('#group-summary-types').textContent=deviceKinds.filter(k=>config.counts[k]>0).map(k=>`${labels[k]} × ${config.counts[k]}`).join(' · ')||'选择至少一种设备';$('#place-device-group').textContent=valid&&total?`在地图上放置（${total} 台）`:'在地图上放置';}
function openRisk(type='height',draft){newRisk=draft||defaultRisk(type);dialogType='risk';openDialog('添加风险',`<h3>选择风险类型</h3><div class="type-grid">${types.map(t=>`<button class="type-tile ${type===t.id?'active':''}" data-action="risk-type" data-type="${t.id}">${image(riskIcons[t.id])}${t.name}</button>`).join('')}</div><form id="new-risk-form" class="drawer-form"><h3>${getType(type).name}设置</h3><div id="new-risk-fields">${riskFields(newRisk)}</div><p class="inline-error" role="alert"></p><div class="form-actions">${btn('close-dialog','取消')}<button class="primary" type="submit">添加到场景</button></div></form>`);dialogType='risk';}
function setDraw(mode,id=null,targetKind=null,group=null){if(!window.SimulatorMap?.ready)return toast('请先加载系统地图，再放置或绘制对象');stop();closeDialog();draw={mode,id,targetKind,group,points:[]};if(mode==='path'&&id)draw.points=[...lookup('target',id).path.slice(0,1)];$('#map-stage').classList.add('drawing');$('#map-hint').textContent=mode==='site'?'点击地图，设置整组设备所在位置':mode==='target'?'点击地图，设置目标初始位置':'依次点击地图添加节点，完成后确认绘制';$('#draw-controls').hidden=['site','target'].includes(mode);$('#draw-message').textContent=mode==='zone'?'至少绘制 3 个顶点':mode==='departure'?'至少绘制 1 个撤离航点':'至少绘制 2 个节点';$('#group-placement').hidden=mode!=='site';if(mode==='site'){$('#group-placement-text').textContent=group?`${group.name} · ${Object.values(group.counts).reduce((a,b)=>a+b,0)} 台设备`:`重新定位 ${lookup('site',id)?.name||'设备组'}`;$('#edit-pending-group').hidden=!group;}document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===mode));renderMap();}
function cancelDraw(){draw=null;$('#map-stage').classList.remove('drawing');$('#draw-controls').hidden=true;$('#group-placement').hidden=true;$('#map-hint').textContent='选择地图对象，编辑位置与关联';document.querySelectorAll('[data-tool]').forEach(b=>b.classList.remove('active'));renderMap();}
function intersects(a,b,c,d){const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);return cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;}
function validPolygon(points){let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];area+=a[0]*b[1]-b[0]*a[1];for(let j=i+2;j<points.length;j++){if(i===0&&j===points.length-1)continue;if(intersects(a,b,points[j],points[(j+1)%points.length]))return false;}}return Math.abs(area)>20;}
function finishDraw(){if(!draw)return;const n=draw.mode==='zone'?3:draw.mode==='departure'?1:2;if(draw.points.length<n)return toast(`请至少设置 ${n} 个节点`);if(draw.mode==='zone'&&!validPolygon(draw.points))return toast('区域边界不能自交或退化为直线，请调整顶点');let x;if(draw.mode==='departure'){x=lookup('target',draw.id);x.departurePath=draw.points;selected={kind:'target',id:x.id};}else if(draw.mode==='path'){x=lookup('target',draw.id);x.path=draw.points;selected={kind:'target',id:x.id};}else if(draw.mode==='plan'){x=draw.id?lookup('plan',draw.id):{id:uid('p'),name:`巡检计划 ${state.plans.length+1}`,min:20,max:120,width:100,start:'09:00',end:'09:30'};x.points=draw.points;if(!draw.id)state.plans.push(x);selected={kind:'plan',id:x.id};}else{x=draw.id?lookup('zone',draw.id):{id:uid('z'),name:`限飞区域 ${state.zones.length+1}`,max:120,start:'08:00',end:'18:00'};x.points=draw.points;if(!draw.id)state.zones.push(x);selected={kind:'zone',id:x.id};}dirty();cancelDraw();render();toast('绘制已应用到本地草稿');}
function formValues(form){return Object.fromEntries(new FormData(form));}
function validateRisk(r){const t=getType(r.type);if(!r.name?.trim())return '请输入风险名称';if(!deviceFor(r.deviceId))return '请选择关联的模拟设备';if(t.group!=='设备'&&!targetFor(r))return '请选择关联目标';if(r.type==='no-plan'&&targetFor(r)?.planId)return '该目标已关联计划，请选择未关联计划的目标';if(['zone','height'].includes(r.type)&&r.basis!=='plan'&&!lookup('zone',r.zoneId))return '请选择关联区域';if(['deviation','time','bird','balloon'].includes(r.type)||r.type==='height'&&r.basis==='plan'){if(!lookup('plan',r.planId))return '请选择关联飞行计划';}if(r.type==='height'){const base=r.basis==='plan'?lookup('plan',r.planId):lookup('zone',r.zoneId);if(Number(r.height)<=Number(base.max))return '超高场景的模拟高度应大于所选依据的高度上限';}if(t.group==='设备'&&Number(r.at)+Number(r.seconds)>Number(state.duration)*60)return '触发时间与持续时间不能超过任务运行时长';return '';}
function saveRiskFields(r,v){Object.assign(r,v);if(r.type==='height'){if(r.basis==='plan')r.zoneId='';else r.planId='';}if(r.type==='no-plan'){r.planId='';r.zoneId='';}const t=targetFor(r);if(t){t.deviceId=r.deviceId;if(['bird','balloon'].includes(r.type)){t.height=Number(v.height);t.count=Number(v.count);}if(r.type==='height')t.height=Number(v.height);}}
document.addEventListener('submit',event=>{
  if(event.target.id==='device-group-form'){event.preventDefault();const group=groupFormConfig(),counts=Object.values(group.counts),error=$('.inline-error',event.target);if(!counts.some(n=>n>0)){error.textContent='请至少选择一种设备';return;}if(!group.name){error.textContent='请输入设备组名称';return;}if(counts.some(n=>!Number.isInteger(n)||n<0||n>20)){error.textContent='每种设备数量须为 1 至 20 的整数';return;}setDraw('site',null,null,group);return;}
  if(!['inspector-form','new-risk-form'].includes(event.target.id))return;
  if(typeof running==='function'&&running()){event.preventDefault();return;}event.preventDefault();const form=event.target,v=formValues(form),error=$('.inline-error',form);error.textContent='';
  if(form.id==='new-risk-form'||selected.kind==='risk'){const r=form.id==='new-risk-form'?newRisk:lookup('risk',selected.id),candidate={...r,...v};const message=validateRisk(candidate);if(message){error.textContent=message;return;}saveRiskFields(r,v);if(form.id==='new-risk-form'){state.risks.push(r);selected={kind:'risk',id:r.id};filter='全部';closeDialog();}dirty();render();toast('风险配置已保存到本地草稿');return;}
  const x=lookup(selected.kind,selected.id);if(!x)return;
  if(['plan','zone'].includes(selected.kind)&&v.start>=v.end){error.textContent='结束时间须晚于开始时间';return;}
  if(selected.kind==='plan'&&Number(v.min)>Number(v.max)){error.textContent='最低高度不能超过最高高度';return;}
  if(selected.kind==='target'&&['after_sms','after_voice'].includes(v.notificationBehavior)&&(!x.departurePath?.length||!(Number(v.departureSpeed)>0))){error.textContent='请先绘制撤离航线，并填写大于 0 的撤离速度';return;}
  if(selected.kind==='site'){x.name=v.name;x.x=(Number(v.lon)-118.56)/.00012;x.y=(37.50-Number(v.lat))/.00012;x.devices.forEach(d=>{d.health=v[`health_${d.id}`];d.heartbeat=v[`heartbeat_${d.id}`];d.interval=Number(v[`interval_${d.id}`]);});}else Object.assign(x,v);
  dirty();render();toast('设置已应用到本地草稿');
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.closest('#device-group-form')){updateDeviceGroupSummary();$('.inline-error',el.form).textContent='';return;}
  if(el.id==='scene-name'){state.name=el.value.trim()||'未命名场景';dirty();}
  if(el.id==='duration'){state.duration=Number(el.value);dirty();}
  if(el.dataset.riskToggle){lookup('risk',el.dataset.riskToggle).enabled=el.checked;dirty();$('#risk-enabled-count').textContent=`本次启用 ${state.risks.filter(r=>r.enabled).length} 项`;}
  if(['basis','targetId','zoneId','planId'].includes(el.name)&&el.closest('#new-risk-form')){Object.assign(newRisk,formValues(el.form));$('#new-risk-fields').innerHTML=riskFields(newRisk);}
  if(['basis','targetId','zoneId','planId'].includes(el.name)&&el.closest('#inspector-form')&&selected.kind==='risk'){const r=lookup('risk',selected.id);Object.assign(r,formValues(el.form));dirty();renderInspector();renderRisks();renderMap();}
});
document.addEventListener('input',event=>{if(event.target.closest('#device-group-form'))updateDeviceGroupSummary();});
$('#preview-range').addEventListener('input',e=>{progress=Number(e.target.value);$('#preview-percent').textContent=`${Math.round(progress)}%`;renderMap();});
window.addEventListener('simulator-map:point',event=>{
  if(!draw||!window.SimulatorMap?.ready)return;const [x,y]=event.detail;
  if(draw.mode==='site'){const relocating=!!draw.id,group=draw.group;if(!relocating&&!group)return;const s=relocating?lookup('site',draw.id):{id:uid('s'),name:group.name,devices:[]};s.x=x;s.y=y;if(!relocating){deviceKinds.forEach(kind=>{for(let i=0;i<group.counts[kind];i++)s.devices.push(createDevice(kind,s.devices));});state.sites.push(s);}selected={kind:'site',id:s.id};dirty();cancelDraw();render();toast(relocating?'整组设备已重新定位':`已放置 ${s.name}，共 ${s.devices.length} 台设备`);}
  else if(draw.mode==='target'){const kind=draw.targetKind,t={id:uid('t'),kind,name:`${labels[kind]} ${state.targets.filter(t=>t.kind===kind).length+1}`,path:[[x,y]],height:80,speed:6,count:kind==='bird'?20:1,planId:'',deviceId:devices()[0]?.id||''};state.targets.push(t);selected={kind:'target',id:t.id};dirty();cancelDraw();render();toast('目标已放置，可在右侧绘制模拟轨迹');}
  else {const last=draw.points.at(-1);if(!last||Math.hypot(...window.SimulatorMap.project([x,y]).map((n,i)=>n-window.SimulatorMap.project(last)[i]))>4)draw.points.push([x,y]);renderMap();}
});
function startPreview(){showRunPositions=false;
  if(timer){stop();toast('预演已暂停');return;}
  if(!state.risks.some(r=>r.enabled))return toast('请勾选至少一条要预演的风险场景');
  if(draw)return toast('请先完成或取消当前绘制');for(const r of state.risks.filter(r=>r.enabled)){const issue=validateRisk(r);if(issue)return toast(r.name+'：'+issue);}
  if(progress>=100)progress=0;$('#preview-bar').hidden=false;$('#run-status').textContent='本地预演中';$('#preview-button').textContent='暂停预演';$('#stop-button').disabled=false;
  timer=setInterval(()=>{progress=Math.min(100,progress+.25);$('#preview-range').value=progress;$('#preview-percent').textContent=`${Math.round(progress)}%`;renderMap();if(progress>=100){stop();toast('轨迹预演结束，模拟配套业务数据');}},100);
}
document.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');if(!el)return;const a=el.dataset.action;
  if(a==='select'){if(!draw)select(el.dataset.kind,el.dataset.id);return;}
  if(a==='filter'){filter=el.dataset.filter;renderRisks();return;}
  if(a==='add-risk'){stop();openRisk();return;}
  if(a==='risk-type'){openRisk(el.dataset.type);return;}
  if(a==='close-dialog'){closeDialog();return;}
  if(a==='remove-risk'){state.risks=state.risks.filter(r=>r.id!==el.dataset.id);dirty();render();toast('风险已移除，关联目标与航线保留');return;}
  if(a==='tool'){if(el.dataset.tool==='site')openDeviceGroup();else setDraw(el.dataset.tool);return;}
  if(a==='edit-pending-group'){if(draw?.group)openDeviceGroup(draw.group);return;}
  if(a==='undo-point'){draw?.points.pop();renderMap();return;}
  if(a==='cancel-draw'){cancelDraw();return;}
  if(a==='finish-draw'){finishDraw();return;}
  if(a==='add-target'){openDialog('添加模拟目标',`<p class="field-note">选择目标类别，再在地图上设置初始位置。</p><div class="type-grid">${['uav','bird','balloon'].map(k=>`<button class="type-tile" data-action="place-target" data-kind="${k}">${image(k)}${labels[k]}</button>`).join('')}</div>`);return;}
  if(a==='place-target'){setDraw('target',null,el.dataset.kind);return;}
  if(a==='relocate-site'){setDraw('site',selected.id);return;}
  if(a==='edit-departure-path'){const x=lookup('target',selected.id);Object.assign(x,formValues($('#inspector-form')));dirty();setDraw('departure',selected.id);return;}
  if(a==='edit-target-path'){setDraw('path',selected.id);return;}
  if(a==='edit-risk-path'){if(!el.dataset.target)return toast('请先选择关联目标');setDraw('path',el.dataset.target);return;}
  if(a==='redraw-object'){setDraw(selected.kind,selected.id);return;}
  if(a==='add-device'){const s=lookup('site',selected.id),k=$('[name=newKind]').value;s.devices.push(createDevice(k));dirty();render();toast('已在当前设备组添加一台模拟设备');return;}
  if(a.startsWith('zoom-')){if(a==='zoom-reset')window.SimulatorMap?.fit(scenePoints());else window.SimulatorMap?.zoom(a==='zoom-in'?1:-1);return;}
  if(a==='save'){state.name=$('#scene-name').value.trim()||'未命名场景';try{localStorage.setItem(storeKey,JSON.stringify(state));$('#save-status').textContent='已保存到此浏览器';toast('场景已保存到此浏览器，未写入业务系统');}catch{toast('本地存储不可用，当前草稿仍保留在页面中');}return;}
  if(a==='preview'){startPreview();return;}
  if(a==='stop'){stop();progress=0;$('#preview-bar').hidden=true;renderMap();toast('已停止本地预演');return;}
  if(a==='connection'||a==='integration'){openDialog(a==='connection'?'连接设置':'联调尚未接入','<div class="readout">当前为页面交互原型，尚未连接模拟服务。</div><p class="field-note">地图编辑、风险配置、浏览器本地保存与轨迹预演可以体验。真实设备注册、计划与区域配套、MQTT 发送及报警结果需要服务接口接入。</p><div class="form-actions">'+btn('close-dialog','返回编辑','primary')+'</div>');return;}
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){if(!$('#dialog-shell').hidden)closeDialog();else if(draw)cancelDraw();}
  if((event.key==='Enter'||event.key===' ')&&event.target.matches('.map-marker')){event.preventDefault();select(event.target.dataset.kind,event.target.dataset.id);}
  if(event.key==='Tab'&&!$('#dialog-shell').hidden){const focusable=[...$('#dialog').querySelectorAll('button,input,select')].filter(x=>!x.disabled);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
});
window.addEventListener('pagehide',()=>clearInterval(timer));
render();
