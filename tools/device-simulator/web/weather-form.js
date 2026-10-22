'use strict';
(function(root){
  const specs=[['summary','天气','text'],['temperature_c','温度（℃）','number',-90,60],['wind_speed_ms','风速（米/秒）','number',0,150],['gust_ms','阵风（米/秒）','number',0,150],['wind_direction_deg','风向（度）','number',0,360],['precipitation_probability_pct','降水概率（%）','number',0,100],['humidity_pct','湿度（%）','number',0,100],['precipitation_rate_mm_h','降雨强度（毫米/小时，可不填）','number',0,1000]];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function localTime(ms){return Number.isFinite(Number(ms))&&Number(ms)>0?new Date(Number(ms)+8*3600000).toISOString().slice(0,19):'';}
  function timestamp(value){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))throw Error('请填写完整的北京时间');const n=Date.parse(value+'+08:00');if(!Number.isFinite(n))throw Error('时间无效');return n;}
  function control(key,label,value,type='text',index='',min,max){return `<label>${esc(label)}<input data-weather-field="${key}" data-period="${index}" aria-label="${esc(label)}${index!==''?' · 时段 '+(index+1):''}" type="${type}" value="${esc(type==='datetime-local'?localTime(value):value)}" ${type==='number'?`min="${min}" max="${max}" step="${['wind_direction_deg','precipitation_probability_pct','humidity_pct'].includes(key)?1:'any'}"`:type==='datetime-local'?'step="1"':'maxlength="128"'} ${key==='precipitation_rate_mm_h'?'':'required'}></label>`;}
  const isWgs84=value=>typeof value==='string'&&['WGS84','WGS-84'].includes(value.trim().toUpperCase());
  function assertCoordinateSystem(data,required=false){
    for(const key of ['coordinate_system','coordinateSystem'])if(Object.hasOwn(data||{},key)&&!isWgs84(data[key]))throw Error('预报范围仅支持 WGS-84；请先转换原始坐标，不能只修改坐标系名称');
    if(required&&!isWgs84(data?.coordinate_system))throw Error('预报范围缺少 WGS-84 坐标声明；请确认原始坐标后在接口报文中填写 coordinate_system，或清除范围后重新绘制');
  }
  function validatedPolygon(data){assertCoordinateSystem(data,data?.polygon!=null);return validatePolygon(data?.polygon);}
  function withMapPolygon(data,ring){
    assertCoordinateSystem(data);
    const polygon=validatePolygon(ring);if(!polygon)throw Error('地图未提供预报范围');
    return {...structuredClone(data),polygon:structuredClone(polygon),coordinate_system:'WGS84'};
  }
  function areaField(data){return control('area_name','预报区域',data?.area_name)+`<p class="external-note">地图绘制范围采用 WGS-84；导入范围须附坐标系声明，其他坐标系请先转换。当前声明：${esc(data?.coordinate_system??'未提供')}。</p>`;}
  function fields(data){if(!data||typeof data!=='object'||Array.isArray(data)||(data.periods!==undefined&&(!Array.isArray(data.periods)||data.periods.some(p=>!p||typeof p!=='object'||Array.isArray(p)))))return '<p class="external-note warn">报文结构无效，请展开接口报文修正预报时段。</p>';return `<div class="external-grid">${control('published_at','发布时间（北京时间）',data.published_at,'datetime-local')}</div><div class="weather-periods">${(Array.isArray(data.periods)?data.periods:[]).map((p,i)=>`<fieldset><legend>预报时段 ${i+1}</legend><div class="external-grid">${control('from','开始时间（北京时间）',p.from,'datetime-local',i)}${control('to','结束时间（北京时间）',p.to,'datetime-local',i)}${specs.map(([key,label,type,min,max])=>control(key,label,p[key],type,i,min,max)).join('')}</div>${data.periods.length>1?`<button type="button" data-weather-remove="${i}">移除此时段</button>`:''}</fieldset>`).join('')}</div><button type="button" id="weather-add-period" ${(data.periods?.length||0)>=48?'disabled':''}>增加预报时段</button>`;}
  function update(data,key,index,value){const next=structuredClone(data);const numeric=['published_at','from','to',...specs.filter(s=>s[2]==='number').map(s=>s[0])];let parsed=value;if(numeric.includes(key)){if(value==='')parsed=null;else parsed=['published_at','from','to'].includes(key)?timestamp(value):Number(value);}if(index==='')next[key]=parsed;else {if(!next.periods?.[Number(index)])throw Error('预报时段不存在');next.periods[Number(index)][key]=parsed;}return next;}
  function validate(data,now=Date.now()){
    if(typeof data.area_name!=='string'||!data.area_name.trim())throw Error('请填写预报区域');
    if(!Number.isFinite(data.published_at)||data.published_at<=0||data.published_at>now+30000)throw Error('预报发布时间须有效且不能在未来');
    if(!Array.isArray(data.periods)||!data.periods.length||data.periods.length>48)throw Error('请填写 1 至 48 个预报时段');
    validatedPolygon(data);
    let last=data.published_at;
    for(const [i,p] of data.periods.entries()){
      if(!p||typeof p!=='object'||Array.isArray(p))throw Error(`时段 ${i+1} 必须为对象`);
      if(!Number.isFinite(p.from)||!Number.isFinite(p.to)||p.from<last||p.to<=p.from||p.to-data.published_at>7*86400000)throw Error(`时段 ${i+1} 须有序、不重叠，且在发布时间后 7 天内`);
      for(const [key,label,type,min,max] of specs){if(key==='precipitation_rate_mm_h'&&p[key]==null)continue;if(type==='text'){if(typeof p[key]!=='string'||!p[key].trim()||p[key].length>128)throw Error(`请填写时段 ${i+1} 的${label}`);}else if(!Number.isFinite(p[key])||p[key]<min||p[key]>max||(['wind_direction_deg','precipitation_probability_pct','humidity_pct'].includes(key)&&!Number.isInteger(p[key])))throw Error(`时段 ${i+1} 的${label}须在 ${min}—${max} 之间${['wind_direction_deg','precipitation_probability_pct','humidity_pct'].includes(key)?'，且为整数':''}`);}
      last=p.to;
    }
    return data;
  }
  function coverage(data){
    const area=String(data?.area_name||'').trim();
    if(data?.polygon) return `预报区域：${area||'未填写'} · 模拟预报范围 ${data.polygon.length-1} 个顶点。平台按区域、范围及有效时段匹配任务；范围以本次提交的边界为准。`;
    return area
      ? `预报区域：${area}。提交后由平台系统按预报区域匹配受影响任务。边界未提供，不绘制范围。`
      : '请填写预报区域。提交后由平台系统按预报区域匹配受影响任务。边界未提供，不绘制范围。';
  }
  function validatePolygon(ring){
    if(ring==null)return null;
    if(!Array.isArray(ring)||ring.length<4||ring.length>1001)throw Error('预报范围须有3至1000个顶点并闭合');
    if(!ring.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=85.051129))throw Error('预报范围坐标无效');
    const n=ring.length-1,origin=ring[0],cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    if(origin.some((v,i)=>v!==ring[n][i]))throw Error('预报范围必须闭合');
    const on=(a,b,p)=>cross(a,b,p)===0&&p[0]>=Math.min(a[0],b[0])&&p[0]<=Math.max(a[0],b[0])&&p[1]>=Math.min(a[1],b[1])&&p[1]<=Math.max(a[1],b[1]);
    let area=0;
    for(let i=0;i<n;i++){
      const a=ring[i],b=ring[i+1];if(a.every((v,k)=>v===b[k])||Math.abs(a[0]-b[0])>180)throw Error('预报范围存在无效边');
      const next=ring[(i+2)%n];if(cross(a,b,next)===0&&(b[0]-a[0])*(next[0]-b[0])+(b[1]-a[1])*(next[1]-b[1])<0)throw Error('预报范围相邻边不得重叠');
      area+=cross(origin,a,b);
      for(let j=i+2;j<n;j++){
        if(i===0&&j===n-1)continue;const c=ring[j],d=ring[j+1];
        if((cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))throw Error('预报范围不得自交');
      }
    }
    if(Math.abs(area)<1e-12)throw Error('预报范围面积无效');
    return ring;
  }
  const api={validatePolygon,validatedPolygon,withMapPolygon,areaField,fields,update,validate,localTime,timestamp,coverage};root.WeatherForm=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
