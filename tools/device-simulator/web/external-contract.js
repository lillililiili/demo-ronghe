'use strict';
(function(root){
  function planSampleForRoute(route, now, messageId){
    const validFrom=Number(route?.valid_from),validTo=Number(route?.valid_to);
    const start=Math.max(now+5*60000,Number.isFinite(validFrom)&&validFrom>0?validFrom:0);
    const end=Math.min(start+60*60000,Number.isFinite(validTo)&&validTo>0?validTo:Infinity);
    if(end<=start)throw Error('航线有效期不足，无法生成起止时间；请选择其它航线版本');
    return {message_id:messageId,route_version_id:route?.route_version_id||'',uav_sn:'SIM-UAV-'+now.toString(36).toUpperCase(),start_at:start,end_at:end};
  }
  function weatherSampleForPlan(plan, now, messageId){
    const start=Number(plan?.start_at);
    const from=Number.isFinite(start)&&start>0?start:now+5*60000;
    const end=Number(plan?.end_at);
    const to=Number.isFinite(end)&&end>from?end:from+60*60000;
    return {message_id:messageId,plan_id:plan?.plan_id||'',area_name:'东营模拟预报区域',published_at:Math.min(now,from),periods:[{from,to,summary:'多云',temperature_c:22,wind_speed_ms:3,gust_ms:5,wind_direction_deg:90,precipitation_probability_pct:20,humidity_pct:55}]};
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
      const changed=next.route_version_id!==fields.target;
      next.route_version_id=fields.target;
      if(changed&&fields.route){
        const sample=planSampleForRoute(fields.route,fields.now,fields.messageId);
        next.start_at=sample.start_at;next.end_at=sample.end_at;
      }
    }
    else{
      const changed=next.plan_id!==fields.target;
      next.plan_id=fields.target;
      if(changed&&fields.plan){
        const sample=weatherSampleForPlan(fields.plan,fields.now,fields.messageId);
        const periods=Array.isArray(next.periods)?next.periods.slice():[];
        periods[0]={...sample.periods[0],...(periods[0]||{}),from:sample.periods[0].from,to:sample.periods[0].to};
        next.periods=periods;
        next.published_at=Math.min(Number(next.published_at)||fields.now,sample.periods[0].from);
      }
    }
    return next;
  }
  function submitResultText(path,result){
    if(path==='/local-interface-simulator/bindings')return result.enabled?'系统确认：模拟接收已启用。等待平台原流程产生通知。':'系统确认：模拟接收已停用。';
    return null;
  }
  function unavailableNotice(context){
    return Array.isArray(context?.unavailable_sections)?context.unavailable_sections.filter(value=>typeof value==='string'&&value.trim()).join('；'):'';
  }
  const api={planSampleForRoute,weatherSampleForPlan,receiptChoices,applyInputFields,submitResultText,unavailableNotice};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.ExternalContract=api;
})(typeof window!=='undefined'?window:globalThis);
