(function (root) {
  'use strict';
  /* “选择流程 1-9”：一次选一个流程。左边选，右边看这个流程演示什么、开始前要做什么、会看到什么、要在平台上做什么，
     点“载入并准备”只载入这一个；载入后地图页顶部一直显示“你要做什么”，直到停止或换流程。
     流程文件和说明都在服务端（acceptance_flows.py），模拟器不替人开关规则，只读地看一眼规则开了没有。 */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ACTIVE = ['PREPARING', 'RUNNING', 'PAUSED', 'STOPPING'];
  const ENDED = ['STOPPED', 'COMPLETED', 'FAILED'];
  const PHASE_TEXT = {PREPARING: '正在准备资料', RUNNING: '运行中', PAUSED: '已暂停', STOPPING: '正在停止'};

  /* 规则管理里核实、反制两组规则现在开没开（服务端只读取到的）；读不到的那一组不说。 */
  function rulesLine(rules, flow) {
    if (flow?.guide?.prediction_only) return '预测预警由人工核实、人工发起反制，无需调整普通告警的自动规则。';
    const verify = rules?.verify, counter = rules?.counter, parts = [];
    if (verify?.ok) parts.push(verify.enabled > 0
      ? `核实规则启用 ${verify.enabled}/${verify.total} 条，全部满足后自动核实`
      : '核实规则一条都没启用，不会自动核实，告警会一直停在“待核实”');
    if (counter?.ok) parts.push(counter.enabled > 0
      ? `反制规则启用 ${counter.enabled}/${counter.total} 条，全部满足且证据、设备等校验通过后自动发起；不满足时由有权限的人发起`
      : '反制规则一条都没启用，由有权限的人发起反制');
    return parts.length ? `规则管理里现在：${parts.join('；')}。` : '';
  }
  /* 这个流程对自动核实的要求和现在的开关对不上时，说清楚；没有要求或读不到就不说。 */
  function ruleConflict(flow, rules) {
    if (flow.guide?.prediction_only) return '';
    const want = flow.guide?.auto_verify, verify = rules?.verify;
    if (typeof want !== 'boolean' || !verify?.ok) return '';
    if (!want && verify.enabled > 0) return `和这个流程的要求不一致：自动核实现在是开着的（还有 ${verify.enabled} 条核实规则启用）。请先到规则管理关掉。`;
    if (want && verify.enabled === 0) return '和这个流程的要求不一致：自动核实现在是关着的，告警不会自动核实。请先到规则管理打开。';
    return '';
  }
  /* 当前流程随运行状态怎么走：载入 → 开始（出现新批次）→ 结束（停止、跑完、失败，或被别的运行顶掉）。 */
  function advance(current, data) {
    if (!current) return {current, event: null};
    const next = {...current}, fresh = data.batch && data.batch !== next.baseBatch;
    if (!next.startedBatch) {
      if (!fresh) return {current: next, event: null};
      next.startedBatch = data.batch;
      if (ENDED.includes(data.phase)) { next.ended = true; return {current: next, event: 'ended'}; }
      return {current: next, event: ACTIVE.includes(data.phase) ? 'started' : null};
    }
    if (!next.ended && (data.batch !== next.startedBatch || ENDED.includes(data.phase))) { next.ended = true; return {current: next, event: 'ended'}; }
    return {current: next, event: null};
  }
  function statusText(current, phase) {
    if (current.ended) return '已结束';
    return current.startedBatch ? PHASE_TEXT[phase] || '运行中' : '已载入，还没开始';
  }
  const items = list => `<ul>${(list || []).map(text => `<li>${esc(text)}</li>`).join('')}</ul>`;

  function selectVariant(flow, id) {
    if (!flow?.variants?.length) return flow;
    const variant = flow.variants.find(item => item.id === id)
      || flow.variants.find(item => item.id === flow.default_variant) || flow.variants[0];
    return {...flow, ...variant, title: flow.title, variant: variant.id, variantLabel: variant.label};
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = {rulesLine, ruleConflict, advance, statusText, selectVariant}; return; }

  const KEY = `${storeKey}-flow`;
  let flows = [], chosen = null, chosenVariant = null, rules = null, current = null, folded = false, loading = null;
  try { const saved = JSON.parse(localStorage.getItem(KEY)); if (saved?.flow && saved.startedBatch) current = saved; } catch {}

  const flowOf = (number, variant) => selectVariant(flows.find(item => item.flow === number), variant);
  const persist = () => { try { if (current?.startedBatch) localStorage.setItem(KEY, JSON.stringify(current)); else localStorage.removeItem(KEY); } catch {} };
  async function readFlows() { flows = (await api('acceptance-flows')).flows; return flows; }
  /* 规则状态只在登录且账号读得到时才有；读不到整行不显示。 */
  async function readRules() {
    if (!liveState?.connected) return null;
    try { return await api('external/automation-rules'); } catch { return null; }
  }

  let shown = '';
  /* 每 1.5 秒轮询一次，内容没变就不重画，免得按钮闪、焦点丢。 */
  function renderBanner() {
    const box = document.querySelector('#flow-banner'), flow = current && flowOf(current.flow, current.variant);
    const key = JSON.stringify([flow?.flow, current, liveState?.phase, folded]);
    if (key === shown) return;
    shown = key;
    if (!flow) { box.hidden = true; box.innerHTML = ''; return; }
    const g = flow.guide, phase = liveState?.phase;
    box.hidden = false;
    box.innerHTML = `<div class="flow-banner-head"><strong>流程 ${flow.flow} · ${esc(flow.title)}${flow.variantLabel ? ' · ' + esc(flow.variantLabel) : ''}</strong><span class="flow-chip">${esc(statusText(current, phase))}</span>
      <span class="flow-banner-actions"><button type="button" data-flow-banner="detail">完整说明</button><button type="button" data-flow-banner="switch">换一个流程</button><button type="button" data-flow-banner="fold">${folded ? '展开' : '收起'}</button></span></div>`
      + (folded ? '' : (current.reminder
        ? `<p class="flow-warning">这个流程已经结束。请回规则管理把自动核实打开，否则流程 1、2 不会自动核实。</p><div class="flow-banner-ack"><button type="button" class="primary" data-flow-banner="ack">我知道了</button></div>`
        : `${g.warning && !current.startedBatch ? `<p class="flow-warning">${esc(g.warning)}</p>` : ''}<div class="flow-banner-body"><b>你要做什么</b>${items(g.todo)}<p class="flow-foot">做完点“停止”，再选下一个流程。</p></div>`));
  }

  function detailHtml(flow, mode) {
    const g = flow.guide, line = rulesLine(rules, flow), conflict = rules ? ruleConflict(flow, rules) : '';
    const busy = typeof running === 'function' && running();
    const actions = mode === 'confirm'
      ? `<p class="flow-warning">当前草稿有没保存的修改。载入流程 ${flow.flow} 会覆盖它，这些修改不会保留。</p><button type="button" data-flow-pick-cancel>先不载入</button><button type="button" class="primary" data-flow-load-confirm>覆盖并载入</button>`
      : `<button type="button" class="primary" data-flow-load ${busy ? 'disabled' : ''}>载入并准备</button><span class="field-note">${busy ? '现在有任务在运行，请先点“停止”，再载入流程。' : '只载入这一个流程，还不会开始发送；载入后点页面底部的“开始模拟”才开始。'}</span>`;
    return `<h3>流程 ${flow.flow} · ${esc(flow.title)}</h3>
      <p class="flow-meta">自动跑 ${flow.minutes} 分钟，时间到自动停；中途也可以点“停止”。</p>
      ${flow.variants?.length ? `<label class="flow-variant">本次模拟情况<select data-flow-variant>${flow.variants.map(item => `<option value="${esc(item.id)}" ${item.id === flow.variant ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>` : ''}
      ${g.warning ? `<p class="flow-warning">${esc(g.warning)}</p>` : ''}
      <section><h4>这个流程演示什么</h4><p>${esc(g.shows)}</p></section>
      <section><h4>开始前要做什么</h4>${items(g.before)}${line ? `<p class="flow-rules">${esc(line)}</p>` : ''}${conflict ? `<p class="flow-warning">${esc(conflict)}</p>` : ''}</section>
      <section><h4>跑起来你会看到什么</h4>${items(g.sees)}</section>
      <section><h4>你要在平台上做什么</h4>${items(g.todo)}</section>
      <p class="flow-foot">做完点“停止”，再选下一个流程。</p>
      <div class="flow-actions">${actions}</div>`;
  }
  function paint(mode) {
    const flow = flowOf(chosen, chosenVariant), pane = document.querySelector('.flow-detail');
    if (!flow || !pane) return;
    pane.innerHTML = detailHtml(flow, mode);
    document.querySelectorAll('[data-flow-pick]').forEach(button => {
      const on = Number(button.dataset.flowPick) === chosen;
      button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
    });
  }

  async function open(preselect) {
    await readFlows();
    chosen = flowOf(preselect) ? preselect : flowOf(current?.flow) ? current.flow : flowOf(chosen) ? chosen : flows[0].flow;
    chosenVariant = current?.flow === chosen ? current.variant : null;
    rules = null;
    openDialog('选一个流程来跑', `<div class="flow-picker"><p class="field-note">一次只跑一个流程：左边选，右边看说明，点“载入并准备”。做完点“停止”，再选下一个。</p>
      <div class="flow-picker-grid"><nav class="flow-list" aria-label="流程列表">${flows.map(flow => `<button type="button" class="flow-item" data-flow-pick="${flow.flow}" aria-pressed="false"><b>流程 ${flow.flow}</b><span>${esc(flow.title)}</span><small>${flow.minutes} 分钟${flow.guide.warning ? ' · 要先改规则' : ''}</small></button>`).join('')}</nav>
      <section class="flow-detail" aria-live="polite"></section></div></div>`, 'wide');
    paint();
    readRules().then(value => { rules = value; if (!document.querySelector('#dialog-shell').hidden && document.querySelector('.flow-detail') && !document.querySelector('[data-flow-load-confirm]')) paint(); });
  }

  function load(flow) {
    if (running()) throw Error('现在有任务在运行，请先点“停止”，再载入流程');
    stop(); progress = 0; showRunPositions = false; displayedBatch = liveState?.batch || displayedBatch;
    state = structuredClone(flow.scene); selected = {kind: 'site', id: state.sites[0]?.id};
    syncSceneFields(); cancelDraw(); render(); window.SimulatorMap?.fit(scenePoints());
    draftUnsaved = false; document.querySelector('#save-status').textContent = `已载入流程 ${flow.flow}，还没有保存到浏览器`;
    current = {flow: flow.flow, variant: flow.variant || null, baseBatch: liveState?.batch || null, startedBatch: null, ended: false, reminder: false};
    persist(); renderBanner(); closeDialog();
    toast(`已载入流程 ${flow.flow}：${flow.title}。先看页面顶部“你要做什么”${flow.guide.warning ? '，' + flow.guide.warning : ''}，再点“开始模拟”`);
  }

  function clear() { current = null; folded = false; persist(); renderBanner(); }
  /* 换成别的场景（演示样本、导入、全量场景）就不再是这个流程了。 */
  function release() { if (current && !current.startedBatch) clear(); }

  function showReminder(flow) {
    openDialog(`流程 ${flow.flow} 已结束`, `<div class="start-check"><p class="flow-warning">请回规则管理把自动核实打开，否则流程 1、2 不会自动核实。</p>
      <p class="field-note">这个流程需要自动核实关着，所以跑之前让你关了它。模拟器不会替你开关规则，要你自己去打开。</p><p class="flow-rules" id="flow-reminder-rules"></p>
      <div class="form-actions">${btn('close-dialog', '稍后再说')}<button type="button" class="primary" data-flow-banner="ack">我已经打开了</button></div></div>`);
    readRules().then(value => { const verify = value?.verify; const note = document.querySelector('#flow-reminder-rules');
      if (note && verify?.ok) note.textContent = verify.enabled > 0 ? '模拟器刚读到：核实规则现在是开着的。' : '模拟器刚读到：核实规则现在还是关着的，别忘了打开。'; });
  }

  function onRuntime(data) {
    if (!current) return;
    const step = advance(current, data);
    current = step.current;
    if (step.event === 'ended') {
      const flow = flowOf(current.flow, current.variant);
      if (flow?.guide.auto_verify === false) {
        current.reminder = true;
        if (document.querySelector('#dialog-shell').hidden) showReminder(flow);
      } else { clear(); return; }
    }
    if (step.event) persist();
    renderBanner();
  }

  /* 流程 4 要求自动核实关着：开始前再问一遍，并看一眼规则现在的开关。 */
  const needsConfirm = () => !!current && !current.startedBatch && flowOf(current.flow, current.variant)?.guide.auto_verify === false;
  async function confirmStart(go) {
    const flow = flowOf(current.flow, current.variant), found = await readRules(), conflict = found ? ruleConflict(flow, found) : '';
    openDialog('开始前确认', `<div class="start-check"><p class="flow-warning">${esc(flow.guide.warning || '')}</p>
      <p>流程 ${flow.flow} 要让告警一直停在“待核实”，由值班员来判断，所以自动核实必须是关着的。</p>
      ${conflict ? `<p class="flow-warning">${esc(conflict)}</p>` : found ? '<p class="flow-rules">模拟器刚读到：核实规则现在是关着的。</p>' : ''}
      <p><b>你已经在规则管理里把自动核实关掉了吗？</b></p>
      <div class="form-actions">${btn('close-dialog', '还没有，我先去关')}<button type="button" class="primary" data-flow-start>已经关掉了，开始</button></div></div>`);
    document.querySelector('[data-flow-start]').addEventListener('click', () => { closeDialog(); go(); });
  }

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-flow-pick],[data-flow-load],[data-flow-load-confirm],[data-flow-pick-cancel],[data-flow-banner]');
    if (!target) return;
    const guard = work => { try { work(); } catch (error) { toast(error.message); } };
    if (target.dataset.flowPick) { chosen = Number(target.dataset.flowPick); chosenVariant = null; paint(); return; }
    if (target.matches('[data-flow-pick-cancel]')) { paint(); return; }
    if (target.matches('[data-flow-load]')) { guard(() => { if (draftUnsaved) paint('confirm'); else load(flowOf(chosen, chosenVariant)); }); return; }
    if (target.matches('[data-flow-load-confirm]')) { guard(() => load(flowOf(chosen, chosenVariant))); return; }
    const action = target.dataset.flowBanner;
    if (action === 'fold') { folded = !folded; renderBanner(); }
    else if (action === 'ack') { closeDialog(); clear(); }
    else open(action === 'detail' ? current?.flow : undefined).catch(error => toast(error.message));
  });

  document.addEventListener('change', event => {
    if (!event.target.matches('[data-flow-variant]')) return;
    chosenVariant = event.target.value;
    paint();
    document.querySelector('[data-flow-variant]')?.focus();
  });

  if (current) readFlows().then(renderBanner).catch(() => {});
  root.FlowPicker = {open, onRuntime, clear: release, needsConfirm, confirmStart};
})(typeof window !== 'undefined' ? window : globalThis);
