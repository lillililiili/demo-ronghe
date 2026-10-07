'use strict';
(function(root){
  const specs=[['summary','天气','text'],['temperature_c','温度（℃）','number',-90,60],['wind_speed_ms','风速（米/秒）','number',0,150],['gust_ms','阵风（米/秒）','number',0,150],['wind_direction_deg','风向（度）','number',0,360],['precipitation_probability_pct','降水概率（%）','number',0,100],['humidity_pct','湿度（%）','number',0,100]];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function localTime(ms){return Number.isFinite(Number(ms))&&Number(ms)>0?new Date(Number(ms)+8*3600000).toISOString().slice(0,19):'';}
  function timestamp(value){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))throw Error('请填写完整的北京时间');const n=Date.parse(value+'+08:00');if(!Number.isFinite(n))throw Error('时间无效');return n;}
  function control(key,label,value,type='text',index='',min,max){return `<label>${esc(label)}<input data-weather-field="${key}" data-period="${index}" aria-label="${esc(label)}${index!==''?' · 时段 '+(index+1):''}" type="${type}" value="${esc(type==='datetime-local'?localTime(value):value)}" ${type==='number'?`min="${min}" max="${max}" step="${['wind_direction_deg','precipitation_probability_pct','humidity_pct'].includes(key)?1:'any'}"`:type==='datetime-local'?'step="1"':'maxlength="128"'} required></label>`;}
  function areaField(data){return control('area_name','预报区域',data?.area_name);}
  function fields(data){if(!data||typeof data!=='object'||Array.isArray(data)||(data.periods!==undefined&&(!Array.isArray(data.periods)||data.periods.some(p=>!p||typeof p!=='object'||Array.isArray(p)))))return '<p class="external-note warn">报文结构无效，请展开接口报文修正预报时段。</p>';return `<div class="external-grid">${control('published_at','发布时间（北京时间）',data.published_at,'datetime-local')}</div><div class="weather-periods">${(Array.isArray(data.periods)?data.periods:[]).map((p,i)=>`<fieldset><legend>预报时段 ${i+1}</legend><div class="external-grid">${control('from','开始时间（北京时间）',p.from,'datetime-local',i)}${control('to','结束时间（北京时间）',p.to,'datetime-local',i)}${specs.map(([key,label,type,min,max])=>control(key,label,p[key],type,i,min,max)).join('')}</div>${data.periods.length>1?`<button type="button" data-weather-remove="${i}">移除此时段</button>`:''}</fieldset>`).join('')}</div><button type="button" id="weather-add-period" ${(data.periods?.length||0)>=48?'disabled':''}>增加预报时段</button>`;}
  function update(data,key,index,value){const next=structuredClone(data);const numeric=['published_at','from','to',...specs.filter(s=>s[2]==='number').map(s=>s[0])];let parsed=value;if(numeric.includes(key)){if(value==='')parsed=null;else parsed=['published_at','from','to'].includes(key)?timestamp(value):Number(value);}if(index==='')next[key]=parsed;else {if(!next.periods?.[Number(index)])throw Error('预报时段不存在');next.periods[Number(index)][key]=parsed;}return next;}
  function validate(data,now=Date.now()){
    if(typeof data.area_name!=='string'||!data.area_name.trim())throw Error('请填写预报区域');
    if(!Number.isFinite(data.published_at)||data.published_at<=0||data.published_at>now+30000)throw Error('预报发布时间须有效且不能在未来');
    if(!Array.isArray(data.periods)||!data.periods.length||data.periods.length>48)throw Error('请填写 1 至 48 个预报时段');
    let last=data.published_at;
    for(const [i,p] of data.periods.entries()){
      if(!p||typeof p!=='object'||Array.isArray(p))throw Error(`时段 ${i+1} 必须为对象`);
      if(!Number.isFinite(p.from)||!Number.isFinite(p.to)||p.from<last||p.to<=p.from||p.to-data.published_at>7*86400000)throw Error(`时段 ${i+1} 须有序、不重叠，且在发布时间后 7 天内`);
      for(const [key,label,type,min,max] of specs){if(type==='text'){if(typeof p[key]!=='string'||!p[key].trim()||p[key].length>128)throw Error(`请填写时段 ${i+1} 的${label}`);}else if(!Number.isFinite(p[key])||p[key]<min||p[key]>max||(['wind_direction_deg','precipitation_probability_pct','humidity_pct'].includes(key)&&!Number.isInteger(p[key])))throw Error(`时段 ${i+1} 的${label}须在 ${min}—${max} 之间${['wind_direction_deg','precipitation_probability_pct','humidity_pct'].includes(key)?'，且为整数':''}`);}
      last=p.to;
    }
    return data;
  }
  function coverage(data){
    const area=String(data?.area_name||'').trim();
    return area
      ? `预报区域：${area}。提交后由平台系统按预报区域匹配受影响任务。`
      : '请填写预报区域。提交后由平台系统按预报区域匹配受影响任务。';
  }
  const api={areaField,fields,update,validate,localTime,timestamp,coverage};root.WeatherForm=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
