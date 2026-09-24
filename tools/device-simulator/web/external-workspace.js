'use strict';
(() => {
  const params=new URLSearchParams(location.search), embedded=params.get('embed')==='1';
  const requested=params.get('tab');
  window.SimulatorExternalView={tab:embedded&&['plans','weather'].includes(requested)?requested:'risk',visible:true};
  if(!embedded)return;
  document.body.classList.add('embedded-input');
  document.querySelector('.brand h1').textContent='系统资料输入';
  document.querySelector('#login-dialog').setAttribute('aria-label','登录系统');
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='simulator-input-view')return;
    window.SimulatorExternalView.visible=event.data.visible===true;
    if(['plans','weather'].includes(event.data.tab))setTab(event.data.tab);
    if(window.SimulatorExternalView.visible)status();
  });
  window.addEventListener('DOMContentLoaded',()=>parent.postMessage({type:'simulator-input-ready'},location.origin));
})();
