'use strict';
// UI navigation only; scene changes and MQTT actions stay in the existing editor.
(() => {
  const root = document.querySelector('.simulator-workspace');
  const frame = document.querySelector('#input-frame');
  let inputTab = 'plans';
  let pendingZoneId = null;
  function sendZones() {
    if (!window.SimulatorMap) return;
    frame.contentWindow.postMessage({type:'simulator-airspace-zones',selected_id:pendingZoneId,zones:state.zones.filter(z=>z.points.length>=3).map(z=>({id:z.id,name:z.name,kind_code:z.kindCode||'',boundary:{type:'Polygon',coordinates:[z.points.map(p=>window.SimulatorMap.coordinates(p)).concat([window.SimulatorMap.coordinates(z.points[0])])]}}))},location.origin);
    pendingZoneId=null;
  }
  function sendPlans() {
    if (!window.SimulatorMap?.ready || !frame.contentWindow) return;
    const selectedPlanId = typeof selected !== 'undefined' && selected?.kind === 'plan' ? selected.id : '';
    const payload = {type:'simulator-plan-drafts',plans:state.plans.filter(plan=>Array.isArray(plan.points)&&plan.points.length>=2).map(plan=>({
      id:plan.id,name:plan.name,points:plan.points.map(point=>window.SimulatorMap.coordinates(point)),start:plan.start,end:plan.end,
      min:plan.min,max:plan.max,width:plan.width,altitudeDatum:plan.altitudeDatum||'AMSL'
    }))};
    if (selectedPlanId) payload.selected_id = selectedPlanId;
    frame.contentWindow.postMessage(payload,location.origin);
  }
  function openAirspace(id) {
    const alreadyOpen=frame.dataset.view==='airspaces';pendingZoneId=id;inputTab='airspaces';
    document.querySelectorAll('[data-input-tab]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.inputTab==='airspaces')));
    workspace('inputs',false);revealInput();
    if(alreadyOpen) sendZones();
  }
  const sceneTools = document.querySelector('#scene-tools');
  document.addEventListener('click', event => {
    if (!sceneTools.contains(event.target)) sceneTools.open = false;
  });
  sceneTools.addEventListener('keydown', event => {
    if (event.key === 'Escape') { sceneTools.open = false; sceneTools.querySelector('summary').focus(); }
  });
  function syncFrame() {
    const url = inputTab==='airspaces'?'/airspace.html?embed=1':'/external.html?embed=1&tab='+inputTab+'&v=20261005-plan-time-2';
    if (root.dataset.workspace==='inputs' && frame.dataset.view !== (inputTab==='airspaces'?'airspaces':'external')) { frame.dataset.view=inputTab==='airspaces'?'airspaces':'external'; frame.src=url; }
    frame.contentWindow?.postMessage({type:'simulator-input-view', tab:inputTab, visible:root.dataset.workspace==='inputs'}, location.origin);
    if(inputTab==='plans')sendPlans();
  }
  function revealInput() {
    // On stacked layouts the form sits below the map, outside the visible viewport.
    if (window.matchMedia('(max-width:760px)').matches) {
      document.querySelector('#input-dock').scrollIntoView({block:'start', behavior:'instant'});
    }
  }
  function workspace(next, refit = true) {
    if (typeof draw !== 'undefined' && draw) return toast('请先完成或取消当前地图绘制');
    root.dataset.workspace = next;
    document.querySelectorAll('[data-workspace-tab]').forEach(button => {
      const active = button.dataset.workspaceTab === next;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-tool-panel]').forEach(panel => { panel.hidden = panel.dataset.toolPanel !== next; });
    document.querySelector('.inspector').hidden = next === 'inputs';
    document.querySelector('#input-dock').hidden = next !== 'inputs';
  if (next === 'inputs' && !frame.getAttribute('src')) frame.src = '/external.html?embed=1&tab='+inputTab+'&v=20261005-weather-area-1';
    syncFrame();
    if (refit) requestAnimationFrame(() => window.SimulatorMap?.fit(scenePoints()));
  }
  document.querySelectorAll('[data-workspace-tab]').forEach(button => {
    button.addEventListener('click', () => workspace(button.dataset.workspaceTab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-workspace-tab]')], index = tabs.indexOf(button);
      const next = event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      workspace(tabs[next].dataset.workspaceTab); tabs[next].focus();
    });
  });
  document.querySelectorAll('[data-input-tab]').forEach(button => button.addEventListener('click', () => {
    inputTab = button.dataset.inputTab;
    document.querySelectorAll('[data-input-tab]').forEach(item => item.setAttribute('aria-pressed', String(item===button)));
    syncFrame();
    revealInput();
  }));
  document.querySelector('#toggle-risks').addEventListener('click', event => {
    const collapsed = root.classList.toggle('risks-collapsed');
    document.querySelector('#risk-list').hidden = collapsed;
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    event.currentTarget.textContent = collapsed ? '展开列表' : '收起列表';
  });
  window.addEventListener('simulator:selection', event => event.detail.kind==='zone'?openAirspace(event.detail.id):workspace(event.detail.kind==='plan'?'routes':'objects', false));
  window.addEventListener('simulator:airspace-drawn', event => openAirspace(event.detail.id));
  window.addEventListener('message', event => {
    if (event.origin!==location.origin || event.source!==frame.contentWindow) return;
    if (event.data?.type==='simulator-input-ready') {syncFrame();if(pendingZoneId)sendZones();}
    if (event.data?.type==='simulator-plan-draw') {
      if(draw)return toast('请先完成或取消当前绘制');
      workspace('routes');setDraw('plan',event.data.id||null);
      if (window.matchMedia('(max-width:760px)').matches) document.querySelector('.map-panel').scrollIntoView({block:'start',behavior:'instant'});
    }
    if (event.data?.type==='simulator-airspace-login') document.querySelector('[data-action=connection]').click();
    if (event.data?.type==='simulator-airspace-draw') {
      if(!airspaceKinds[event.data.kind_code])return toast('请先选择空域类型');
      if(draw)return toast('请先完成或取消当前绘制');
      setDraw('zone');
      if(!draw)return;
      draw.airspaceKind=event.data.kind_code;draw.airspaceInput=true;
      document.querySelector('#draw-message').textContent='正在绘制'+airspaceKinds[event.data.kind_code]+'边界，至少 3 个顶点';
      if (window.matchMedia('(max-width:760px)').matches) document.querySelector('.map-panel').scrollIntoView({block:'start',behavior:'instant'});
    }
    if (event.data?.type==='simulator-airspace-kind' && airspaceKinds[event.data.kind_code]) {
      const zone=state.zones.find(z=>z.id===event.data.id);
      if(zone){zone.kindCode=event.data.kind_code;dirty();renderTree();}
    }
    if (event.data?.type==='simulator-airspace-zones') sendZones();
  });
  frame.addEventListener('load', syncFrame);
  window.addEventListener('simulator-map:ready', sendPlans);
  const initial = new URLSearchParams(location.search).get('input');
  if (['plans','weather','airspaces'].includes(initial)) {
    inputTab=initial;
    document.querySelectorAll('[data-input-tab]').forEach(item => item.setAttribute('aria-pressed',String(item.dataset.inputTab===initial)));
  }
  root.classList.add('risks-collapsed');
  document.querySelector('#risk-list').hidden=true;
  document.querySelector('#toggle-risks').setAttribute('aria-expanded','false');
  document.querySelector('#toggle-risks').textContent='展开列表';
  workspace(initial?'inputs':'objects');
})();
