<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NCard, NConfigProvider, NDataTable, NIcon, NModal } from 'naive-ui';
import {
  BriefcaseOutline,
  DocumentAttachOutline,
  NotificationsOutline,
  RadioOutline
} from '@vicons/ionicons5';
import PageQueryShell from '@/components/PageQueryShell.vue';
import { theme, themeOverrides } from '@/ui/theme.js';

const clock = ref('—');
const viewportHeight = ref(window.innerHeight);
const queryStatus = ref('idle');
const queryError = ref('');
const screenData = ref(null);
const showVideo = ref(false);
const selectedTarget = ref(null);
const trendEl = ref(null);
const targetChartEl = ref(null);
const deviceChartEl = ref(null);
const flightChartEl = ref(null);
const mapEl = ref(null);
const videoEl = ref(null);

let clockTimer = null;
let resizeTimer = null;
let map = null;
let video = null;
let mapHint = null;
let runtimeChart = null;
let mounted = false;
let runtimeStarted = false;

/* 整屏空态只在所有可见业务集合均为空时成立；任一集合有数据仍展示 ready。 */
const VISIBLE_COLLECTION_KEYS = [
  'liveTargets', 'todayTargets', 'cases', 'evidenceFiles', 'todayAlarms',
  'devices', 'flightPlans', 'statsDays', 'airspaces'
];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(name, value) {
  if (!isRecord(value)) throw new TypeError(`大屏本地数据无效：${name} 必须是对象`);
  return value;
}

function requireObjectArray(name, value) {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new TypeError(`大屏本地数据无效：${name} 必须是对象数组`);
  }
  return value;
}

function requireFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`大屏本地数据无效：${name} 必须是函数`);
  return value;
}

function validateBigScreenData() {
  const mock = requireRecord('MOCK', window.MOCK);
  const ui = requireRecord('UI', window.UI);
  const stats = requireRecord('MOCK.stats', mock.stats);
  const deviceStats = requireRecord('MOCK.deviceStats', mock.deviceStats);
  for (const key of ['onlineRate', 'offline', 'abnormal', 'alarm']) {
    if (!Number.isFinite(deviceStats[key])) {
      throw new TypeError(`大屏本地数据无效：MOCK.deviceStats.${key} 必须是有限数值`);
    }
  }
  const chart = requireRecord('CH', window.CH);
  requireRecord('CH.C', chart.C);
  for (const key of ['line', 'donut', 'ring', 'bar', 'disposeEl']) requireFunction(`CH.${key}`, chart[key]);
  requireFunction('MapView', window.MapView);
  requireFunction('EOVideo', window.EOVideo);
  requireFunction('UI.goto', ui.goto);
  const systemNowStr = requireFunction('MOCK.systemNowStr', mock.systemNowStr).bind(mock);
  const initialClock = systemNowStr();
  if (typeof initialClock !== 'string') throw new TypeError('大屏本地数据无效：MOCK.systemNowStr 必须返回字符串');
  return {
    liveTargets: requireObjectArray('MOCK.liveTargets', mock.liveTargets),
    todayTargets: requireObjectArray('MOCK.todayTargets', mock.todayTargets),
    cases: requireObjectArray('MOCK.cases', mock.cases),
    evidenceFiles: requireObjectArray('MOCK.evidenceFiles', mock.evidenceFiles),
    todayAlarms: requireObjectArray('MOCK.todayAlarms', mock.todayAlarms),
    devices: requireObjectArray('MOCK.devices', mock.devices),
    flightPlans: requireObjectArray('MOCK.flightPlans', mock.flightPlans),
    statsDays: requireObjectArray('MOCK.stats.days', stats.days),
    airspaces: requireObjectArray('MOCK.airspaces', mock.airspaces),
    deviceStats,
    caseNoticeStatus: requireFunction('MOCK.caseNoticeStatus', mock.caseNoticeStatus).bind(mock),
    goto: ui.goto.bind(ui), chart, MapView: window.MapView, EOVideo: window.EOVideo,
    systemNowStr, initialClock
  };
}

function hasVisibleBusinessData(data) {
  return VISIBLE_COLLECTION_KEYS.some(key => data[key].length > 0);
}

const riskScore = { 高风险: 3, 中风险: 2, 低风险: 1 };
const alarmColor = { 高: 'var(--red)', 中: 'var(--amber)', 低: 'var(--cyan)' };
const alarmLevelScore = { 高: 3, 中: 2, 低: 1 };
const alarmFlowScore = { 待核实: 0, 反制中: 1, 干扰中: 2, 待处置: 3, 新建: 4, 处置中: 5, 已关闭: 6, 误报: 7 };
const legacyFlowStatus = { 新建: '待核实', 已确认: '待核实', 处置中: '反制中', 已关闭: '待处置', 误报: '误报' };

const noticeTick = ref(0);
const rowLimit = computed(() => viewportHeight.value < 760 ? 2 : viewportHeight.value < 850 ? 3 : 4);
const alarmFlowStatus = alarm => alarm.flowStatus || legacyFlowStatus[alarm.status] || alarm.status || '待核实';
const noticeStatus = item => {
  noticeTick.value;
  return screenData.value ? screenData.value.caseNoticeStatus(item) : '待通知';
};
const isEvidenceException = item => item.verifyState !== '完好';
const isPlanDeviated = plan => {
  const d = plan.deviation;
  if (!d) return false;
  return (d.lateral != null && Math.abs(d.lateral) > 500)
    || (d.timeMin != null && Math.abs(d.timeMin) > 20)
    || (d.altDelta != null && Math.abs(d.altDelta) > 20);
};

const targetAll = computed(() => {
  const data = screenData.value;
  if (!data) return [];
  return data.liveTargets.filter(t => t.type === '无人机').slice().sort((a, b) =>
    (riskScore[b.risk] || 0) - (riskScore[a.risk] || 0)
    || Number(b.legal === '待确认') - Number(a.legal === '待确认')
    || Number(!!b.tracked) - Number(!!a.tracked)
    || b.ts - a.ts
  );
});
const judgementPending = computed(() => screenData.value ? screenData.value.todayTargets.filter(t =>
  t.type === '无人机' && (t.legal === '非法' || t.legal === '待确认')).length : 0);
const pendingCases = computed(() => screenData.value
  ? screenData.value.cases.filter(c => c.status !== '已结案' || noticeStatus(c) === '待通知') : []);
const evidenceExceptions = computed(() => screenData.value
  ? screenData.value.evidenceFiles.filter(isEvidenceException) : []);

const alarmAll = computed(() => screenData.value ? screenData.value.todayAlarms.slice()
  .map(a => ({ ...a, _flowStatus: alarmFlowStatus(a) })).sort((a, b) =>
    (alarmFlowScore[a._flowStatus] ?? 99) - (alarmFlowScore[b._flowStatus] ?? 99)
    || (alarmLevelScore[b.level] || 0) - (alarmLevelScore[a.level] || 0)
    || b.ts - a.ts
  ) : []);
const alarms = computed(() => alarmAll.value.slice(0, rowLimit.value));

const deviceExceptions = computed(() => screenData.value ? screenData.value.devices
  .filter(d => d.status !== '在线' || d.alarm).slice().sort((a, b) =>
    Number(!!b.alarm) - Number(!!a.alarm)
    || ({ 异常: 3, 离线: 2, 在线: 1 }[b.status] || 0) - ({ 异常: 3, 离线: 2, 在线: 1 }[a.status] || 0)
    || (b.hbMin || 0) - (a.hbMin || 0)
  ) : []);
const flightPlans = computed(() => screenData.value ? screenData.value.flightPlans : []);
const flightMetrics = computed(() => [
  { label: '今日计划', value: flightPlans.value.length, page: 'flights' },
  { label: '执行中', value: flightPlans.value.filter(p => p.status === '执行中').length, page: 'flights' },
  { label: '未匹配', value: flightPlans.value.filter(p => p.matched === '未匹配感知目标').length, page: 'flights' },
  { label: '偏离计划', value: flightPlans.value.filter(isPlanDeviated).length, page: 'flights', tone: 'bad' }
]);

const closureItems = computed(() => [
  { label: '待核实告警', value: alarmAll.value.filter(a => a._flowStatus === '待核实').length, page: 'alarms', tone: 'warn', icon: NotificationsOutline },
  { label: '反制 / 干扰中', value: alarmAll.value.filter(a => ['反制中', '干扰中'].includes(a._flowStatus)).length, page: 'alarms', tone: 'bad', icon: RadioOutline },
  { label: '待通知案件', value: screenData.value ? screenData.value.cases.filter(c => noticeStatus(c) === '待通知').length : 0, page: 'punish', tone: 'warn', icon: BriefcaseOutline },
  { label: '证据异常', value: evidenceExceptions.value.length, page: 'evidence', tone: evidenceExceptions.value.length ? 'bad' : 'good', icon: DocumentAttachOutline }
]);

/* EVT.counts().found 的原有口径：今日目标中排除遥控器。 */
const kpis = computed(() => [
  { label: '今日感知目标', value: screenData.value ? screenData.value.todayTargets.filter(t => t.type !== '遥控器').length : 0, color: '#ffd53d', page: 'situation' },
  { label: '今日告警', value: alarmAll.value.length, color: 'var(--cyan)', page: 'alarms' },
  { label: '待研判目标', value: judgementPending.value, color: 'var(--amber)', page: 'legality' },
  { label: '待处置案件', value: pendingCases.value.length, color: 'var(--red)', page: 'punish' }
]);

const targetSummary = computed(() => `实时 ${targetAll.value.length} 架 · 高风险 ${targetAll.value.filter(t => t.risk === '高风险').length}`);
const deviceSummary = computed(() => `在线率 ${screenData.value ? screenData.value.deviceStats.onlineRate : 0}% · 关注 ${deviceExceptions.value.length}`);
const alarmSummary = computed(() => `今日 ${alarmAll.value.length} 条 · 待核实 ${alarmAll.value.filter(a => a._flowStatus === '待核实').length}`);
const opticalDevice = computed(() => screenData.value
  ? screenData.value.devices.find(d => d.type === '光电' && d.status === '在线') : null);

const mono = text => h('span', { class: 'mono' }, text);
const colored = (text, color) => h('span', { style: { color } }, text);

function go(page, context) {
  showVideo.value = false;
  if (screenData.value) screenData.value.goto(page, context);
}

function goAlarm(row) {
  sessionStorage.setItem('alarm.sel', row.id);
  go('alarms');
}

function rowProps(action, label) {
  return row => ({
    class: ['bs-clickable-row', row.level ? `is-${row.level}` : ''],
    role: 'link',
    tabindex: 0,
    'aria-label': label(row),
    onClick: () => action(row),
    onKeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        action(row);
      }
    }
  });
}

const alarmRowProps = rowProps(goAlarm, row => `查看告警 ${row.id} 详情`);

const alarmColumns = [
  { title: '时间', key: 'time', render: row => mono((row.time || '').slice(11, 19)) },
  { title: '告警类型', key: 'type' },
  { title: '等级', key: 'level', render: row => colored(`● ${row.level}`, alarmColor[row.level] || 'var(--txt-2)') },
  { title: '状态', key: '_flowStatus' }
];

function renderCharts() {
  const data = screenData.value;
  if (!data) return;
  const days = data.statsDays.slice(-7);
  const gradedTargets = ['高风险', '中风险', '低风险'].reduce((sum, level) =>
    sum + targetAll.value.filter(t => t.risk === level).length, 0);
  data.chart.line(trendEl.value, {
    x: days.map(x => x.md),
    series: [
      { name: '发现目标', data: days.map(x => x.total), color: data.chart.C.blue, area: true },
      { name: '非法目标', data: days.map(x => x.illegal), color: data.chart.C.red }
    ]
  });
  data.chart.donut(targetChartEl.value, {
    data: [
      { name: '高风险', value: targetAll.value.filter(t => t.risk === '高风险').length, c: data.chart.C.red },
      { name: '中风险', value: targetAll.value.filter(t => t.risk === '中风险').length, c: data.chart.C.amber },
      { name: '低风险', value: targetAll.value.filter(t => t.risk === '低风险').length, c: data.chart.C.green },
      { name: '未定级', value: Math.max(0, targetAll.value.length - gradedTargets), c: data.chart.C.gray }
    ],
    centerLabel: '重点目标', centerValue: targetAll.value.length, showPct: false,
    narrow: false, center: ['31%', '50%'], radius: ['45%', '66%']
  });
  data.chart.ring(deviceChartEl.value, {
    value: data.deviceStats.onlineRate, label: '设备在线率', color: data.chart.C.cyan, fs: 24
  });
  data.chart.bar(flightChartEl.value, {
    x: flightMetrics.value.map(item => item.label), legend: false,
    grid: { left: 30, right: 8, top: 20, bottom: 24 },
    series: [{
      name: '数量', data: flightMetrics.value.map(item => item.value), width: 24,
      colorBy: p => p.dataIndex === 3 ? data.chart.C.red : [data.chart.C.blue, data.chart.C.green, data.chart.C.amber][p.dataIndex]
    }]
  });
}

function openVideo(target) {
  if (!target || target.type !== '无人机') return;
  selectedTarget.value = target;
  showVideo.value = true;
}

function renderMap() {
  const data = screenData.value;
  if (!data || !mapEl.value) return;
  map = new data.MapView(mapEl.value, {
    zoom: 1.06,
    maxDev: 46,
    maxAlarm: 8,
    onPick: pick => {
      if (!map || !pick || pick.kind !== 'target' || !pick.data || pick.data.type !== '无人机') return;
      map.sel = pick.data.id;
      map.draw();
      openVideo(pick.data);
    }
  });
  mapHint = document.createElement('div');
  mapHint.className = 'bs-map-hint';
  mapHint.textContent = '点击地图上的无人机查看实时视频';
  mapEl.value.appendChild(mapHint);
  refreshMapData();
}

function refreshMapData() {
  const data = screenData.value;
  if (!data || !map) return;
  map.setData({
    airspaces: data.airspaces,
    devices: data.devices.filter((d, i) => i % 4 === 0),
    targets: data.liveTargets,
    alarms: data.todayAlarms.slice(0, 8)
  });
}

function runCleanup(cleanup) {
  try { cleanup(); } catch (err) { /* 单个资源失败不得阻断其余回滚。 */ }
}

function destroyVideo() {
  const currentVideo = video;
  video = null;
  if (currentVideo) runCleanup(() => currentVideo.destroy());
}

async function mountVideo() {
  try {
    destroyVideo();
    const data = screenData.value;
    if (queryStatus.value !== 'ready' || !data || !showVideo.value || !selectedTarget.value) return;
    await nextTick();
    if (queryStatus.value !== 'ready' || !videoEl.value || !selectedTarget.value) return;
    video = new data.EOVideo(videoEl.value, {
      height: Math.max(300, Math.min(430, window.innerHeight * .46)),
      targetId: selectedTarget.value.id,
      device: opticalDevice.value ? opticalDevice.value.name : undefined,
      locked: !!selectedTarget.value.tracked
    });
  } catch (err) {
    failReadyRuntime(err);
  }
}

watch([showVideo, selectedTarget], ([visible]) => {
  if (queryStatus.value === 'ready' && visible) void mountVideo();
  else destroyVideo();
}, { flush: 'post' });

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    viewportHeight.value = window.innerHeight;
  }, 120);
}

function disposeBigScreenCharts() {
  const chart = runtimeChart;
  runtimeChart = null;
  if (!chart || typeof chart.disposeEl !== 'function') return;
  [trendEl, targetChartEl, deviceChartEl, flightChartEl]
    .forEach(host => runCleanup(() => chart.disposeEl(host.value)));
}

function stopReadyRuntime() {
  const currentClockTimer = clockTimer;
  clockTimer = null;
  if (currentClockTimer != null) runCleanup(() => clearInterval(currentClockTimer));
  const currentResizeTimer = resizeTimer;
  resizeTimer = null;
  if (currentResizeTimer != null) runCleanup(() => clearTimeout(currentResizeTimer));
  runCleanup(() => window.removeEventListener('resize', handleResize));
  runCleanup(() => window.removeEventListener('evt:advance', bumpNotice));
  showVideo.value = false;
  selectedTarget.value = null;
  destroyVideo();
  const currentMap = map;
  map = null;
  if (currentMap) runCleanup(() => currentMap.destroy());
  const currentMapHint = mapHint;
  mapHint = null;
  if (currentMapHint) runCleanup(() => currentMapHint.remove());
  disposeBigScreenCharts();
  clock.value = '—';
  runtimeStarted = false;
}

function startReadyRuntime() {
  const data = screenData.value;
  if (!mounted || queryStatus.value !== 'ready' || !data) return;
  if (runtimeStarted) stopReadyRuntime();
  runtimeStarted = true;
  runtimeChart = data.chart;
  try {
    clock.value = data.initialClock;
    clockTimer = window.setInterval(() => {
      try {
        const currentData = screenData.value;
        if (!currentData) throw new Error('大屏运行数据已失效');
        const nextClock = currentData.systemNowStr();
        if (typeof nextClock !== 'string') throw new TypeError('MOCK.systemNowStr 必须返回字符串');
        clock.value = nextClock;
      } catch (err) {
        failReadyRuntime(err);
      }
    }, 1000);
    window.addEventListener('resize', handleResize);
    window.addEventListener('evt:advance', bumpNotice);
    renderCharts();
    renderMap();
  } catch (err) {
    failReadyRuntime(err);
  }
}

function failBigScreen(err) {
  screenData.value = null;
  queryError.value = err instanceof Error ? err.message : String(err || '大屏本地数据无效');
  queryStatus.value = 'error';
}

function failReadyRuntime(err) {
  stopReadyRuntime();
  failBigScreen(err);
}

async function reloadBigScreen() {
  queryStatus.value = 'loading';
  queryError.value = '';
  screenData.value = null;
  await nextTick();
  try {
    const data = validateBigScreenData();
    screenData.value = data;
    queryStatus.value = hasVisibleBusinessData(data) ? 'ready' : 'empty';
  } catch (err) {
    failBigScreen(err);
  }
}

async function refreshBigScreenData() {
  if (queryStatus.value !== 'ready') return;
  try {
    const data = validateBigScreenData();
    if (!hasVisibleBusinessData(data)) {
      screenData.value = null;
      queryStatus.value = 'empty';
      return;
    }
    screenData.value = data;
    clock.value = data.initialClock;
    await nextTick();
    if (mounted && queryStatus.value === 'ready') {
      renderCharts();
      refreshMapData();
    }
  } catch (err) {
    failReadyRuntime(err);
  }
}

function bumpNotice() {
  noticeTick.value++;
  refreshBigScreenData();
}

watch(queryStatus, async (status, previous) => {
  if (!mounted) return;
  if (previous === 'ready' && status !== 'ready') stopReadyRuntime();
  if (status !== 'ready' || previous === 'ready') return;
  await nextTick();
  if (mounted && queryStatus.value === 'ready') startReadyRuntime();
}, { flush: 'pre' });

onMounted(() => {
  mounted = true;
  reloadBigScreen();
});

onBeforeUnmount(() => {
  mounted = false;
  stopReadyRuntime();
});
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides" style="display: contents">
    <div class="bs-root">
      <header class="bs-hdr">
        <div class="bs-hdr-l"><img src="/assets/img/brand/logo-mark.png" alt="" width="30" height="30">无人机融合感知与低空安全管理平台</div>
        <div class="bs-hdr-t"><i class="bs-wing" aria-hidden="true"></i><span>低空安全数据大屏</span><i class="bs-wing r" aria-hidden="true"></i></div>
        <div class="bs-hdr-r">
          <span v-if="queryStatus === 'ready'" style="color:#8ed9ff;font-size:11px">Mock 演示数据 · 未接入大屏业务数据接口</span>
          <span class="bs-clock">{{ clock }}</span>
          <n-button class="bs-exit" tag="a" href="#/situation" size="small" ghost title="返回业务系统">退出大屏</n-button>
        </div>
      </header>

      <PageQueryShell
        :status="queryStatus"
        loading-text="正在校验大屏 Mock 演示数据…"
        empty-title="暂无大屏业务数据"
        empty-description="当前大屏可见业务集合均为空。数据源仍为 Mock 演示数据。"
        error-title="大屏数据加载失败"
        :error-message="queryError || '本地演示数据无效，且不会显示部分或旧数据。'"
        @retry="reloadBigScreen">
        <div class="bs-grid">
        <aside class="bs-col">
          <section class="panel">
            <div class="ph"><h3>感知与违法趋势</h3><div class="bs-panel-meta"><span class="sub">近 7 日</span><button class="bs-module-link" @click="go('stats')">进入统计 →</button></div></div>
            <div class="pb"><div ref="trendEl" class="bs-chart" role="img" aria-label="近七日感知目标与非法目标趋势"></div></div>
          </section>

          <section class="panel" data-module="target-dynamics">
            <div class="ph"><h3>重点目标风险态势</h3><div class="bs-panel-meta"><span class="sub">{{ targetSummary }}</span><button class="bs-module-link" @click="go('legality')">进入研判 →</button></div></div>
            <div class="pb bs-visual-body">
              <div ref="targetChartEl" class="bs-panel-chart is-clickable" role="link" tabindex="0" aria-label="查看重点目标合法性研判" @click="go('legality')" @keydown.enter="go('legality')" @keydown.space.prevent="go('legality')"></div>
            </div>
          </section>

          <section class="panel">
            <div class="ph"><h3>处置闭环待办</h3><button class="bs-module-link" @click="go('alarms')">进入处置 →</button></div>
            <div class="pb bs-action-grid">
              <button v-for="item in closureItems" :key="item.label" class="bs-action-card" :class="`is-${item.tone}`" :aria-label="`${item.label} ${item.value}，进入对应业务页面`" @click="go(item.page)">
                <n-icon class="bs-action-icon" :component="item.icon" aria-hidden="true" />
                <b>{{ item.value }}</b><span>{{ item.label }}</span><small>查看待办 →</small>
              </button>
            </div>
          </section>
        </aside>

        <main class="bs-mid">
          <div class="bs-kpis">
            <button v-for="item in kpis" :key="item.label" class="kpi" :style="{ '--kpi-tone': item.color }" :aria-label="`${item.label} ${item.value}，进入对应业务页面`" @click="go(item.page)">
              <div class="v">{{ item.value }}</div><div class="ring"></div><div class="lb">{{ item.label }}</div><small>点击查看</small>
            </button>
          </div>
          <div class="bs-map-shell">
            <div id="bsMap" ref="mapEl" class="bs-map"></div>
            <button class="bs-map-link" @click="go('situation')">全域融合态势 · 进入融合感知 →</button>
          </div>
        </main>

        <aside class="bs-col">
          <section class="panel">
            <div class="ph"><h3>设备健康与异常</h3><div class="bs-panel-meta"><span class="sub">{{ deviceSummary }}</span><button class="bs-module-link" @click="go('monitor')">进入监测 →</button></div></div>
            <div class="pb bs-visual-body bs-device-visual">
              <div class="bs-device-chart-wrap">
                <div ref="deviceChartEl" class="bs-panel-chart is-ring is-clickable" role="link" tabindex="0" aria-label="进入设备监测" @click="go('monitor')" @keydown.enter="go('monitor')" @keydown.space.prevent="go('monitor')"></div>
                <div class="bs-device-legend">
                  <button @click="go('monitor')"><i class="is-offline"></i><span>离线</span><b>{{ screenData?.deviceStats.offline }}</b></button>
                  <button @click="go('monitor')"><i class="is-abnormal"></i><span>异常</span><b>{{ screenData?.deviceStats.abnormal }}</b></button>
                  <button @click="go('monitor')"><i class="is-alarm"></i><span>告警设备</span><b>{{ screenData?.deviceStats.alarm }}</b></button>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="ph"><h3>飞行监管态势</h3><button class="bs-module-link" @click="go('flights')">进入监管 →</button></div>
            <div class="pb bs-visual-body bs-flight-body">
              <div ref="flightChartEl" class="bs-panel-chart is-clickable" role="link" tabindex="0" aria-label="进入飞行计划监管" @click="go('flights')" @keydown.enter="go('flights')" @keydown.space.prevent="go('flights')"></div>
            </div>
          </section>

          <section class="panel">
            <div class="ph"><h3>实时告警</h3><div class="bs-panel-meta"><span class="sub">{{ alarmSummary }}</span><button class="bs-module-link" @click="go('alarms')">进入告警 →</button></div></div>
            <div class="pb bs-table-body">
              <n-data-table class="bs-naive-table" :columns="alarmColumns" :data="alarms" :pagination="false" :bordered="false" :single-line="true" table-layout="auto" size="small" :row-props="alarmRowProps" />
            </div>
          </section>
        </aside>
        </div>

        <n-modal v-model:show="showVideo" :auto-focus="false" @after-leave="destroyVideo">
          <n-card class="bs-video-card" :title="`实时视频 · ${selectedTarget?.id || ''}`" closable :bordered="true" role="dialog" aria-modal="true" @close="showVideo = false">
            <div v-if="selectedTarget" class="bs-video-modal">
              <div class="bs-video-meta"><span>{{ opticalDevice?.name || '光电设备' }} · EO 可见光 · 4K</span><span class="bs-video-state" :class="{ 'is-tracked': selectedTarget.tracked }"><i></i>{{ selectedTarget.tracked ? '锁定跟踪中' : '实时预览' }}</span></div>
              <div ref="videoEl" id="bsVideoModal"></div>
              <div class="bs-video-info"><span>目标编号 <b class="mono">{{ selectedTarget.id }}</b></span><span>目标类型 <b>{{ selectedTarget.type }}</b></span><span>合法性 <b>{{ selectedTarget.legal || '待确认' }}</b></span><span>风险等级 <b>{{ selectedTarget.risk || '—' }}</b></span></div>
            </div>
          </n-card>
        </n-modal>
        <template #emptyAction>
          <n-button type="primary" size="small" @click="reloadBigScreen">重新加载</n-button>
        </template>
      </PageQueryShell>
    </div>
  </n-config-provider>
</template>
