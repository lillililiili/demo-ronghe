'use strict';
const $ = id => document.getElementById(id);
let scopes = [], busy = false, polling = false, currentState = 'STOPPED';
async function api(path, body) {
  const response = await fetch('/api/tcp-radar/' + path, {method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {'Content-Type':'application/json'},body: body === undefined ? undefined : JSON.stringify(body)});
  if (response.status === 404) throw Error('TCP 雷达模块尚未加载，请重新加载模拟器服务后再试');
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '操作失败，请刷新后重试');
  return value;
}
function controls() {
  $('start').disabled = busy || currentState === 'RUNNING' || !scopes.length;
  $('stop').disabled = busy || currentState !== 'RUNNING';
  $('scope').disabled = busy || currentState === 'RUNNING';
  for (const input of document.querySelectorAll('#config input')) input.disabled = busy || currentState === 'RUNNING';
}
function render(value) {
  currentState = value.state;
  $('state').textContent = ({RUNNING:'● 正在发送',STOPPED:'○ 已停止',FAILED:'! 发送失败'})[value.state] || value.state;
  $('connection').textContent = value.connected ? '已连接 · 数据登录成功' : '等待平台连接';
  if (value.state !== 'RUNNING') $('connection').textContent = '未连接';
  $('frames').textContent = value.frames_sent;
  $('sent').textContent = value.last_sent_at ? new Date(value.last_sent_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) + '（北京时间）' : '—';
  $('device').textContent = value.device_id ? value.device_name + ' · ' + value.device_no : '尚未登记';
  if (value.error) $('message').textContent = value.error;
  else if (value.state === 'RUNNING') $('message').textContent = value.connected
    ? '原生协议已连接，正在持续发送模拟 RTK 和航迹。'
    : 'TCP 雷达已启动，正在等待平台建立原生协议连接。';
  controls();
}
async function refresh() {
  if (polling || busy) return;
  polling = true;
  try { render(await api('status')); }
  catch (error) { $('message').textContent = '状态更新失败，当前显示为上次结果：' + error.message; }
  finally { polling = false; }
}
$('config').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  if ($('scope').value === '') return;
  const scope = scopes[Number($('scope').value)]; if (!scope) return;
  const data = new FormData(event.target);
  busy = true; controls(); $('message').textContent = '正在登记并启动 TCP 雷达…';
  try {
    const result = await api('start', {owner_org_id:scope.org_id,district_id:scope.district_id,
      longitude:Number(data.get('longitude')),latitude:Number(data.get('latitude'))});
    render(result);
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; controls(); }
});
$('stop').addEventListener('click', async () => {
  busy = true; controls();
  try { render(await api('stop', {})); $('message').textContent = 'TCP 模拟发送已停止；平台将按实际连接状态判断离线。'; }
  catch (error) { $('message').textContent = error.message; }
  finally { busy = false; controls(); }
});
$('refresh').addEventListener('click', refresh);
async function initialize() {
  await refresh();
  try {
    const context = await api('context'); scopes = context.scopes || [];
    $('scope').replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择设备归属'; $('scope').append(placeholder);
    for (const [i, scope] of scopes.entries()) {
      const option = document.createElement('option'); option.value = String(i);
      option.textContent = scope.org_name + ' / ' + scope.district_name;
      $('scope').append(option);
    }
    if (!scopes.length) $('message').textContent = '未找到可用归属，请先在后台维护单位与区域。';
  } catch (error) { $('message').textContent = error.message; }
  controls();
}
initialize();
setInterval(() => { if (!document.hidden) refresh(); }, 2000);

let manualBusy = false, manualPolling = false, manualState = 'UNKNOWN';
function manualControls() {
  $('manual-start').disabled = manualBusy || !['STOPPED', 'FAILED'].includes(manualState);
  $('manual-stop').disabled = manualBusy || manualState !== 'RUNNING';
  for (const input of document.querySelectorAll('#manual-config input')) input.disabled = manualBusy || manualState === 'RUNNING';
}
function renderManual(value) {
  const previousState = manualState;
  manualState = value.state;
  $('manual-state').textContent = ({RUNNING:'监听中', STOPPED:'已停止', FAILED:'服务失败'})[value.state] || value.state;
  $('manual-connection').textContent = value.connected ? '已连接 · 数据登录成功' : value.state === 'RUNNING' ? '等待后台手动接入' : '未连接';
  $('manual-frames').textContent = value.frames_sent;
  $('manual-sent').textContent = value.last_sent_at ? new Date(value.last_sent_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) + '（北京时间）' : '—';
  if (value.state === 'RUNNING') {
    for (const key of ['longitude','latitude']) $('manual-config').elements[key].value = value[key];
  }
  if (value.error || value.state === 'RUNNING' || previousState !== value.state) $('manual-message').textContent = value.error || (value.state === 'RUNNING'
    ? value.connected ? '数据登录成功，正在发送模拟航迹；请到后台核对实际接收结果。' : 'TCP 服务已启动。现在到后台手动新增雷达，填写右侧参数。'
    : '独立 TCP 服务已停止；已登记的设备及其他模拟设备保持原样。');
  manualControls();
}
async function refreshManual() {
  if (manualBusy || manualPolling) return;
  manualPolling = true;
  try { renderManual(await api('manual/status')); }
  catch (error) { $('manual-message').textContent = '状态更新失败，当前显示为上次结果：' + error.message; }
  finally { manualPolling = false; }
}
$('manual-config').addEventListener('submit', async event => {
  event.preventDefault(); if (manualBusy || manualState === 'RUNNING') return;
  const data = new FormData(event.target);
  manualBusy = true; manualControls();
  try { renderManual(await api('manual/start', {longitude:Number(data.get('longitude')), latitude:Number(data.get('latitude'))})); }
  catch (error) { $('manual-message').textContent = error.message; }
  finally { manualBusy = false; manualControls(); }
});
$('manual-stop').addEventListener('click', async () => {
  manualBusy = true; manualControls();
  try { renderManual(await api('manual/stop', {})); }
  catch (error) { $('manual-message').textContent = error.message; }
  finally { manualBusy = false; manualControls(); }
});
for (const mode of ['manual','auto']) $('mode-' + mode).addEventListener('click', () => {
  for (const item of ['manual','auto']) {
    $('mode-' + item).setAttribute('aria-pressed', String(item === mode));
    $('mode-' + item).classList.toggle('secondary', item !== mode);
    $(item + '-panel').hidden = item !== mode;
  }
  if (mode === 'manual') refreshManual(); else refresh();
});
refreshManual();
setInterval(() => { if (!document.hidden) refreshManual(); }, 2000);
