<script setup>
/* 设备接入与调测 —— 转换页（源：legacy pages/commission.js）。
   legacy mount 本就「进入页面即重置为未开始」，故全部状态放组件内，
   不需要跨导航模块级状态。COM-03 参数登记（COMM_TEST）仍由 legacy script
   在模块加载期执行，这里不重复。定时器在 onUnmounted 清理。 */
import { ref, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '../shell/usePageChrome.js';
import UPanel from '../ui/UPanel.vue';

const M = window.MOCK, U = window.UI, CH = window.CH;
usePageChrome('commission');
const root = ref(null);

const STEPS = [
  ['设备接入', '选择设备并建立连接'], ['参数配置', '配置设备通信与参数'], ['通信测试', '链路连通性与稳定性'],
  ['接口测试', '接口协议与数据校验'], ['校准联调', '坐标校准与时间同步'], ['结果确认', '调测完成并生成报告']
];
let step = 0, running = false, timer = null, sec = 0, page = 1, size = 10, tab = 'lian';
let lastRun = null;
let phase = 'access';
let paramsSaved = false;
const PHASE_STEP = { access: 0, config: 1, ready: 2, testing: 2, done: 6 };
const STAGE_TITLE = { access: '设备接入', config: '参数配置', ready: '参数配置', testing: '调测执行', done: '结果确认' };
const TICK_MS = 80;
const elapsed = () => Math.floor(sec * TICK_MS / 1000);
const COMM_TH = (window.MOCK && window.MOCK.COMM_TH) || { latencyMs: 50, lossPct: 1, jitterMs: 20 };
const TH_TBC = '判据阈值待设备方确认';

/* 调测默认对象：优先在线雷达，其次任意雷达，都没有才为空（不得拿别的类型顶替） */
let dev = M.devices.find(d => d.type === '雷达' && d.status === '在线')
  || M.devices.find(d => d.type === '雷达')
  || null;
const hasDev = !!dev;

function linkMetrics(atStep) {
  const r = CH.seeded('link:' + dev.id + '@' + atStep);
  return { loss: +(r(0, 30) / 100).toFixed(2), latency: r(15, 42), jitter: r(2, 9), bw: +(r(1000, 1600) / 10).toFixed(1) };
}

function syncState() {
  const el = document.getElementById('cmState');
  if (!el) return;
  const m = running ? ['t-cyan', '测试中']
    : phase === 'done' ? ['t-green', '已完成']
      : phase === 'ready' ? ['t-amber', '待测试']
        : phase === 'config' ? ['t-blue', '已连接'] : ['t-gray', '未连接'];
  el.className = 'tag ' + m[0]; el.textContent = m[1];
}

const stepsHtml = `<div class="steps" id="cmSteps">${STEPS.map(([n, d], i) =>
  `<div class="st ${i < step ? 'done' : ''} ${i === step ? 'act' : ''}" data-step="${i}">
    <div class="c">${i < step ? U.icon('check') : i + 1}</div><div class="n">${n}</div><div class="t">${d}</div></div>`).join('')}</div>`;

const noDevHtml = `<div class="warnbox" style="line-height:1.9">
  <b>注意：设备清单中没有雷达设备，本页无调测对象。</b><br>
  此处<b>不会退而选用其他类型的设备顶替</b> —— 那会让链路指标、调测报告、配置项
  全部挂在一台并非被调测对象的设备上，而界面上看不出换了对象。<br>
  <span style="color:var(--txt-3)">请先在「设备管理」中登记雷达设备。</span></div>`;

/* 左栏 268 → 300px、区域/类型并排（用户 2026-08-30：「设备选择和设备信息太挤」） */
const devPickBody = hasDev ? `<div style="padding:8px;display:flex;flex-direction:column;gap:6px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      ${U.field('区域', U.select('r', ['全部区域', ...M.DISTRICTS.map(d => d.name)]))}
      ${U.field('类型', U.select('t', ['全部类型', ...new Set(M.devices.map(d => d.type))]))}
    </div>
    <input class="ip" placeholder="请输入设备名称/ID/IP" id="cmKw">
  </div>
  <div class="tree" id="cmTree" style="padding:0 8px 8px;overflow:auto;flex:1;min-height:0"></div>` : '';

const midBody = `<div id="cmCfg" style="padding:12px;overflow:auto;flex:1"></div>
  <div class="detail-actions" style="margin:0;border-width:1px 0 0;border-radius:0;flex-wrap:wrap;justify-content:flex-start">
    <button class="btn pri" id="cmConnect">${U.icon('link')} 建立连接</button>
    <button class="btn" id="cmSave" disabled title="请先「建立连接」">${U.icon('save')} 保存参数</button>
    <button class="btn pri" id="cmStart" disabled title="请先「保存参数」再开始测试">${U.icon('play')} 开始测试</button>
    <button class="btn" id="cmReconn" disabled title="请先「保存参数」再重新连接">${U.icon('refresh')} 重新连接</button>
    <button class="btn" id="cmReport" disabled title="需先完成 6 步调测流程（当前未开始）">${U.icon('file')} 生成调测报告</button>
  </div>`;

const liveExtra = `<span id="cmState" class="tag t-gray">未开始</span>
  <button class="btn danger" id="cmStop" disabled>停止测试</button>`;

const listTabsBody = `<div class="tabs" style="padding:8px 12px 0">
    <span class="tab ${tab === 'lian' ? 'on' : ''}" data-ct="lian">联调记录</span>
    <span class="tab ${tab === 'fault' ? 'on' : ''}" data-ct="fault">故障记录</span></div>
  <div id="cmList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

function tree() {
  const byRegion = {};
  M.devices.forEach(d => { (byRegion[d.region] = byRegion[d.region] || []).push(d); });
  return Object.keys(byRegion).map(r => `
    <div class="tn"><span>▾</span>${r}<span class="cnt">${byRegion[r].length}</span></div>
    <div class="ch">${byRegion[r].slice(0, 6).map(d =>
    `<div class="tn ${dev && d.id === dev.id ? 'on' : ''}" data-dev="${d.id}">
        <span class="dot-s" style="background:${d.status === '在线' ? '#2fd06e' : d.status === '离线' ? '#8ca0be' : '#ff4d5e'}"></span>${d.name}</div>`).join('')}
      ${byRegion[r].length > 6 ? `<div class="tn" style="color:var(--txt-3)">… 其余 ${byRegion[r].length - 6} 台</div>` : ''}</div>`).join('');
}

function info() {
  if (!dev) return `<div style="color:#ffd07a;font-size:12.5px;line-height:1.8">
    注意：设备清单中没有雷达设备，无法确定调测对象。<br>
    <span style="color:var(--txt-3)">此处不会退而选用其他类型的设备顶替 —— 那会让本页的链路指标与调测报告
    挂在一台并非被调测对象的设备上，而界面看不出换了对象。请在左侧设备树中手动选择。</span></div>`;
  return U.detailHero({
    icon: 'tool', variant: 'micro', subtitle: '接入调测设备', title: dev.name, id: dev.id,
    tags: [U.tag(dev.status), U.tag(dev.type, 't-cyan')], meta: [['区域', dev.region]]
  }) + U.metricStrip([
    { label: '连接状态', value: running ? '测试中' : dev.status, tone: dev.status === '在线' ? 'good' : 'warn', icon: 'link' },
    { label: '设备类型', value: dev.type, icon: 'device' },
    { label: '固件版本', value: dev.fw, icon: 'file' }
  ], { compact: true }) + U.kv([
    /* kv 只留 hero/指标条没有的字段（用户 2026-08-30：「设备信息太挤」）——
       设备名称/类型/状态/固件四项在上方已各出现一次，同一面板里第二遍是纯占位。
       所属区域保留：hero micro 变体不渲染 meta，删掉它就真没了。 */
    ['设备型号', dev.model],
    ['IP 地址', `<span class="mono">${dev.ip}</span>`],
    ['所属区域', dev.region],
    ['供应商', dev.vendor], ['设备编号', `<span class="mono">${dev.id}</span>`],
    ['接入时间', dev.installed + ' 14:32:18']], { surface: true, density: 'compact' });
}

function cfg() {
  const isTcp = dev.proto === 'TCP';
  return `
  ${U.sect('网络参数', `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px">
    ${U.field('IP地址', `<input class="ip" style="flex:1;min-width:0" value="${dev.ip}">`)}
    ${U.field('子网掩码', `<input class="ip" style="flex:1;min-width:0" value="255.255.255.0">`)}
    ${U.field('网关', `<input class="ip" style="flex:1;min-width:0" value="${dev.ip.split('.').slice(0, 3).join('.')}.1">`)}
    ${U.field('DNS', `<input class="ip" style="flex:1;min-width:0" value="10.10.0.53">`)}
    ${U.field('端口', `<input class="ip" style="flex:1;min-width:0" value="${dev.port}" id="cmPort">`)}
    ${U.field('心跳间隔(s)', `<input class="ip" style="flex:1;min-width:0" value="30">`)}
  </div>`)}
  ${U.sect('接口与协议 <span style="font-weight:400;color:var(--txt-3);font-size:11px">（协议类型与接入地址联动，避免 TCP 端口配 HTTP 路径）</span>',
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px">
    ${U.field('协议类型', U.select('proto', ['TCP', 'HTTP', 'WS'], dev.proto))}
    ${U.field('接入地址', `<input class="ip" style="flex:1;min-width:0" id="cmAddr" value="${isTcp ? 'tcp://' + dev.ip + ':' + dev.port
      : (dev.port === 8443 ? 'https://' : 'http://') + dev.ip + ':' + dev.port + '/api/v1/data'}">`)}
    ${U.field('数据格式', U.select('fmt', isTcp ? ['二进制(厂家私有)', 'JSON'] : ['JSON', 'XML']))}
    ${U.field('字符编码', U.select('enc', ['UTF-8', 'GBK']))}
    ${U.field('鉴权方式', U.select('auth', ['Token', 'AK/SK', '无']))}
    ${U.field('接口版本', U.select('ver', ['v1.0', 'v1.1', 'v2.0']))}
  </div>`)}
  ${U.sect('采样与传输', `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px">
    ${U.field('采样频率(Hz)', `<input class="ip" style="flex:1;min-width:0" value="10">`)}
    ${U.field('上报周期(ms)', `<input class="ip" style="flex:1;min-width:0" value="1000">`)}
    ${U.field('数据压缩', U.select('zip', ['启用', '停用']))}
    ${U.field('重传机制', U.select('retry', ['启用', '停用']))}
    ${U.field('超时(ms)', `<input class="ip" style="flex:1;min-width:0" value="3000">`)}
    ${U.field('重试次数', `<input class="ip" style="flex:1;min-width:0" value="3">`)}
  </div>`)}
  ${U.sect('坐标校准', `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end">
    ${U.field('坐标系', U.select('cs', ['WGS-84', 'CGCS2000', 'GCJ-02']))}
    ${U.field('经度偏移(°)', `<input class="ip" style="flex:1;min-width:0" value="0.000000">`)}
    ${U.field('纬度偏移(°)', `<input class="ip" style="flex:1;min-width:0" value="0.000000">`)}
    ${U.field('高度偏移(m)', `<input class="ip" style="flex:1;min-width:0" value="0.00">`)}
  </div><button class="btn" style="margin-top:8px" id="cmCal">打开校准工具</button>`)}
  ${U.sect('时钟同步', `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
    ${U.field('同步方式', U.select('sync', ['NTP', 'PTP', 'GPS 授时']))}
    ${U.field('NTP服务器', `<input class="ip" style="flex:1;min-width:0" value="ntp.dongying.gov.cn">`)}
    ${U.field('时区', U.select('tz', ['(UTC+08:00) 北京']))}
    ${U.field('同步间隔(s)', `<input class="ip" style="flex:1;min-width:0" value="60">`)}
  </div>`)}`;
}

function live() {
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      ${U.kv([['连接状态', phase !== 'access' ? '<span style="color:#79e5a5">● 已连接</span>' : '<span style="color:var(--txt-3)">○ 未连接</span>'],
    ['连接时长', running ? '00:' + M.util.p2(Math.floor(elapsed() / 60)) + ':' + M.util.p2(elapsed() % 60) : '—'],
    ['最后心跳', running ? M.util.fmtDT(new Date(M.CONF.demoTime.getTime() + elapsed() * 1000)) : '—']])}
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">
      ${(function () {
    const m = linkMetrics(step);
    return [['丢包率', running ? m.loss.toFixed(2) + '%' : '—', '#2fd06e'],
    ['延迟(ms)', running ? m.latency : '—', '#3d8bff'],
    ['抖动(ms)', running ? m.jitter : '—', '#a97bff'],
    ['带宽(KB/s)', running ? m.bw : '—', '#22d3ee']];
  })()
      .map(([n, v, c]) => `<div style="border:1px solid var(--line);border-radius:6px;padding:7px;text-align:center">
        <div style="font-size:11px;color:var(--txt-3)">${n}</div>
        <div style="font-size:16px;color:${c};font-family:Menlo" >${v}</div></div>`).join('')}
    </div>
    <div style="font-size:12px;color:#9ec6ff;margin-bottom:5px;display:flex;justify-content:space-between">
      <span>测试日志</span><span class="lnk" id="cmClr">清空日志</span></div>
    <div id="cmLog" class="logflow" style="height:132px;overflow:auto;background:rgba(3,9,26,.6);
      border:1px solid var(--line-2);border-radius:6px;padding:8px"></div>
    <div style="font-size:12px;color:#9ec6ff;margin:9px 0 5px;display:flex;justify-content:space-between">
      <span>接口响应结果</span><span class="lnk" id="cmRaw">查看原始数据</span></div>
    ${U.kv([['最近接口', `<span class="mono" style="font-size:11.5px">${dev.proto === 'TCP' ? 'tcp://' + dev.ip + ':' + dev.port : '/api/v1/data'}</span>`],
    ['响应状态', running ? '<span style="color:#79e5a5">200 OK</span>' : '—'],
    ['响应时间', running ? M.util.ri(18, 40) + ' ms' : '—'],
    ['数据条数', running ? 20 : '—'], ['响应大小', running ? '3.45 KB' : '—']])}
    <pre class="code" style="height:104px;margin-top:8px">${running ? JSON.stringify({
      code: 0, message: 'success', timestamp: '2026-08-26T10:24:36+08:00',
      data: [{ id: dev.id, lat: dev.lat, lon: dev.lon, alt: dev.alt, target: 'TRK201', conf: 0.94 }]
    }, null, 2) : '// 等待测试开始…'}</pre>`;
}

function listBody() {
  if (tab === 'lian') {
    const rows = M.commTasks.slice((page - 1) * size, page * size);
    return U.table([
      { t: '序号', k: 'no', w: '56px', align: 'center' },
      { t: '设备名称', k: 'name', w: '150px' },
      { t: '设备类型', k: 'type', w: '90px' },
      { t: '调测内容', k: 'content', w: '230px' },
      { t: '开始时间', k: 'start', w: '150px', cls: 'num' },
      { t: '结束时间', k: 'end', w: '150px', cls: 'num' },
      { t: '耗时', k: 'cost', w: '80px', cls: 'num' },
      { t: '调测结果', w: '90px', render: r => U.tag(r.result) },
      { t: '操作人', k: 'operator', w: '80px' },
      { t: '操作', w: '110px', render: r => `<span class="lnk" data-rep="${r.no}">查看报告</span><span class="lnk" data-rdl="${r.no}">下载</span>` }
    ], rows) + U.pager({ total: M.commTasks.length, page, size });
  }
  const faults = M.commTasks.filter(t => t.result === '失败');
  return U.table([
    { t: '序号', k: 'no', w: '56px', align: 'center' },
    { t: '设备名称', k: 'name', w: '150px' },
    { t: '故障时间', k: 'start', w: '150px', cls: 'num' },
    { t: '故障类型', w: '110px', render: r => ['接口超时', '协议不匹配', '鉴权失败', '时钟偏差超限', '坐标校准失败'][CH.seeded('ft' + r.no)(0, 4)] },
    { t: '故障描述', render: r => `${r.name} 在「${r.content}」阶段失败，需厂家协助定位` },
    { t: '处理状态', w: '90px', render: r => U.tag(CH.seeded('st' + r.no)(0, 9) > 2 ? '已处理' : '处理中') },
    { t: '责任方', w: '110px', render: r => ['算法/硬件团队', '平台团队', '双方'][CH.seeded('ow' + r.no)(0, 2)] }
  ], faults);
}

function syncReportBtn() {
  const b = document.getElementById('cmReport');
  if (!b) return;
  const ok = phase === 'done' && !!lastRun;
  b.disabled = !ok;
  b.title = ok ? '调测流程已完成，可生成报告'
    : `需先完成 6 步调测流程（当前进度 ${Math.min(step, 5)}/6${running ? ' · 测试进行中' : ''}）`;
}

function syncActionBtns() {
  const set = (id, dis, title) => { const b = document.getElementById(id); if (b) { b.disabled = dis; b.title = title; } };
  set('cmConnect', phase !== 'access' || running,
    phase === 'access' ? '与该设备建立连接，进入参数配置' : '连接已建立');
  set('cmSave', phase === 'access' || phase === 'done' || running,
    phase === 'access' ? '请先「建立连接」'
      : phase === 'done' ? '调测已完成；「重新连接」回到参数配置后方可修改参数'
        : running ? '测试进行中' : '保存参数后解锁开始测试/重新连接');
  set('cmStart', running || !paramsSaved || phase !== 'ready',
    running ? '测试进行中'
      : phase === 'done' ? '本次调测已完成；「重新连接」回到参数配置后可再测'
        : !paramsSaved || phase === 'config' ? '请先「保存参数」再开始测试'
          : phase === 'access' ? '请先「建立连接」并保存参数' : '按已保存参数开始调测');
  set('cmReconn', running || !paramsSaved || phase === 'access',
    running ? '测试进行中' : phase === 'access' ? '请先「建立连接」'
      : !paramsSaved ? '请先「保存参数」再重新连接' : '重新建立连接（完成态重连后可再次测试）');
}

function accessView() {
  const addr = dev.proto === 'TCP' ? 'tcp://' + dev.ip + ':' + dev.port : 'http://' + dev.ip + ':' + dev.port + '/api/v1/data';
  return `<div class="warnbox" style="margin-bottom:12px">当前处于<b>设备接入</b>阶段：确认左侧选中的设备与下方通信信息无误后，
      点击「建立连接」进入参数配置。</div>
    ${U.kv([['目标设备', dev.name + '（' + dev.id + '）'], ['通信方式', dev.proto],
    ['IP / 端口', `<span class="mono">${dev.ip}:${dev.port}</span>`],
    ['接入地址', `<span class="mono">${addr}</span>`],
    ['接入通道', dev.channel], ['设备状态', U.dotState(dev.status)]], { surface: true })}
    <div style="margin-top:10px;font-size:11.5px;color:var(--txt-3)">连接建立后才能配置与保存参数；参数保存后才能开始测试。</div>`;
}
function resultView() {
  if (!lastRun) return '<div class="empty">尚无本次调测结果</div>';
  const r = lastRun;
  return `<div class="warnbox" style="margin-bottom:12px">调测已完成：${r.result === '成功'
      ? '<b style="color:#79e5a5">全部指标达标</b>' : '<b style="color:#ff8b95">存在未达标项</b>'}
      · 可点击下方「生成调测报告」导出本次结果。</div>
    ${U.kv([['调测对象', r.dev.name + '（' + r.dev.id + '）'], ['调测内容', r.content],
    ['结论', r.result === '成功' ? '<span class="tag t-green">成功</span>' : '<span class="tag t-red">失败</span>'],
    ['起止时间', r.start + ' ~ ' + r.end], ['耗时', r.cost], ['操作人', r.operator]], { surface: true })}
    ${U.sect('指标明细', U.table([
    { t: '指标', k: 'k', w: '120px' },
    { t: '实测值', render: x => `<span class="mono">${x.v} ${x.unit}</span>` },
    { t: '阈值', render: x => `<span class="mono">≤ ${x.th} ${x.unit}</span>` },
    { t: '判定', w: '80px', render: x => x.ok ? '<span class="tag t-green">达标</span>' : '<span class="tag t-red">超标</span>' }
  ], r.items))}
    <div style="margin-top:8px;font-size:11.5px;color:var(--txt-3)">需重新调测：点「重新连接」后再「开始测试」，或在左侧换选设备。</div>`;
}
function stageBody() {
  if (phase === 'access') return accessView();
  if (phase === 'done') return resultView();
  /* 三个阶段各配一条黄字引导（用户 2026-08-30：让看 Demo 的人知道下一步点哪里） */
  const stageHint = running
    ? `测试进行中：右侧「实时调测结果」滚动显示各步日志与链路指标，跑完后点<b>「生成调测报告」</b>。`
    : phase === 'ready'
      ? `参数已保存：点下方<b>「开始测试」</b>，自动依次执行通信测试 → 接口测试 → 校准联调（约 20 秒）。`
      : `连接已建立：核对或调整下方参数后，点下方<b>「保存参数」</b>进入待测试状态。`;
  return `<div class="warnbox" style="margin-bottom:12px">${stageHint}</div>
    <fieldset ${running ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0">${cfg()}</fieldset>`;
}

function paint() {
  if (!hasDev) return;
  syncReportBtn();
  syncActionBtns();
  document.getElementById('cmTree').innerHTML = tree();
  document.getElementById('cmInfo').innerHTML = info();
  document.getElementById('cmCfg').innerHTML = stageBody();
  const tt = document.getElementById('cmStageTitle'); if (tt) tt.textContent = STAGE_TITLE[phase];
  syncState();
  document.getElementById('cmLive').innerHTML = live();
  document.getElementById('cmList').innerHTML = listBody();
  document.querySelectorAll('#cmSteps .st').forEach((el, i) => {
    el.classList.toggle('done', i < step); el.classList.toggle('act', i === step);
    el.querySelector('.c').innerHTML = i < step ? U.icon('check') : i + 1;
  });
  const cal = document.getElementById('cmCal');
  if (cal) cal.onclick = () => U.toast('坐标校准工具：请在地图上选取 3 个已知控制点（Demo）');
  const clr = document.getElementById('cmClr');
  if (clr) clr.onclick = () => document.getElementById('cmLog').innerHTML = '';
  const raw = document.getElementById('cmRaw');
  if (raw) raw.onclick = () => U.modal({
    title: '接口原始报文', width: '680px',
    body: `<pre class="code" style="max-height:420px">${JSON.stringify({
      header: { device: dev.id, proto: dev.proto, ts: '2026-08-26T10:24:36.128+08:00', seq: 10245 },
      body: { targets: [{ trackId: 'TRK201', plots: 26, lat: dev.lat, lon: dev.lon, alt: 98.3, speed: 32.6, heading: 270, quality: 0.94 }] },
      checksum: 'CRC16-0x8F2A'
    }, null, 2)}</pre>`
  });
}

const SCRIPT = [
  ['开始通信测试…', 2],
  ['通信测试通过，延迟 {lat}ms，丢包率 {loss}%', 3],
  ['开始接口测试 {addr} …', 3],
  ['接口测试通过，状态码 200，字段校验 32/32 通过', 4],
  ['开始坐标校准（WGS-84）…', 4],
  ['坐标校准完成，经纬度偏移已更新（Δlon 0.000012°, Δlat 0.000008°）', 4],
  ['开始时钟同步（NTP ntp.dongying.gov.cn）…', 4],
  ['时钟同步成功，偏差 {ntp}ms', 5],
  ['调测完成，已生成报告 RPT-{id}', 5]
];

function start() {
  if (running) return;
  if (phase !== 'ready' || !paramsSaved) return U.toast('请按流程操作：建立连接 → 保存参数 → 开始测试', 'err');
  running = true; phase = 'testing'; sec = 0; step = 2;
  document.getElementById('cmStop').disabled = false;
  paint();
  let i = 0;
  timer = setInterval(() => {
    const log = document.getElementById('cmLog');
    if (!log) { stop(); return; }
    sec += 1;
    if (i < SCRIPT.length && sec % 2 === 0) {
      const [txt, s] = SCRIPT[i++];
      const lm = linkMetrics(s);
      const line = txt.replace('{ip}', dev.ip).replace('{port}', dev.port)
        .replace('{addr}', dev.proto === 'TCP' ? 'tcp://' + dev.ip + ':' + dev.port : '/api/v1/data')
        .replace('{id}', dev.id)
        .replace('{lat}', lm.latency).replace('{loss}', lm.loss.toFixed(2))
        .replace('{ntp}', CH.seeded('ntp:' + dev.id)(1, 9));
      log.insertAdjacentHTML('beforeend',
        `<div class="l"><span class="tm">${M.util.fmtDT(new Date(M.CONF.demoTime.getTime() + elapsed() * 1000))}</span><span>${line}</span></div>`);
      log.scrollTop = log.scrollHeight;
      if (s !== step) { step = s; paint(); document.getElementById('cmLog').innerHTML = log.innerHTML; }
      if (i === SCRIPT.length) {
        const m5 = linkMetrics(5);
        const t0 = M.CONF.demoTime;
        const items5 = [
          { k: '时延', v: m5.latency, unit: 'ms', th: COMM_TH.latencyMs, ok: m5.latency <= COMM_TH.latencyMs },
          { k: '丢包率', v: m5.loss, unit: '%', th: COMM_TH.lossPct, ok: m5.loss <= COMM_TH.lossPct },
          { k: '抖动', v: m5.jitter, unit: 'ms', th: COMM_TH.jitterMs, ok: m5.jitter <= COMM_TH.jitterMs }
        ];
        lastRun = {
          live: true, no: 'LIVE', dev,
          content: '通信测试 + 接口测试 + 校准联调 + 时钟同步',
          items: items5, result: items5.every(x => x.ok) ? '成功' : '失败',
          start: M.util.fmtDT(t0), end: M.util.fmtDT(new Date(t0.getTime() + elapsed() * 1000)),
          cost: '00:' + M.util.p2(Math.floor(elapsed() / 60)) + ':' + M.util.p2(elapsed() % 60),
          operator: ((M.users && M.users[0]) || { name: '管理员' }).name
        };
        U.toast(`${U.icon('check')} 设备调测完成，可生成调测报告`, 'ok');
        running = false; phase = 'done'; step = 6;
        clearInterval(timer);
        const logHtml2 = log.innerHTML;
        paint();
        const lg2 = document.getElementById('cmLog'); if (lg2) lg2.innerHTML = logHtml2;
      }
    }
    const l = document.getElementById('cmLive');
    if (l && sec % 2 === 1) {
      const logHtml = document.getElementById('cmLog').innerHTML;
      l.innerHTML = live();
      document.getElementById('cmLog').innerHTML = logHtml;
      document.getElementById('cmLog').scrollTop = 9999;
      bindLive();
    }
  }, TICK_MS);
}

function bindLive() {
  const clr = document.getElementById('cmClr');
  if (clr) clr.onclick = () => document.getElementById('cmLog').innerHTML = '';
}
function stop() {
  const was = running;
  running = false; clearInterval(timer);
  if (phase === 'testing') { phase = paramsSaved ? 'ready' : 'config'; step = PHASE_STEP[phase]; }
  const b = document.getElementById('cmStop'); if (b) b.disabled = true;
  if (was) { U.toast('已停止调测，链路保持连接；可「开始测试」重新跑', 'err'); paint(); }
}

function reportOf(t) {
  const d = t.dev;
  const names = String(t.content || '').split('+').map(x => x.trim()).filter(Boolean);
  const rs = CH.seeded('rpt|' + d.id + '|' + t.no);
  const judge = {};
  names.forEach(n => {
    if (n === '通信测试') {
      const items = t.items || [];
      if (!items.length) { judge[n] = { ok: false, why: '该次调测未记录链路实测值' }; return; }
      const bad = items.filter(x => !x.ok);
      judge[n] = {
        ok: !bad.length,
        val: items.map(x => `${x.k} ${x.v}${x.unit}`).join(' / '),
        why: bad.map(x => `${x.k} ${x.v}${x.unit} > ${x.th}${x.unit}`).join('；')
      };
    } else if (n === '接口测试') {
      const code = rs(0, 99) < 92 ? 200 : rs(500, 504);
      judge[n] = { ok: code === 200, why: code === 200 ? '' : `HTTP ${code}`, val: `HTTP ${code}，字段校验 32/32` };
    } else if (n === '校准联调') {
      const res = +(rs(2, 9) / 10).toFixed(1);
      judge[n] = { ok: res <= 1, why: res > 1 ? `残差 ${res} m > 1 m` : '', val: `WGS-84 残差 ${res} m` };
    } else {
      const ntp = rs(1, 9);
      judge[n] = { ok: ntp <= 10, why: ntp > 10 ? `NTP 偏差 ${ntp} ms > 10 ms` : '', val: `NTP 偏差 ${ntp} ms` };
    }
  });
  const derivedFail = names.some(n => !judge[n].ok);
  const recordedFail = t.result === '失败';
  return { d, names, judge, derivedFail, recordedFail, mismatch: derivedFail !== recordedFail };
}

function reportModal(t) {
  const R = reportOf(t);
  const okTag = '<span style="color:#79e5a5">通过</span>';
  const noTag = '<span style="color:#ff8b95">不通过</span>';
  U.modal({
    title: '调测报告 · ' + R.d.name + '（' + (t.live ? '本次调测' : '第 ' + t.no + ' 条记录') + '）', width: '680px',
    body: `<div class="warnbox">本报告的单项结论<b>由该次调测自己记录的实测值与通过阈值推导</b>，
        不是固定文案，也不是从记录的「成功/失败」反推。
        <b>实测值取自本次调测记录，不是设备此刻的运行指标</b> —— 后者是今天的负载表现，
        与几天前那次测量不是同一个量。
        阈值 延迟 ≤${COMM_TH.latencyMs} ms／丢包 ≤${COMM_TH.lossPct}%／抖动 ≤${COMM_TH.jitterMs} ms，
        <b>待设备方确认</b>，见「参数总览 → 设备调测判据」。</div>
      ${U.kv([
      ['报告编号', `<span class="mono">RPT-${R.d.id}-${t.live ? 'LIVE' : M.util.p3(t.no)}</span>`],
      ['设备', `${R.d.name}　<span class="mono">${R.d.id}</span>`],
      ['型号 / 厂家', `${R.d.model} / ${R.d.vendor}`],
      ['设备当前状态', U.tag(R.d.status) + (R.d.alarm ? ' ' + U.tag('告警中', 't-amber') : '')],
      ['调测项', t.content],
      ['开始 / 结束', `${t.start} ~ ${t.end}`],
      ['耗时', t.cost], ['操作人', t.operator]
    ])}
      ${U.sect('分项结果（按阈值判定）', U.kv(R.names.map(n => {
        const j = R.judge[n];
        return [n, `${j.ok ? okTag : noTag}：${j.val || j.why}
          ${j.ok ? '' : `<div style="font-size:11px;color:#ff8b95;line-height:1.7">超限项：${j.why}</div>`}
          <span style="color:var(--txt-3);font-size:11px">（${TH_TBC}）</span>`];
      })))}
      ${R.derivedFail
        ? `<div class="warnbox" style="border-color:rgba(255,77,94,.45)">
            <b>结论：不通过。</b>${R.names.filter(n => !R.judge[n].ok).join('、')} 未达到当前阈值，
            <b>该设备不得投入运行</b>，须整改后复测并重新出具报告。</div>`
        : `<div style="border:1px solid rgba(47,208,110,.4);background:rgba(47,208,110,.10);border-radius:6px;padding:9px 11px;font-size:12.5px">
            <b style="color:#79e5a5">结论：通过。</b>各分项实测值均在当前阈值内，设备可投入运行。</div>`}
      ${R.mismatch && !t.live
        ? `<div class="warnbox" style="border-color:rgba(255,176,32,.55);margin-top:10px;line-height:1.85">
            <b>注意：本条记录的判定结果与按调测项推导的结论不一致。</b><br>
            记录写的是「<b>${t.result}</b>」，按本报告所列调测项推导应为「<b>${R.derivedFail ? '失败' : '成功'}</b>」。<br>
            ${!/通信测试/.test(t.content) && (t.failedItems || []).length
              ? `具体成因：本次<b>调测项为「${t.content}」，不含通信测试</b>，
                 但记录的不合格项是 <b>${(t.failedItems || []).join('、')}</b> —— 那是链路指标，
                 属于通信测试。<b>一次没做通信测试的调测，不应因链路指标不合格而判失败。</b>`
              : '两者依据的判定项不一致。'}<br>
            <b>本页不替任何一边圆场</b> —— 报告只呈现"本次调测项 + 实测值 + 由此得出的结论"，
            并把这处矛盾显式标出。已登记给数据层。</div>`
        : ''}
      ${U.kv([['签署', '平台团队：' + t.operator + ' ／ 设备方：待签署']])}`,
    footer: `<button class="btn" data-close>关闭</button>
      <button class="btn" data-act="dl">${U.icon('download')} 下载 PDF</button>`,
    on: { dl: () => U.toast('正式环境将导出《设备调测报告》PDF 并归档进证据台账；Demo 不生成文件', 'err') }
  });
}

onUnmounted(() => { clearInterval(timer); running = false; });

onMounted(() => {
  if (!hasDev) return;
  const view = root.value;
  paint();
  U.on(view, '[data-dev]', 'click', (e, el) => {
    dev = M.devices.find(d => d.id === el.dataset.dev);
    step = 0; running = false; clearInterval(timer);
    phase = 'access'; paramsSaved = false; lastRun = null;
    const tr = document.getElementById('cmTree');
    const keep = tr ? tr.scrollTop : 0;
    paint();
    const tr2 = document.getElementById('cmTree');
    if (tr2) tr2.scrollTop = keep;
  });
  U.on(view, '[data-step]', 'click', () => U.toast(
    running ? '调测进行中，进度由测试自动推进' : '进度由「开始测试」推进，不能手动跳步', 'err'));
  U.on(view, '[data-ct]', 'click', (e, el) => {
    tab = el.dataset.ct; page = 1;
    view.querySelectorAll('[data-ct]').forEach(x => x.classList.toggle('on', x === el));
    document.getElementById('cmList').innerHTML = listBody();
  });
  U.on(view, '[data-pg]', 'click', (e, el) => { if (el.dataset.pg) { page = +el.dataset.pg; document.getElementById('cmList').innerHTML = listBody(); } });
  U.on(view, '[data-size]', 'change', (e, el) => { size = parseInt(el.value); page = 1; document.getElementById('cmList').innerHTML = listBody(); });
  U.on(view, '[data-f="proto"]', 'change', (e, el) => {
    const a = document.getElementById('cmAddr'), p = document.getElementById('cmPort');
    if (el.value === 'TCP') { a.value = 'tcp://' + dev.ip + ':9001'; p.value = 9001; }
    else if (el.value === 'WS') { a.value = 'ws://' + dev.ip + ':8080/push'; p.value = 8080; }
    else { a.value = 'http://' + dev.ip + ':8080/api/v1/data'; p.value = 8080; }
    U.toast('协议已切换为 ' + el.value + '，接入地址与端口已联动更新');
  });
  U.on(view, '[data-rep]', 'click', (e, el) => {
    const t = M.commTasks.find(x => x.no === +el.dataset.rep);
    if (t) reportModal(t);
  });
  U.on(view, '[data-rdl]', 'click', (e, el) => {
    const t = M.commTasks.find(x => x.no === +el.dataset.rdl);
    U.toast(`正式环境将导出第 ${el.dataset.rdl} 条《设备调测报告》PDF${t ? `（${t.dev.name} · ${t.result}）` : ''}；Demo 不生成文件`, 'err');
  });
  document.getElementById('cmStart').onclick = start;
  document.getElementById('cmStop').onclick = stop;
  document.getElementById('cmConnect').onclick = () => {
    if (phase !== 'access') return;
    phase = 'config'; step = 1;
    paint();
    const lg = document.getElementById('cmLog');
    if (lg) lg.innerHTML += `<div class="l"><span class="tm">${M.util.fmtDT(M.CONF.demoTime)}</span><span>开始连接设备 ${dev.ip}:${dev.port} …</span></div>
      <div class="l"><span class="tm">${M.util.fmtDT(M.CONF.demoTime)}</span><span>连接成功，${dev.proto === 'TCP' ? 'TCP 三次握手完成' : 'HTTP 通道就绪'}</span></div>`;
    U.toast('连接已建立，请配置并「保存参数」', 'ok');
  };
  document.getElementById('cmSave').onclick = () => {
    if (phase === 'access' || phase === 'done' || running) return;
    paramsSaved = true;
    if (phase === 'config') { phase = 'ready'; step = 2; }
    paint();
    U.toast('参数已保存至设备档案，可「开始测试」', 'ok');
  };
  document.getElementById('cmReconn').onclick = () => {
    if (running || !paramsSaved || phase === 'access') return;
    lastRun = null; phase = 'config'; paramsSaved = false; step = 1;
    paint();
    const lg = document.getElementById('cmLog');
    if (lg) lg.innerHTML += `<div class="l"><span class="tm">${M.util.fmtDT(M.CONF.demoTime)}</span><span>重新建立连接成功（${dev.ip}:${dev.port}），请重新确认并保存参数</span></div>`;
    U.toast('已重新连接，请重新「保存参数」后再开始测试', 'ok');
  };
  syncReportBtn();
  document.getElementById('cmReport').onclick = () => {
    if (step < 5 || !lastRun) return U.toast('请先完成调测流程再生成报告', 'err');
    return reportModal(lastRun);
  };
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <template v-if="hasDev">
      <UPanel :title="false" panel-style="flex:none;margin-bottom:12px" :body-html="stepsHtml" />

      <div class="row mb12" style="height:560px;flex:none">
        <div class="col" style="width:300px">
          <UPanel title="设备选择" panel-style="flex:none;height:260px" nopad :body-html="devPickBody" />
          <UPanel title="设备信息" panel-style="flex:1;min-height:0" nopad
            body-html='<div id="cmInfo" style="flex:1;overflow:auto;padding:12px"></div>' />
        </div>

        <UPanel title='<span id="cmStageTitle">设备接入</span>' panel-style="flex:1.5" nopad :body-html="midBody" />

        <div class="col" style="width:420px">
          <UPanel title="实时调测结果" panel-style="flex:1;min-height:0" nopad :extra="liveExtra"
            body-html='<div id="cmLive" style="padding:10px;overflow:auto;flex:1"></div>' />
        </div>
      </div>

      <UPanel :title="false" panel-style="height:300px;flex:none;margin-bottom:12px" nopad :body-html="listTabsBody" />
    </template>
    <UPanel v-else title="设备接入调测" panel-style="flex:none" :body-html="noDevHtml" />
  </div>
</template>
