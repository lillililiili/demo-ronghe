'use strict';
// UI navigation only; scene changes and MQTT actions stay in the existing editor.
(() => {
  const root = document.querySelector('.simulator-workspace');
  const frame = document.querySelector('#input-frame');
  let inputTab = 'plans';
  function syncFrame() {
    frame.contentWindow?.postMessage({type:'simulator-input-view', tab:inputTab, visible:root.dataset.workspace==='inputs'}, location.origin);
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
    if (next === 'inputs' && !frame.getAttribute('src')) frame.src = '/external.html?embed=1&tab='+inputTab;
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
  }));
  document.querySelector('#toggle-risks').addEventListener('click', event => {
    const collapsed = root.classList.toggle('risks-collapsed');
    document.querySelector('#risk-list').hidden = collapsed;
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    event.currentTarget.textContent = collapsed ? '展开列表' : '收起列表';
  });
  window.addEventListener('simulator:selection', event => workspace(['plan','zone'].includes(event.detail.kind)?'routes':'objects', false));
  window.addEventListener('message', event => {
    if (event.origin===location.origin && event.source===frame.contentWindow && event.data?.type==='simulator-input-ready') syncFrame();
  });
  frame.addEventListener('load', syncFrame);
  const initial = new URLSearchParams(location.search).get('input');
  if (['plans','weather'].includes(initial)) {
    inputTab=initial;
    document.querySelectorAll('[data-input-tab]').forEach(item => item.setAttribute('aria-pressed',String(item.dataset.inputTab===initial)));
  }
  root.classList.add('risks-collapsed');
  document.querySelector('#risk-list').hidden=true;
  document.querySelector('#toggle-risks').setAttribute('aria-expanded','false');
  document.querySelector('#toggle-risks').textContent='展开列表';
  workspace(initial?'inputs':'objects');
})();
