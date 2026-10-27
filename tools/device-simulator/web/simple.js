'use strict';
/* 新版主页面（index.html）的摆法。功能还是原来那些脚本（app.js、runtime.js、realtime.js、fullchain.js、video-control.js……），
   这里只做四件事：
   1. 左边“添加”栏、右边按对象分块的设置、顶部运行栏、底部“运行情况”——把各脚本自己插进页面的按钮和文字挪到这些位置；
   2. 右侧设置换成分块说明的写法（常用的在上面，其余收进“更多设置”），字段名和原来一样，保存逻辑不变；
   3. 设备组里的“反制设备”就是四通道反制设备：开始前把它所在点位的位置、所属单位写进实时收发设置，它本身不作为 MQTT 设备登记（send:false）；
   4. 去掉人员、车辆、船舶、遥控器四种目标。
   原版页面（classic.html）不加载这个文件，行为不变。 */
(() => {
  const hiddenTargetKinds = ['person', 'vehicle', 'ship', 'remote_controller'];
  for (const kind of hiddenTargetKinds) { const at = targetKinds.indexOf(kind); if (at >= 0) targetKinds.splice(at, 1); }
  const COUNTER = 'countermeasure';
  let realtimeConfig = null, scopes = null, scopesSession = null;
  const lonLat = site => [(118.56 + site.x * .00012).toFixed(6), (37.50 - site.y * .00012).toFixed(6)];
  const counterDevices = () => state.sites.flatMap(site => site.devices.filter(d => d.kind === COUNTER).map(device => ({device, site})));

  /* —— 反制设备：设备组里的那一台就是四通道设备 —— */
  function normalizeCounter() {
    let changed = false;
    for (const {device} of counterDevices()) {
      if (device.send !== false) { device.send = false; changed = true; }
      if (device.scope === undefined) { device.scope = ''; changed = true; }
    }
    // 载入的场景（流程、样本、导入）里没有画反制设备，而实时收发设置是开着的：按服务端原来的规矩放在第一台雷达所在的点位。
    if (realtimeConfig?.countermeasure_enabled && !counterDevices().length && state.sites.length) {
      const site = state.sites.find(s => s.devices.some(d => d.kind === 'radar')) || state.sites[0];
      const device = createDevice(COUNTER, site.devices);
      device.send = false; device.scope = realtimeConfig.countermeasure_scope || '';
      site.devices.push(device); changed = true;
    }
    return changed;
  }
  // 服务端原来的规矩：没填位置时，反制设备放在场景第一台雷达所在的点位。设备就在那个点位时位置留空，只有放到别处才写明。
  const defaultCounterSite = () => state.sites.find(s => s.devices.some(d => d.kind === 'radar'));
  function counterConfig() {
    const found = counterDevices()[0];
    if (!found) return {countermeasure_enabled: false};
    const explicit = found.site !== defaultCounterSite();
    const [lon, lat] = explicit ? lonLat(found.site).map(Number) : [null, null];
    return {countermeasure_enabled: true, countermeasure_scope: found.device.scope || '', countermeasure_longitude: lon, countermeasure_latitude: lat};
  }
  const receiverBusy = () => ['STARTING', 'RUNNING', 'STOPPING'].includes(liveState?.realtime?.state);
  const syncNote = () => document.getElementById('counter-sync-note');
  async function beforeStart() {
    if (liveState?.scene_mode === 'isolated_qa') return;
    let config;
    try { config = await api('realtime/config'); } catch { return; }
    const wanted = counterConfig();
    const differs = Object.keys(wanted).some(key => JSON.stringify(config[key] ?? null) !== JSON.stringify(wanted[key] ?? null));
    if (!differs) { realtimeConfig = config; if (syncNote()) syncNote().textContent = ''; return; }
    // 接收端在两次模拟之间一直开着，开着时服务端不让改收发设置；这时不改、也不挡“开始”，只提示一句。
    if (receiverBusy()) {
      if (syncNote()) syncNote().textContent = '反制设备的单位或位置有改动：要先在“运行方式”里停止接收端，再点“开始”才会生效。';
      realtimeConfig = config; return;
    }
    realtimeConfig = await api('realtime/config', {...config, ...wanted});
    if (syncNote()) syncNote().textContent = '';
  }
  function payload(current) {
    const copy = structuredClone(current);
    copy.sites.forEach(site => site.devices.forEach(d => { if (d.kind === COUNTER) d.send = false; }));
    return copy;
  }
  window.SimpleLayout = {hiddenTargetKinds, payload, beforeStart};

  /* —— 把各脚本插进页面的按钮和文字挪到新位置 —— */
  const $$ = id => document.getElementById(id);
  const move = (id, host) => { const node = $$(id); if (node && host) host.append(node); return node; };
  const menu = $$('scene-tools-menu');
  const action = name => menu.querySelector(`[data-action=${name}]`);
  const flows = action('prepare-acceptance-flows'); flows.textContent = '选择流程（1–8、10）';
  const save = document.createElement('button'); save.dataset.action = 'save'; save.textContent = '保存场景';
  const title = text => { const node = document.createElement('div'); node.className = 'menu-title'; node.textContent = text; return node; };
  const rule = () => document.createElement('hr');
  const fullchainLoad = $$('fullchain-load'); fullchainLoad.textContent = '全量场景';
  menu.replaceChildren(title('载入'), flows, action('load-demo'), fullchainLoad, action('mock-airport'), rule(), save, action('export-scene'), action('import-scene'), action('restore-draft'), rule(), title('更多'), $$('fullchain-edit'), $$('fullchain-start'), $$('scene-file'));
  menu.addEventListener('click', event => { if (event.target.closest('button')) $$('scene-tools').open = false; });
  move('video-settings', $$('video-settings-slot'));
  move('video-toggle', $$('status-video-toggle-slot'));
  move('video-summary', $$('video-summary-slot'));
  move('pause-mqtt', $$('status-pause-slot'));
  const errors = $$('status-errors');
  for (const id of ['mqtt-error', 'realtime-error', 'video-error']) move(id, errors);
  move('error-detail', errors);
  const syncNoteEl = document.createElement('p'); syncNoteEl.id = 'counter-sync-note'; syncNoteEl.className = 'muted'; errors.append(syncNoteEl);
  const runMode = $$('run-mode-realtime');
  move('realtime-start', runMode); move('realtime-stop', runMode);
  move('realtime-settings', runMode).hidden = true;  // 由“修改运行方式…”代点
  const more = $$('status-more-menu');
  move('fullchain-verify', more).hidden = true;  // 回读平台数据只放在“运行记录”里
  more.append(title('连接情况'), $$('mqtt-summary'), $$('realtime-summary'), $$('realtime-detail'), title('全量场景'), $$('fullchain-coverage').closest('details') || $$('fullchain-coverage'));
  document.querySelectorAll('.realtime-bar,.mqtt-bar').forEach(node => node.remove());
  for (const id of ['run-mode', 'status-more']) {
    document.addEventListener('click', event => { if (!$$(id).contains(event.target)) $$(id).open = false; });
  }
  const dockTitle = {plans: '飞行任务申报', weather: '气象预报输入', airspaces: '空域下发'};
  const initialInput = new URLSearchParams(location.search).get('input');
  if (dockTitle[initialInput]) $$('dock-title').textContent = dockTitle[initialInput];

  /* —— 底部“运行情况”说人话 —— */
  const phaseText = {IDLE: '未开始', PREPARING: '正在准备资料', RUNNING: '正在发送', PAUSED: '已暂停', STOPPING: '正在停止', STOPPED: '已停止', COMPLETED: '已跑完', FAILED: '出错了'};
  const modeText = {normal: '正常', abnormal: '异常', mixed: '混合'};
  const stateText = {STOPPED: '已停止', STARTING: '启动中', RUNNING: '运行中', STOPPING: '停止中', FAILED: '失败'};
  const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}) : '尚无';
  function renderStatus(data) {
    const rt = data.realtime, mode = modeText[rt?.config?.mode] || '正常', isolated = data.scene_mode === 'isolated_qa';
    $$('run-mode-label').textContent = isolated ? '隔离测试' : mode;
    const progress = data.batch && ['RUNNING', 'PAUSED'].includes(data.phase)
      ? `（${data.duration === 0 ? '已运行 ' + Math.floor(data.elapsed) + ' 秒' : Math.floor(data.elapsed) + ' / ' + Math.floor(data.duration) + ' 秒'}）` : '';
    $$('status-mode').textContent = `${isolated ? '隔离测试场景' : mode + '模式'} · ${phaseText[data.phase] || data.phase || '未开始'}${progress}`;
    $$('status-sent').textContent = `设备上报 已发 ${data.sent || 0} 条`;
    $$('status-last').textContent = `最近上报 ${time(data.last_published_at)}`;
    const tcp = rt?.countermeasure || {}, n = rt?.notifications || {};
    $$('status-counter').textContent = isolated ? '反制设备 本模式不启用' : `反制设备 ${tcp.listening ? '已接上 · 收到指令 ' + (tcp.received || 0) + ' 次' : '未连接'}`;
    $$('status-notify').textContent = isolated ? '短信电话 本模式不启用' : `短信电话 收到 ${n.received_count || 0} / 已回执 ${n.receipt_count || 0}`;
    $$('run-mode-note').textContent = isolated ? '隔离测试场景模式下没有实时收发。'
      : rt ? `接收端：${stateText[rt.state] || rt.state}。点“开始”会自动启动接收端；下面两个按钮只在要单独开关接收端时用。` : '';
    $$('stop-button').textContent = '停止';
  }
  const realtimeUpdate = window.RealtimeUI.update;
  window.RealtimeUI.update = data => {
    realtimeUpdate(data);
    try { renderStatus(data); } catch (error) { console.error(error); }
    if (data.realtime?.config) {
      realtimeConfig = data.realtime.config;
      if (normalizeCounter()) { renderTree(); renderInspector(); renderMap(); }
    }
    loadScopes(data);
  };
  async function loadScopes(data) {
    if (!data.connected) { scopes = null; scopesSession = null; return; }
    if (scopesSession === data.session_version) return;
    scopesSession = data.session_version;
    try { scopes = (await api('external/request', {method: 'GET', path: '/local-interface-simulator/airspaces/context'})).scopes || []; }
    catch { scopes = []; }
    if (selected.kind === 'site' && !running()) renderInspector();
  }

  /* —— 平台风险判定：底部按钮弹出原来的判定面板 —— */
  const riskButton = $$('risk-button');
  function riskLabel() {
    const collapsed = document.body.classList.contains('risks-collapsed');
    riskButton.textContent = `平台风险判定 ${state.risks.length} ${collapsed ? '▴' : '▾'}`;
    riskButton.setAttribute('aria-expanded', String(!collapsed));
  }
  riskButton.addEventListener('click', () => { $$('toggle-risks').click(); riskLabel(); });
  $$('toggle-risks').addEventListener('click', () => setTimeout(riskLabel));
  const baseRenderRisks = renderRisks;
  renderRisks = function () { baseRenderRisks(); riskLabel(); };

  /* —— 右侧设置：按对象分块 —— */
  const seg = (name, value, options, cls = '') => `<div class="seg ${cls}">${options.map(o => `<label class="${o.bad ? 'bad' : ''}"><input type="radio" name="${name}" value="${esc(o.value)}" ${String(value) === String(o.value) ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>`;
  const moreBox = (summary, inner) => `<details class="more"><summary>更多设置（${esc(summary)}）</summary><div>${inner}</div></details>`;
  const datumField = (label, value) => selectField(label, 'altitudeDatum', value || 'AMSL', [{value: 'AMSL', label: '海拔高度 AMSL'}, {value: 'AGL', label: '离地高度 AGL'}]) + '<div class="readout">与目标同基准高度比较；缺失时由系统保留未知</div>';
  function scopeOptions(current) {
    const list = [{value: '', label: '跟随模拟器连接的单位与区县'}];
    for (const s of scopes || []) list.push({value: `${s.owner_org_id}|${s.district_id}`, label: `${s.owner_org_name || s.owner_org_id} · ${s.district_name || s.district_id}`});
    if (current && !list.some(o => o.value === current)) list.push({value: current, label: '已保存的单位与区县（不在当前读取范围）'});
    return list;
  }
  function targetForm(x) {
    const kinds = targetKinds.includes(x.kind) ? targetKinds : [...targetKinds, x.kind];
    const reporters = opts(devices().filter(d => targetDeviceKinds.includes(d.kind)).map(d => ({id: d.id, name: `${d.name}（${d.siteName}）`})), '请选择上报设备');
    const nearby = auxiliaryDevicesFor(x).map(d => ({...d, name: `${d.name} · ${labels[d.kind] || d.kind} · ${d.siteName} · ${formatDistance(d.distanceMetres)}`}));
    let html = `<div class="field-pair wide-first">${field('名称', 'name', x.name, 'text', 'required maxlength="60"')}${selectField('目标类别', 'kind', x.kind, kinds.map(k => ({value: k, label: labels[k] || k})))}</div>`;
    html += `<div class="field-pair">${field('高度（米）', 'height', x.height, 'number', 'min="0" max="10000" required')}${field('速度（米/秒）', 'speed', x.speed, 'number', 'min="0" max="100" required')}</div>`;
    if (x.kind === 'bird') html += field('数量（只）', 'count', x.count, 'number', 'min="1" max="100" required');
    html += '<p class="seg-label">路线</p>' + btn('edit-target-path', `在地图上画路线（已画 ${x.path.length} 个点）`, 'wide cyan-button');
    html += '<p class="seg-label">怎么飞</p>' + seg('motionMode', x.motionMode || 'once', [{value: 'once', label: '到终点停留'}, {value: 'pingpong', label: '原路往返'}, {value: 'loop', label: '闭合循环'}]);
    html += selectField('报备任务', 'planId', x.planId, opts(state.plans, '不关联任务'));
    html += window.NotificationUI.fields(x);
    html += selectField('上报设备', 'deviceId', x.deviceId, reporters);
    html += moreBox('上报通道、高度基准、逐航点高度和停留、暂停上报时段、辅助上报设备、离地高度、识别概率',
      selectField('上报通道', 'transport', x.transport || (x.altitudeDatum || x.kind === 'balloon' ? 'normalized' : 'mqtt'), [{value: 'mqtt', label: 'MQTT 设备协议'}, {value: 'normalized', label: '规范化观测'}])
      + '<p class="field-note">保存后保持所选上报通道。MQTT 高度按设备协议解释；AGL 须手动选择规范化观测。</p>'
      + selectField('高度基准', 'altitudeDatum', x.altitudeDatum || (x.transport === 'normalized' || x.kind === 'balloon' ? 'AMSL' : ''), [{value: '', label: '未知（设备协议未声明）'}, {value: 'AMSL', label: '海拔 AMSL'}, {value: 'AGL', label: '离地 AGL（规范化观测）'}])
      + field('逐航点高度（米，逗号分隔，可留空）', 'altitudePathInput', (x.altitudePath || []).join(', '))
      + field('逐航点停留（秒，逗号分隔，可留空）', 'dwellSecondsInput', (x.dwellSeconds || []).join(', '))
      + field('暂停上报时段（开始秒:持续秒，逗号分隔）', 'silenceWindowsInput', (x.silenceWindows || []).map(w => `${w.at}:${w.seconds}`).join(', '))
      + `<p class="field-note">当前路线 ${x.path.length} 个航点；逐航点数值须与航点数一致。闭合循环会沿末点到起点移动，原路往返沿原路返回。</p>`
      + selectField('辅助上报设备', 'secondaryDeviceId', x.secondaryDeviceId || '', opts(nearby, '不使用辅助设备'))
      + '<p class="field-note">显示目标整条路线周边 5 公里内的所有设备；当前主上报设备已排除。只有支持目标观测协议的设备会产生辅助目标报文，光电、气象和反制设备仍按各自协议上报。</p>'
      + `<div class="field-pair">${field('模拟离地高度（米，可留空）', 'heightAgl', x.heightAgl ?? '', 'number', 'min="0" max="10000" step="0.1"')}${field('模拟识别概率（0—1，可留空）', 'probability', x.probability ?? '', 'number', 'min="0" max="1" step="0.01"')}</div>`);
    return html;
  }
  function siteForm(x) {
    const [lon, lat] = lonLat(x);
    let html = field('名称', 'name', x.name, 'text', 'required maxlength="60"') + btn('relocate-site', '在地图上挪位置', 'wide cyan-button') + '<p class="seg-label">这里的设备</p>';
    let counters = 0, intervals = '';
    for (const d of x.devices) {
      intervals += field(`${d.name} 心跳间隔（秒）`, `interval_${d.id}`, d.interval, 'number', 'min="1" max="300" required');
      if (d.kind === COUNTER) {
        counters++;
        html += `<div class="device-row"><h3>${esc(d.name)}<small>四通道</small></h3><input type="hidden" name="health_${d.id}" value="${esc(d.health)}"><input type="hidden" name="heartbeat_${d.id}" value="${esc(d.heartbeat)}">${selectField('所属单位与区县', `scope_${d.id}`, d.scope || '', scopeOptions(d.scope))}<p class="field-note">${counters > 1 ? '一个场景只有第一台反制设备在工作，这一台不生效。' : (scopes ? '' : '登录系统后这里才能选单位与区县。') + '开始模拟时按这个点位的位置登记到平台，反制指令从 TCP 四通道收；归属只决定设备属于谁，不授予反制权限。'}</p></div>`;
        continue;
      }
      html += `<div class="device-row"><h3>${esc(d.name)}<small>${esc(labels[d.kind] || d.kind)}</small></h3><div class="seg-pair">${seg(`health_${d.id}`, d.health, [{value: '正常', label: '正常'}, {value: '故障', label: '故障', bad: true}])}${seg(`heartbeat_${d.id}`, d.heartbeat, [{value: '持续上报', label: '持续心跳'}, {value: '停止心跳', label: '停止心跳', bad: true}], 'heartbeat')}</div></div>`;
    }
    html += '<div class="subheading">再加一台设备</div>' + selectField('设备类型', 'newKind', deviceKinds[0], deviceKinds.map(v => ({value: v, label: labels[v]}))) + btn('add-device', '添加到此点位', 'wide');
    html += moreBox('心跳间隔、经纬度',
      `<div class="field-pair">${field('经度（WGS84）', 'lon', lon, 'number', 'step="0.000001" min="-180" max="180" required')}${field('纬度（WGS84）', 'lat', lat, 'number', 'step="0.000001" min="-85" max="85" required')}</div>` + intervals);
    return html;
  }
  function planForm(x) {
    const uavs = state.targets.filter(t => t.kind === 'uav');
    let html = field('任务名称', 'name', x.name, 'text', 'required maxlength="60"') + '<p class="seg-label">航线</p>' + btn('redraw-object', `在地图上画航线（已画 ${x.points.length} 个点）`, 'wide cyan-button');
    html += `<div class="field-pair">${field('开始（北京时间）', 'start', x.start, 'time', 'required')}${field('结束', 'end', x.end, 'time', 'required')}</div><p class="field-note" id="plan-window-note"></p>`;
    html += `<div class="field-triple">${field('最低高度（米）', 'min', x.min, 'number', 'min="0" required')}${field('最高高度（米）', 'max', x.max, 'number', 'min="0" max="10000" required')}${field('走廊宽度（米）', 'width', x.width, 'number', 'min="1" required')}</div>`;
    html += '<p class="seg-label">执行无人机</p><div class="executor-list">' + (uavs.length ? uavs.map(t => `<label><input type="checkbox" data-executor="${esc(t.id)}" ${t.planId === x.id ? 'checked' : ''}>${esc(t.name)}</label>`).join('') : '<span class="muted">场景里还没有无人机，先从左边“添加”里放一架</span>') + '</div>';
    html += `<p class="seg-label">报送到平台</p><button type="button" class="wide primary" data-simple="plan-submit" data-id="${esc(x.id)}">提交任务（填申报资料）</button><p class="submit-note">不点也行，开始模拟时会一起报送。任务来源、报备单位档案、执行飞手档案和申报资料在提交任务的表里填。</p>`;
    html += moreBox('高度基准', datumField('任务高度基准', x.altitudeDatum));
    return html;
  }
  function zoneForm(x) {
    let html = field('名称', 'name', x.name, 'text', 'required maxlength="60"') + '<p class="seg-label">种类</p>' + seg('kindCode', x.kindCode || '', Object.entries(airspaceKinds).map(([value, label]) => ({value, label})), 'wrap');
    html += field('区域限高（米）', 'max', x.max, 'number', 'min="0" max="10000" required');
    html += '<p class="field-note">区域在开始模拟时按北京时间当天全天（00:00 到 23:59）有效。要让区域只在某个时段生效，用下面的“空域下发”。</p>';
    html += `<button type="button" class="wide cyan-button" data-simple="redraw-zone" data-id="${esc(x.id)}">在地图上改边界</button>`;
    html += `<p class="seg-label">空域下发</p><button type="button" class="wide primary" data-simple="zone-issue" data-id="${esc(x.id)}">提交下发 / 撤销（打开下发表）</button><p class="submit-note">下发表里填归属单位与区县、生效时间、下发原因，也能导入 GeoJSON、看接收回执。</p>`;
    html += moreBox('高度基准', datumField('区域高度基准', x.altitudeDatum));
    return html;
  }
  renderInspector = function () {
    const x = lookup(selected.kind, selected.id);
    if (!x) { $('#inspector-title').textContent = '对象设置'; $('#inspector').innerHTML = '<div class="empty">从左边“添加”里挑一样放到地图上，或点地图上的对象<br>在这里改它的设置</div>'; return; }
    $('#inspector-title').textContent = x.name;
    const html = selected.kind === 'risk' ? riskFields(x) : selected.kind === 'site' ? siteForm(x) : selected.kind === 'target' ? targetForm(x) : selected.kind === 'plan' ? planForm(x) : zoneForm(x);
    $('#inspector').innerHTML = `<section id="notification-progress" class="notification-progress" hidden></section><form id="inspector-form">${html}<p class="inline-error" role="alert"></p><div class="form-actions"><button type="submit" class="primary">${selected.kind === 'risk' ? '保存判定条件' : '应用设置'}</button></div></form>`;
    window.NotificationUI.estimate(); window.NotificationUI.progress(); window.NotificationUI.lock(); updatePlanWindowNote();
  };
  // 新版表单多出来的两项（反制设备所属单位、执行无人机）在 app.js 保存之前先记到场景里；其余字段仍由 app.js 保存。
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.id !== 'inspector-form' || running()) return;
    const x = lookup(selected.kind, selected.id);
    if (!x) return;
    if (selected.kind === 'site') {
      for (const d of x.devices) if (d.kind === COUNTER) { d.scope = form.elements[`scope_${d.id}`]?.value || ''; d.send = false; }
    }
    if (selected.kind === 'plan') {
      form.querySelectorAll('[data-executor]').forEach(box => {
        const target = lookup('target', box.dataset.executor);
        if (!target) return;
        if (box.checked) target.planId = x.id; else if (target.planId === x.id) target.planId = '';
      });
    }
  }, true);
  document.addEventListener('click', event => {
    const el = event.target.closest('[data-simple]');
    if (!el) return;
    const what = el.dataset.simple, workspace = window.SimulatorWorkspace;
    if (what === 'weather') { if (draw) return toast('请先完成或取消当前绘制'); $$('dock-title').textContent = dockTitle.weather; workspace.openInput('weather'); }
    if (what === 'plan-submit') { selected = {kind: 'plan', id: el.dataset.id}; $$('dock-title').textContent = dockTitle.plans; workspace.openInput('plans'); }
    if (what === 'zone-issue') { $$('dock-title').textContent = dockTitle.airspaces; workspace.openAirspace(el.dataset.id); }
    if (what === 'redraw-zone') setDraw('zone', el.dataset.id);
    if (what === 'realtime-settings') { $$('run-mode').open = false; $$('realtime-settings').click(); }
  });
  render();
  riskLabel();
})();
