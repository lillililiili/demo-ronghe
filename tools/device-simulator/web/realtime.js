(function (root) {
  'use strict';
  const kinds = {ADVISORY_SMS:'飞手短信',ADVISORY_VOICE:'飞手电话',RISK_NOTICE:'风险通知',UAV_PUNISHMENT:'处罚移送',PLAN_FEEDBACK:'任务反馈',DEVICE_MAINTENANCE:'设备运维'};
  const outcomes = {success:'正常回执',failed:'失败',timeout:'超时',delayed:'延迟回执',mixed:'轮换结果（电话含仅接通）',no_receipt:'不回执',no_answer:'未接通',answered_only:'仅接通，不完成播放'};
  const modeNames = {normal:'正常模式',abnormal:'异常模式',mixed:'混合模式'};
  const outcomeChoices = kind => Object.fromEntries(Object.entries(outcomes).filter(([mode])=>kind==='ADVISORY_VOICE'||!['no_answer','answered_only'].includes(mode)));
  const notificationOnline = (value, now = Date.now()) => Number(value?.lease_expires_at || 0) > now;
  const editLocked = data => ['PREPARING','RUNNING','PAUSED','STOPPING'].includes(data?.phase) || ['STARTING','RUNNING','STOPPING'].includes(data?.realtime?.state);
  if (typeof module !== 'undefined') { module.exports = {notificationOnline, editLocked, modeNames, outcomeChoices}; return; }
  let busy = false;
  const box = document.createElement('section');
  box.className = 'realtime-bar';
  box.setAttribute('aria-label', '实时收发');
  box.innerHTML = '<div><strong>实时收发</strong><span id="realtime-summary" role="status">尚未启动</span></div><div id="realtime-detail"></div><div class="realtime-actions"><button id="realtime-settings">收发模式设置</button><button id="realtime-start">启动接收端</button><button id="realtime-stop">停止全部收发</button></div><div id="realtime-error" role="alert"></div>';
  document.querySelector('footer').before(box);
  const time = value => value ? new Date(value).toLocaleTimeString() : '尚无';
  const names = {STOPPED:'已停止',STARTING:'启动中',RUNNING:'运行中',STOPPING:'停止中',FAILED:'失败'};
  function update(data) {
    if (data.scene_mode === 'isolated_qa') {
      document.querySelector('#realtime-summary').textContent='隔离 QA 场景模式';
      document.querySelector('#realtime-detail').textContent='按原场景时长与故障设置上报；实时通知与反制接收端未启用。使用开始模拟、停止场景上报及系统回读。';
      document.querySelector('#realtime-error').textContent='';
      for(const id of ['realtime-settings','realtime-start','realtime-stop']) document.querySelector('#'+id).disabled=true;
      document.querySelector('[data-action=integration]').disabled=editLocked(data);
      document.querySelector('#duration').disabled=editLocked(data);
      return;
    }
    const rt = data.realtime;
    if (!rt) {
      document.querySelector('#realtime-summary').textContent='服务尚未加载实时收发模块，请重启模拟器';
      for(const id of ['realtime-settings','realtime-start','realtime-stop']) document.querySelector('#'+id).disabled=true;
      document.querySelector('[data-action=integration]').disabled=true;
      return;
    }
    const n = rt.notifications || {}, tcp = rt.countermeasure || {};
    document.querySelector('#realtime-summary').textContent = `${modeNames[rt.config.mode]||rt.config.mode} · ${names[rt.state] || rt.state} · ${rt.config.continuous?'持续运行':'按场景时长'}`;
    document.querySelector('#realtime-detail').textContent = `登录校验 ${time(Math.max(rt.session_verified_at || 0,data.session_verified_at || 0))}　MQTT ${data.mqtt_connected?'已连接':'未连接'} / 已发 ${data.sent || 0}　最近上报 ${time(data.last_published_at)}　TCP ${tcp.listening?'监听中':'未监听'} / 收到 ${tcp.received || 0}　通知 ${notificationOnline(n)?'租约有效':'未连接'} / 收到 ${n.received_count || 0} / 已回执 ${n.receipt_count || 0}　最近接收 ${time(Math.max(n.last_received_at || 0,tcp.last_received_at || 0))}`;
    document.querySelector('#realtime-error').textContent = rt.error || n.last_error || tcp.error || '';
    document.querySelector('#realtime-settings').disabled = busy || editLocked(data);
    document.querySelector('#realtime-start').disabled = busy || !data.connected || ['STARTING','RUNNING','STOPPING'].includes(rt.state);
    document.querySelector('#realtime-stop').disabled = busy || (!editLocked(data) && !tcp.listening);
    const duration = document.querySelector('#duration');
    duration.value=rt.config.continuous?'0':String(state.duration);
    duration.disabled = running() || rt.config.continuous;
  }
  function choice(name,label,value,choices) {
    return `<label class="realtime-field">${esc(label)}<select name="${esc(name)}">${Object.entries(choices).map(([v,text])=>`<option value="${esc(v)}" ${String(value)===v?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
  }
  async function settings() {
    const config = await api('realtime/config');
    let scopes = [], warning='';
    if(liveState?.connected) {
      try { const context=await api('external/request',{method:'GET',path:'/local-interface-simulator/airspaces/context'}); scopes=context.scopes || []; }
      catch(error) { warning=error.message; }
    }
    const options = {'':'跟随模拟器连接的单位与区县'};
    for(const scope of scopes) options[`${scope.owner_org_id}|${scope.district_id}`]=`${scope.owner_org_name || scope.owner_org_id} · ${scope.district_name || scope.district_id}`;
    if(config.countermeasure_scope && !options[config.countermeasure_scope]) options[config.countermeasure_scope]='已保存的单位与区县（不在当前读取范围）';
    openDialog('实时收发设置',`<form id="realtime-form">
      <p class="field-note">修改只影响下一次启动。已有通知保留首次接收时的处理方式；混合模式保留正常目标上报，同时按所选通知结果模拟异常回执。</p>
      ${choice('mode','运行模式',config.mode,{normal:'正常',abnormal:'异常',mixed:'混合'})}
      ${choice('continuous','运行时长',config.continuous,{true:'持续运行，手动停止',false:'使用场景时长'})}
      ${choice('notifications_enabled','六类通知接收',config.notifications_enabled,{true:'启用',false:'关闭'})}
      ${choice('countermeasure_enabled','本机模拟反制设备',config.countermeasure_enabled,{true:'启用',false:'关闭'})}
      ${choice('countermeasure_scope','反制设备所属单位与区县',config.countermeasure_scope,options)}
      <p class="field-note">反制设备长期部署在某个单位与区县，不跟飞行任务绑定；这里只决定设备归属，不授予反制权限。</p>
      <label class="realtime-field">模拟电话播放时长（秒）<input name="play_seconds" type="number" min="0.1" max="60" step="0.1" value="${esc(config.play_seconds)}" required></label>
      <fieldset id="realtime-abnormal"><legend>异常与混合模式参数</legend>
      ${choice('command_mode','设备指令',config.command_mode,{success:'正常执行回执',no_receipt:'不执行、不回执',unchanged:'四通道状态不变，光电正常'})}
      ${Object.entries(kinds).map(([kind,label])=>choice(kind,label,config.outcomes[kind] || 'success',outcomeChoices(kind))).join('')}
      <p class="field-note">混合模式的设备指令按正常回执；异常模式可模拟设备指令异常。全量场景若选择通知轮换策略，会覆盖此处六类结果。设备离线和故障时窗属于设备诊断联调条件。</p></fieldset>
      <p class="inline-error" role="alert">${esc(warning)}</p><div class="form-actions"><button type="submit" class="primary">保存设置</button></div></form>`);
    const form=document.querySelector('#realtime-form');
    const refresh=()=>{ const mode=form.elements.mode.value;document.querySelector('#realtime-abnormal').disabled=mode==='normal';form.elements.command_mode.disabled=mode!=='abnormal'; };
    form.elements.mode.addEventListener('change',refresh);refresh();
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const next={...config,outcomes:{...config.outcomes}};
      for(const key of ['mode','command_mode','countermeasure_scope']) next[key]=form.elements[key].value;
      for(const key of ['continuous','notifications_enabled','countermeasure_enabled']) next[key]=form.elements[key].value==='true';
      next.play_seconds=Number(form.elements.play_seconds.value);
      for(const kind of Object.keys(kinds)) next.outcomes[kind]=form.elements[kind].value;
      const submit=form.querySelector('[type=submit]');submit.disabled=true;
      try { await api('realtime/config',next);closeDialog();toast('设置已保存，下次启动生效');await poll(); }
      catch(error) { form.querySelector('.inline-error').textContent=error.message; }
      finally { submit.disabled=false; }
    });
  }
  document.querySelector('#realtime-settings').addEventListener('click',()=>settings().catch(error=>toast(error.message)));
  for(const [id,action] of [['realtime-start','start'],['realtime-stop','stop_all']]) {
    document.querySelector('#'+id).addEventListener('click',async()=>{
      busy=true;if(liveState)update(liveState);
      try { await api('realtime/control',{action});toast(action==='start'?'接收端已启动；点击开始模拟可持续上报':'全部收发已请求停止'); }
      catch(error) { toast(error.message); }
      finally { busy=false;await poll(); }
    });
  }
  root.RealtimeUI={update,notificationOnline,editLocked};
})(globalThis);
