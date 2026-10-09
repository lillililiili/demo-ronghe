'use strict';
(function(root){
  // D-2（2026-10-08 定“模拟器带上”）：模拟的上级任务默认带上申报单位、执行飞手和报送单位，
  // 平台收任务时按飞手手机号、报送单位编码找或建档案并关联；表单里可以改或清空。
  const SIMULATED_FILING=Object.freeze({operator_name:'模拟申报单位',pilot_name:'模拟飞手',pilot_phone:'13800000000',reporting_org_code:'SIM-REPORTING-UNIT',reporting_org_name:'模拟报送单位'});
  function planSampleForRoute(route, now, messageId){
    const validFrom=Number(route?.valid_from),validTo=Number(route?.valid_to);
    const start=Math.max(now+5*60000,Number.isFinite(validFrom)&&validFrom>0?validFrom:0);
    const end=Math.min(start+60*60000,Number.isFinite(validTo)&&validTo>0?validTo:Infinity);
    if(end<=start)throw Error('航线有效期不足，无法生成起止时间；请选择其它航线版本');
    return {message_id:messageId,route_version_id:route?.route_version_id||'',uav_sn:'SIM-UAV-'+now.toString(36).toUpperCase(),start_at:start,end_at:end,filing:{source_id:'local-flight-plan-simulator',...SIMULATED_FILING}};
  }
  function weatherSampleForPlan(plan, now, messageId){
    const start=Number(plan?.start_at);
    const from=Number.isFinite(start)&&start>0?start:now+5*60000;
    const end=Number(plan?.end_at);
    const to=Number.isFinite(end)&&end>from?end:from+60*60000;
    return {message_id:messageId,plan_id:plan?.plan_id||'',area_name:'东营模拟预报区域',published_at:Math.min(now,from),periods:[{from,to,summary:'多云',temperature_c:22,wind_speed_ms:3,gust_ms:5,wind_direction_deg:90,precipitation_probability_pct:20,humidity_pct:55}]};
  }
  function weatherSample(now, messageId){
    const from=Number.isFinite(Number(now))&&Number(now)>0?Number(now):Date.now();
    return {message_id:messageId,area_name:'东营区',published_at:from,periods:[{from,to:from+60*60000,summary:'多云',temperature_c:22,wind_speed_ms:3,gust_ms:5,wind_direction_deg:90,precipitation_probability_pct:20,humidity_pct:55}]};
  }
  function receiptChoices(item){
    if(item.state==='SUBMITTED')return [['DELIVERED','模拟送达'],['FAILED','模拟发送失败'],['TIMEOUT','模拟回执超时']];
    if(item.state==='DELIVERED')return [['ACKNOWLEDGED','模拟签收'],['TIMEOUT','模拟回执超时']];
    if(item.state==='TIMEOUT')return item.result?.delivery_status==='DELIVERED'?[['DELIVERED','补回送达回执'],['ACKNOWLEDGED','补回签收回执']]:[['DELIVERED','补回送达回执']];
    return [];
  }
  function applyInputFields(data, fields){
    const next={...data,message_id:fields.messageId};
    if(fields.kind==='plans'){
      // New upstream plan payloads carry route geometry directly. A blank target
      // means the UI has no legacy route selector; preserve the embedded route.
      // The route_version_id branch remains only for old compatible payloads.
      const target=typeof fields.target==='string'?fields.target.trim():'';
      const changed=Boolean(target)&&next.route_version_id!==target;
      if(target)next.route_version_id=target;
      if(changed&&fields.route){
        const sample=planSampleForRoute(fields.route,fields.now,fields.messageId);
        next.start_at=sample.start_at;next.end_at=sample.end_at;
      }
    }
    else{
      // A forecast is an area-level fact. It is submitted independently;
      // plans are matched later by the forecast area on the business side.
      delete next.plan_id;
    }
    return next;
  }
  function applyScenePlanRoute(data, plan, scope){
    if(!plan||!Array.isArray(plan.points)||plan.points.length<2)return data;
    const next={...(data||{})};
    delete next.route_version_id;
    const owner=scope?.owner_org_id||scope?.ownerOrgId||next.route?.owner_org_id||'';
    const district=scope?.district_id||scope?.districtId||next.route?.district_id||'';
    const width=Number(plan.width),min=Number(plan.min),max=Number(plan.max);
    next.route={
      name:typeof plan.name==='string'&&plan.name.trim()?plan.name.trim():'上级任务航线',
      geometry:{type:'LineString',coordinates:plan.points.map(point=>[Number(point[0]),Number(point[1])])},
      corridor_width_m:Number.isFinite(width)&&width>0?width:100,
      min_altitude_m:Number.isFinite(min)&&Number.isFinite(max)&&min<=max?min:20,
      max_altitude_m:Number.isFinite(min)&&Number.isFinite(max)&&min<=max?max:120,
      altitude_datum:plan.altitudeDatum||'AMSL',owner_org_id:owner,district_id:district
    };
    return next;
  }
  function refreshUpstreamRouteDraft(data, previousRoutes, nextRoutes){
    const current=typeof data?.route_version_id==='string'?data.route_version_id.trim():'';
    const previous=Array.isArray(previousRoutes)&&previousRoutes[0]?.route_version_id;
    const next=Array.isArray(nextRoutes)&&nextRoutes[0]?.route_version_id;
    if(!current||!previous||!next||current!==previous||current===next)return data;
    return {...data,route_version_id:next};
  }
  // known = the receipts listed before this submission. The platform answers a resent forecast (same message number,
  // same content) with its first receipt, so a receipt already in the list means nothing new was created (CDX-P07).
  function submitResultText(path,result,known){
    if(path==='/local-interface-simulator/bindings')return result.enabled?'系统确认：模拟接收已启用。等待平台原流程产生通知。':'系统确认：模拟接收已停用。';
    if(path==='/local-interface-simulator/weather'&&result?.message_id&&Array.isArray(known)&&known.some(row=>row?.message_id===result.message_id))
      return '这份预报此前已被系统受理，本次返回原回执，未重复生成天气风险。要再交一份新的预报，请先点“生成新样本”换新的消息编号。';
    return null;
  }
  function unavailableNotice(context){
    return Array.isArray(context?.unavailable_sections)?context.unavailable_sections.filter(value=>typeof value==='string'&&value.trim()).join('；'):'';
  }
  const api={SIMULATED_FILING,planSampleForRoute,weatherSampleForPlan,weatherSample,receiptChoices,applyInputFields,applyScenePlanRoute,refreshUpstreamRouteDraft,submitResultText,unavailableNotice};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.ExternalContract=api;
})(typeof window!=='undefined'?window:globalThis);
