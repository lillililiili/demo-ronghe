(function (root) {
  'use strict';
  /* “选择流程 1-8”：一次选一个流程。左边选，右边看这个流程演示什么、开始前要做什么、会看到什么、要在平台上做什么，
     点“载入并准备”只载入这一个；载入后地图页顶部一直显示“你要做什么”，直到停止或换流程。
     流程文件和说明都在服务端（acceptance_flows.py），模拟器不替人开关规则，只读地看一眼规则开了没有。 */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ACTIVE = ['PREPARING', 'RUNNING', 'PAUSED', 'STOPPING'];
  const ENDED = ['STOPPED', 'COMPLETED', 'FAILED'];
  const PHASE_TEXT = {PREPARING: '正在准备资料', RUNNING: '运行中', PAUSED: '已暂停', STOPPING: '正在停止'};

  /* 规则管理里核实、反制两组规则现在开没开（服务端只读取到的）；读不到的那一组不说。 */
  function rulesLine(rules, flow) {
    if (flow?.guide?.prediction_only) {
      const verify = rules?.verify;
      const parts = ['预警阶段由人工核实'];
      if (flow.guide.includes_observed_stage) {
        parts.push(verify?.ok
          ? verify.enabled > 0
            ? `实际入区后若尚未核实，启用的 ${verify.enabled}/${verify.total} 条核实规则全部满足且本区实测依据有效时自动核实`
            : '当前没有启用的核实规则，实际入区后仍需人工核实'
          : '实际入区后按后台核实规则判断；规则状态暂不可读取，请以平台结果为准');
      }
      parts.push('同一次风险已核实不重复核实，预测衍生风险仍须人工发起反制');
      return parts.join('；') + '。';
    }
    const verify = rules?.verify, counter = rules?.counter, parts = [];
    if (verify?.ok) parts.push(verify.enabled > 0
      ? `核实规则启用 ${verify.enabled}/${verify.total} 条，全部满足后自动核实`
      : '核实规则一条都没启用，不会自动核实，告警会一直停在“待核实”');
    if (counter?.ok) parts.push(counter.enabled > 0
      ? `反制规则启用 ${counter.enabled}/${counter.total} 条，全部满足且证据、设备等校验通过后自动发起；不满足时由有权限的人发起`
      : '反制规则一条都没启用，由有权限的人发起反制');
    return parts.length ? `规则管理里现在：${parts.join('；')}。` : '';
  }
  // Configuration is an explanation, not a frontend eligibility decision.
  function orderLine(rules, flow) {
    if (![1, 2, 3, 4, 5, 9].includes(flow?.flow)) return '';
    const policy = rules?.response_order;
    if (!policy?.ok) return '处置顺序配置暂不可读取，请以平台当前允许动作及阻断原因为准。';
    if (!policy.enabled) return '处置顺序：优先反制策略未启用，沿用通知优先流程。';
    const prediction = flow.guide?.prediction_only;
    if ((prediction && !policy.prediction_enabled) || (!prediction && !policy.observed_enabled))
      return '处置顺序：当前分支阶段未纳入优先策略，沿用通知优先；阶段变化后由平台重新判断。';
    const risk = policy.minimum_risk === 'MEDIUM' ? '中风险及以上' : '高风险';
    const scope = policy.scope_mode === 'AIRSPACES' ? '指定空域' : '全部空域';
    const schedule = policy.schedule_mode === 'DAILY' ? `${policy.start_time}—${policy.end_time}（北京时间）` : '全天';
    const wait = Number.isInteger(policy.max_wait_seconds) && policy.max_wait_seconds >= 5 && policy.max_wait_seconds <= 300
      ? `${policy.max_wait_seconds}秒` : '后台配置的最长等待时间';
    return `后台优先策略：${risk}，${scope}，${schedule}。命中时短信并行、反制优先；收到真实启动回执且风险持续后才拨电话，明确无法启动或失败立即进入电话资格判断，等待超过${wait}也可进入电话资格判断。实际是否命中、通道及授权条件以平台为准。`;
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

  function variantHtml(flow) {
    if (!flow?.variants?.length) return '';
    const current = flow.variants.find(item => item.id === flow.variant);
    const control = `<label class="flow-variant">${flow.variants.some(item => item.supplemental) ? '模拟起点' : '本次模拟情况'}<select data-flow-variant>${flow.variants.map(item => `<option value="${esc(item.id)}" ${item.id === flow.variant ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>`;
    if (!flow.variants.some(item => item.supplemental)) return control;
    return `<p class="flow-journey">${esc(current?.label || '区外预警 → 实际入区 → 按规则核实并处置')}</p>
      <details class="flow-supplemental"${current?.supplemental ? ' open' : ''}><summary>补充场景${current?.supplemental ? ' · 已选择' : ''}</summary>
      <p class="field-note">日常演示使用完整流程；需要验证首次发现就在区内的情况时，在这里切换。</p>${control}</details>`;
  }

  /* 阶段来自本次场景，时间只取本批次服务端进度；它描述模拟飞行，不代表平台业务办理结果。 */
  function sceneGuideModel(scene, current = null, runtime = null) {
    const started = Boolean(current?.startedBatch);
    if (current?.ended || (started && current.startedBatch !== runtime?.batch)) return null;
    const source = started ? (runtime?.source_scene || runtime?.scene) : scene;
    const guide = source?.sceneGuide;
    if (typeof guide?.summary !== 'string' || !guide.summary.trim() || !Array.isArray(guide.stages) || !guide.stages.length) return null;
    let previous = -1;
    const stages = [];
    for (const stage of guide.stages) {
      if (!stage || !Number.isFinite(stage.at_seconds) || stage.at_seconds < 0 || stage.at_seconds <= previous
        || typeof stage.label !== 'string' || !stage.label.trim() || typeof stage.description !== 'string') return null;
      stages.push({at_seconds: stage.at_seconds, label: stage.label, description: stage.description});
      previous = stage.at_seconds;
    }
    let activeIndex = -1;
    if (started && ['RUNNING', 'PAUSED'].includes(runtime?.phase) && Number.isFinite(runtime?.elapsed) && runtime.elapsed >= 0) {
      stages.forEach((stage, index) => { if (runtime.elapsed >= stage.at_seconds) activeIndex = index; });
    }
    return {summary: guide.summary, stages, activeIndex, paused: activeIndex >= 0 && runtime?.phase === 'PAUSED'};
  }

  function sceneGuideHtml(model, compact = false) {
    if (!model) return '';
    const active = model.stages[model.activeIndex];
    const stages = `<ol class="scene-guide-stages">${model.stages.map((stage, index) => `<li${index === model.activeIndex ? ' aria-current="step"' : ''}><span class="scene-guide-time">${stage.at_seconds === 0 ? '开始' : `约 ${Math.round(stage.at_seconds)} 秒`}</span><b>${esc(stage.label)}</b>${compact ? '' : `<span>${esc(stage.description)}</span>`}</li>`).join('')}</ol>`;
    if (compact) return `<section class="scene-guide scene-guide-compact" aria-label="模拟飞行阶段"><p class="scene-guide-summary" title="${esc(model.summary)}">路线：${esc(model.summary)}</p>${stages}
      <p class="scene-guide-current" role="status"><b>${active ? (model.paused ? '模拟已暂停：' : '当前模拟阶段：') : '开始后：'}</b>${active ? esc(active.description) : '在融合感知选中无人机，查看未来位置和平台预警。'}</p></section>`;
    const title = active ? `模拟飞行阶段${model.paused ? ' · 已暂停' : ''}：${esc(active.label)}` : '模拟航线导读';
    return `<section class="scene-guide"><h4>${title}</h4><p class="scene-guide-summary">${esc(model.summary)}</p>${stages}
      <p class="scene-guide-note">阶段按模拟航线和运行进度显示；预警、核实、通知和反制结果以平台为准。</p></section>`;
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = {rulesLine, orderLine, ruleConflict, advance, statusText, selectVariant, variantHtml, sceneGuideModel, sceneGuideHtml}; return; }

  const KEY = `${storeKey}-flow`;
  let flows = [], compatibilityFlows = [], chosen = null, chosenVariant = null, rules = null, current = null, folded = false, loading = null;
  try { const saved = JSON.parse(localStorage.getItem(KEY)); if (saved?.flow && saved.startedBatch) current = saved; } catch {}

  const flowOf = (number, variant) => selectVariant([...flows, ...compatibilityFlows].find(item => item.flow === number), variant);
  const persist = () => { try { if (current?.startedBatch) localStorage.setItem(KEY, JSON.stringify(current)); else localStorage.removeItem(KEY); } catch {} };
  async function readFlows() { const result = await api('acceptance-flows'); flows = result.flows; compatibilityFlows = result.compatibility_flows || []; return flows; }
  /* 规则状态只在登录且账号读得到时才有；读不到整行不显示。 */
  async function readRules() {
    if (!liveState?.connected) return null;
    try { return await api('external/automation-rules'); } catch { return null; }
  }

  let shown = '';
  /* 每 1.5 秒轮询一次，内容没变就不重画，免得按钮闪、焦点丢。 */
  function renderBanner() {
    const box = document.querySelector('#flow-banner'), flow = current && flowOf(current.flow, current.variant);
    const sceneGuide = sceneGuideModel(flow?.scene, current, liveState);
    // 模型只保存阶段索引，不保存逐秒进度，因此同一阶段内的轮询不会重建按钮或丢失焦点。
    const key = JSON.stringify([flow?.flow, flow?.guide, current, liveState?.phase, folded, sceneGuide]);
    if (key === shown) return;
    shown = key;
    if (!flow) { box.hidden = true; box.innerHTML = ''; return; }
    const g = flow.guide, phase = liveState?.phase;
    box.hidden = false;
    box.innerHTML = `<div class="flow-banner-head"><strong>流程 ${flow.flow} · ${esc(flow.title)}${flow.variantLabel ? ' · ' + esc(flow.variantLabel) : ''}</strong><span class="flow-chip">${esc(statusText(current, phase))}</span>
      <span class="flow-banner-actions"><button type="button" data-flow-banner="detail">完整说明</button><button type="button" data-flow-banner="switch">换一个流程</button><button type="button" data-flow-banner="fold">${folded ? '展开' : '收起'}</button></span></div>`
      + (folded ? '' : (current.reminder
        ? `<p class="flow-warning">这个流程已经结束。请回规则管理把自动核实打开，否则实际入区后不会自动核实。</p><div class="flow-banner-ack"><button type="button" class="primary" data-flow-banner="ack">我知道了</button></div>`
        : `${g.warning && !current.startedBatch ? `<p class="flow-warning">${esc(g.warning)}</p>` : ''}${sceneGuide ? sceneGuideHtml(sceneGuide, true) : `<div class="flow-banner-body"><b>你要做什么</b>${items(g.todo)}<p class="flow-foot">做完点“停止”，再选下一个流程。</p></div>`}`));
  }

  function detailHtml(flow, mode) {
    const g = flow.guide, line = rulesLine(rules, flow), conflict = rules ? ruleConflict(flow, rules) : '';
    const busy = typeof running === 'function' && running();
    const actions = mode === 'confirm'
      ? `<p class="flow-warning">当前草稿有没保存的修改。载入流程 ${flow.flow} 会覆盖它，这些修改不会保留。</p><button type="button" data-flow-pick-cancel>先不载入</button><button type="button" class="primary" data-flow-load-confirm>覆盖并载入</button>`
      : `<button type="button" class="primary" data-flow-load ${busy ? 'disabled' : ''}>载入并准备</button><span class="field-note">${busy ? '现在有任务在运行，请先点“停止”，再载入流程。' : '只载入这一个流程，还不会开始发送；载入后点页面底部的“开始模拟”才开始。'}</span>`;
    return `<h3>流程 ${flow.flow} · ${esc(flow.title)}</h3>
      <p class="flow-meta">自动跑 ${flow.minutes} 分钟，时间到自动停；中途也可以点“停止”。</p>
      ${variantHtml(flow)}
      ${g.warning ? `<p class="flow-warning">${esc(g.warning)}</p>` : ''}
      <section><h4>这个流程演示什么</h4><p>${esc(g.shows)}</p></section>
      ${sceneGuideHtml(sceneGuideModel(flow.scene))}
      <section><h4>开始前要做什么</h4>${items(g.before)}${line ? `<p class="flow-rules">${esc(line)}</p>` : ''}${orderLine(rules, flow) ? `<p class="flow-rules">${esc(orderLine(rules, flow))}</p>` : ''}${conflict ? `<p class="flow-warning">${esc(conflict)}</p>` : ''}</section>
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
    const daily = number => flows.some(flow => flow.flow === number);
    chosen = daily(preselect) ? preselect : daily(current?.flow) ? current.flow : daily(chosen) ? chosen : flows[0].flow;
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
    openDialog(`流程 ${flow.flow} 已结束`, `<div class="start-check"><p class="flow-warning">请回规则管理把自动核实打开，否则实际入区后不会自动核实。</p>
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
    const control = document.querySelector('[data-flow-variant]'), supplemental = control?.closest('details');
    if (supplemental && !supplemental.open) supplemental.querySelector('summary')?.focus();
    else control?.focus();
  });

  if (current) readFlows().then(renderBanner).catch(() => {});
  root.FlowPicker = {open, onRuntime, clear: release, needsConfirm, confirmStart};
})(typeof window !== 'undefined' ? window : globalThis);
