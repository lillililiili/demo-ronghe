'use strict';
window.NotificationUI = {
  fields(target) {
    if(target.kind!=='uav')return '';
    const mode=target.notificationBehavior||'none';
    return '<div class="subheading">通知后的飞行行为</div>'+selectField('响应方式','notificationBehavior',mode,[{value:'none',label:'不联动，按原轨迹飞行'},{value:'after_sms',label:'短信送达后撤离'},{value:'after_voice',label:'电话播放完成后撤离'},{value:'hold',label:'收到通知后继续原轨迹'},{value:'drop_sms',label:'短信送达后停止目标上报'}])+`<div id="departure-config" ${!['after_sms','after_voice'].includes(mode)?'hidden':''}>`+field('撤离速度（米/秒）','departureSpeed',target.departureSpeed||target.speed||6,'number','min="0.1" max="100" step="0.1"')+btn('edit-departure-path','在地图上绘制撤离航线','wide cyan-button')+`<p class="field-note">${target.departurePath?.length?`已绘制 ${target.departurePath.length} 个撤离航点`:'尚未绘制撤离航线'}。从接收通知时的位置飞向第一个撤离航点。</p><p class="field-note" id="departure-estimate"></p></div><p class="field-note" id="notification-mode-note">${mode==='drop_sms'?'仅停止该目标的主、辅助位置上报，设备心跳继续。':'关联本次运行的通知，飞离结果由业务系统判断。'}</p>`;
  },
  estimate() {
    const el=document.querySelector('#departure-estimate'),t=selected.kind==='target'?lookup('target',selected.id):null;
    if(!el||!t?.departurePath?.length)return;
    const speed=Number(document.querySelector('[name=departureSpeed]')?.value);
    const points=[position(t),...t.departurePath];
    const length=points.slice(1).reduce((sum,p,i)=>{const a=points[i],lat=37.5-(a[1]+p[1])*.00006;return sum+Math.hypot((p[0]-a[0])*.00012*111320*Math.cos(lat*Math.PI/180),(p[1]-a[1])*.00012*111320)},0);
    el.textContent=speed>0?`按当前图示位置，到末点约 ${Math.ceil(length/speed)} 秒${length/speed>10?'，超过单段 10 秒观察窗口':''}。触发位置变化会改变用时，末点不代表系统已判飞离。`:'请填写有效撤离速度。';
  },
  progress() {
    const host=document.querySelector('#notification-progress');if(!host)return;
    const key=selected.kind==='target'?selected.id:selected.kind==='risk'?lookup('risk',selected.id)?.targetId:null;
    const view=(showRunPositions||(typeof running==='function'&&running()))?liveState?.notification_observation?.[key]:null;
    host.hidden=!view;if(!view)return;
    const time=n=>n?new Date(n).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未收到';
    const phases={AUTO_SMS:'自动短信',WATCHING:'观察中',AUTO_CALL:'自动电话',AWAIT_COUNTER:'待反制'};
    const states={WAITING:'等待通知',DEPARTING:'已开始沿撤离航线飞行',REPORTS_STOPPED:'已停止目标位置上报',CONTINUING:'继续原轨迹飞行'};
    const stage=view.error?'读取失败，当前进度待确认':phases[view.notify_phase]||(view.event_state==='CONFIRMED'?'告警已确认':view.event_state==='PENDING_VERIFICATION'?'待核实':view.event_id?'等待系统通知阶段':'等待本批次告警');
    const observation=view.observation||{};
    const presence=observation.status==='WATCHING'?'观察中':observation.status==='NOT_STARTED'?'尚未开始观察':observation.status==='ASSESSED'?({LEFT:'已飞离告警空域',STILL_PRESENT:'仍在告警空域',UNKNOWN:'无法确认是否飞离'})[observation.presence]||'无法确认是否飞离':'观察结果暂不可用';
    host.innerHTML=`<div class="subheading">本次通知与观察</div><strong>${esc(stage)}</strong>${view.alarm_no?`<p>${esc(view.alarm_no)}</p>`:''}<dl><dt>短信送达</dt><dd>${esc(time(view.sms_at))}</dd><dt>电话播放完成</dt><dd>${esc(time(view.voice_at))}</dd><dt>系统观察结论</dt><dd>${esc(view.error?'当前结论待确认':presence)}</dd>${observation.deadline_at?`<dt>${observation.channel==='VOICE'?'电话后':'短信后'}观察截止</dt><dd>${esc(time(observation.deadline_at))}</dd>`:''}<dt>最新位置时间</dt><dd>${esc(time(view.observed_at))}</dd></dl><p>${esc(states[view.action]||'等待运行')}</p><p>${esc(view.error||observation.error||view.reason||'系统尚未返回观察结论')}</p>${view.triggered_at?`<small>飞行行为触发：${esc(time(view.triggered_at))}</small>`:''}<small>读取时间：${esc(time(view.updated_at))}${running()?'':' · 本次运行已结束'}</small>`;
  },
  lock() {
    const active=typeof running==='function'&&running();
    document.querySelectorAll('main button').forEach(button=>{
      const a=button.dataset.action;
      const readable=a==='select'||a?.startsWith('zoom-')||button.dataset.workspaceTab||button.id==='toggle-risks'||button.dataset.inputTab||button.id==='retry-map';
      if(!readable){if(active){if(!button.hasAttribute('data-run-disabled'))button.dataset.runDisabled=String(button.disabled);button.disabled=true;}else if(button.hasAttribute('data-run-disabled')){button.disabled=button.dataset.runDisabled==='true';delete button.dataset.runDisabled;}}
    });
    document.querySelectorAll('main input,main select,main textarea').forEach(el=>{if(active){if(!el.hasAttribute('data-run-disabled'))el.dataset.runDisabled=String(el.disabled);el.disabled=true;}else if(el.hasAttribute('data-run-disabled')){el.disabled=el.dataset.runDisabled==='true';delete el.dataset.runDisabled;}});
  }
};
document.addEventListener('change',event=>{
  if(event.target.name!=='notificationBehavior')return;
  document.querySelector('#departure-config').hidden=!['after_sms','after_voice'].includes(event.target.value);
  document.querySelector('#notification-mode-note').textContent=event.target.value==='drop_sms'?'仅停止该目标的主、辅助位置上报，设备心跳继续。':'关联本次运行的通知，飞离结果由业务系统判断。';
  window.NotificationUI.estimate();
});
document.addEventListener('input',event=>{if(event.target.name==='departureSpeed')window.NotificationUI.estimate();});
