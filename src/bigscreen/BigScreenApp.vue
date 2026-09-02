<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NCard, NConfigProvider, NDataTable, NIcon, NModal } from 'naive-ui';
import {
  BriefcaseOutline,
  DocumentAttachOutline,
  NotificationsOutline,
  RadioOutline
} from '@vicons/ionicons5';
import { theme, themeOverrides } from '../ui/theme.js';
import { refreshWeather, weatherState } from '../services/weather.js';

const M = window.MOCK;
const U = window.UI;
const E = window.EVT;

const clock = ref(M.systemNowStr());
const viewportHeight = ref(window.innerHeight);
const showVideo = ref(false);
const selectedTarget = ref(null);
const trendEl = ref(null);
const targetChartEl = ref(null);
const deviceChartEl = ref(null);
const flightChartEl = ref(null);
const mapEl = ref(null);
const videoEl = ref(null);

let clockTimer = null;
let weatherTimer = null;
let resizeTimer = null;
let map = null;
let video = null;

const riskScore = { 高风险: 3, 中风险: 2, 低风险: 1 };
const alarmColor = { 高: 'var(--red)', 中: 'var(--amber)', 低: 'var(--cyan)' };
const alarmLevelScore = { 高: 3, 中: 2, 低: 1 };
const alarmFlowScore = { 待核实: 0, 反制中: 1, 干扰中: 2, 待处置: 3, 新建: 4, 处置中: 5, 已关闭: 6, 误报: 7 };
const legacyFlowStatus = { 新建: '待核实', 已确认: '待核实', 处置中: '反制中', 已关闭: '待处置', 误报: '误报' };

let noticedCases = {};
try { noticedCases = JSON.parse(sessionStorage.getItem('punish.notice.v1') || '{}') || {}; } catch (e) { noticedCases = {}; }

const rowLimit = computed(() => viewportHeight.value < 760 ? 2 : viewportHeight.value < 850 ? 3 : 4);
const alarmFlowStatus = alarm => alarm.flowStatus || legacyFlowStatus[alarm.status] || alarm.status || '待核实';
const noticeStatus = item => noticedCases[item.id] || (item.status === '已结案' ? '已通知' : '待通知');
const isEvidenceException = item => item.verifyState !== '完好';
const isPlanDeviated = plan => {
  const d = plan.deviation;
  if (!d) return false;
  return (d.lateral != null && Math.abs(d.lateral) > 500)
    || (d.timeMin != null && Math.abs(d.timeMin) > 20)
    || (d.altDelta != null && Math.abs(d.altDelta) > 20);
};

const targetAll = computed(() => M.liveTargets.filter(t => t.type === '无人机').slice().sort((a, b) =>
  (riskScore[b.risk] || 0) - (riskScore[a.risk] || 0)
  || Number(b.legal === '待确认') - Number(a.legal === '待确认')
  || Number(!!b.tracked) - Number(!!a.tracked)
  || b.ts - a.ts
));
const judgementPending = computed(() => M.todayTargets.filter(t =>
  t.type === '无人机' && (t.legal === '非法' || t.legal === '待确认')).length);
const pendingCases = computed(() => M.cases.filter(c => c.status !== '已结案' || noticeStatus(c) === '待通知'));
const evidenceExceptions = computed(() => M.evidenceFiles.filter(isEvidenceException));

const alarmAll = computed(() => M.todayAlarms.slice().map(a => ({ ...a, _flowStatus: alarmFlowStatus(a) })).sort((a, b) =>
  (alarmFlowScore[a._flowStatus] ?? 99) - (alarmFlowScore[b._flowStatus] ?? 99)
  || (alarmLevelScore[b.level] || 0) - (alarmLevelScore[a.level] || 0)
  || b.ts - a.ts
));
const alarms = computed(() => alarmAll.value.slice(0, rowLimit.value));

const deviceExceptions = computed(() => M.devices.filter(d => d.status !== '在线' || d.alarm).slice().sort((a, b) =>
  Number(!!b.alarm) - Number(!!a.alarm)
  || ({ 异常: 3, 离线: 2, 在线: 1 }[b.status] || 0) - ({ 异常: 3, 离线: 2, 在线: 1 }[a.status] || 0)
  || (b.hbMin || 0) - (a.hbMin || 0)
));
const flightPlans = computed(() => M.flightPlans || []);
const flightMetrics = computed(() => [
  { label: '今日计划', value: flightPlans.value.length, page: 'flights' },
  { label: '执行中', value: flightPlans.value.filter(p => p.status === '执行中').length, page: 'flights' },
  { label: '未匹配', value: flightPlans.value.filter(p => p.matched === '未匹配感知目标').length, page: 'flights' },
  { label: '偏离计划', value: flightPlans.value.filter(isPlanDeviated).length, page: 'flights', tone: 'bad' }
]);

const closureItems = computed(() => [
  { label: '待核实告警', value: alarmAll.value.filter(a => a._flowStatus === '待核实').length, page: 'alarms', tone: 'warn', icon: NotificationsOutline },
  { label: '反制 / 干扰中', value: alarmAll.value.filter(a => ['反制中', '干扰中'].includes(a._flowStatus)).length, page: 'alarms', tone: 'bad', icon: RadioOutline },
  { label: '待通知案件', value: M.cases.filter(c => noticeStatus(c) === '待通知').length, page: 'punish', tone: 'warn', icon: BriefcaseOutline },
  { label: '证据异常', value: evidenceExceptions.value.length, page: 'evidence', tone: evidenceExceptions.value.length ? 'bad' : 'good', icon: DocumentAttachOutline }
]);

const kpis = computed(() => {
  const counts = E.counts();
  return [
    { label: '今日感知目标', value: counts.found, color: '#ffd53d', page: 'situation' },
    { label: '今日告警', value: alarmAll.value.length, color: 'var(--cyan)', page: 'alarms' },
    { label: '待研判目标', value: judgementPending.value, color: 'var(--amber)', page: 'legality' },
    { label: '待处置案件', value: pendingCases.value.length, color: 'var(--red)', page: 'punish' }
  ];
});

const targetSummary = computed(() => `实时 ${targetAll.value.length} 架 · 高风险 ${targetAll.value.filter(t => t.risk === '高风险').length}`);
const deviceSummary = computed(() => `在线率 ${M.deviceStats.onlineRate}% · 关注 ${deviceExceptions.value.length}`);
const alarmSummary = computed(() => `今日 ${alarmAll.value.length} 条 · 待核实 ${alarmAll.value.filter(a => a._flowStatus === '待核实').length}`);
const opticalDevice = computed(() => M.devices.find(d => d.type === '光电' && d.status === '在线'));
const weatherTemp = computed(() => {
  const w = weatherState;
  return w.temperature == null ? `${w.tempLo}℃~${w.tempHi}℃` : `${w.temperature}℃`;
});
const weatherDetail = computed(() => {
  const w = weatherState;
  const wind = w.windDirection ? ` · ${w.windDirection}风${w.windPower ? `${w.windPower}级` : ''}` : '';
  return ` · ${w.text}${wind}`;
});
const weatherTitle = computed(() => {
  const w = weatherState;
  return [w.source, w.reportTime && `发布 ${w.reportTime}`, w.humidity && `湿度 ${w.humidity}%`, w.error].filter(Boolean).join(' · ');
});

const mono = text => h('span', { class: 'mono' }, text);
const colored = (text, color) => h('span', { style: { color } }, text);

function go(page, context) {
  showVideo.value = false;
  U.goto(page, context);
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
  const days = M.stats.days.slice(-7);
  const gradedTargets = ['高风险', '中风险', '低风险'].reduce((sum, level) =>
    sum + targetAll.value.filter(t => t.risk === level).length, 0);
  window.CH.line(trendEl.value, {
    x: days.map(x => x.md),
    series: [
      { name: '发现目标', data: days.map(x => x.total), color: window.CH.C.blue, area: true },
      { name: '非法目标', data: days.map(x => x.illegal), color: window.CH.C.red }
    ]
  });
  window.CH.donut(targetChartEl.value, {
    data: [
      { name: '高风险', value: targetAll.value.filter(t => t.risk === '高风险').length, c: window.CH.C.red },
      { name: '中风险', value: targetAll.value.filter(t => t.risk === '中风险').length, c: window.CH.C.amber },
      { name: '低风险', value: targetAll.value.filter(t => t.risk === '低风险').length, c: window.CH.C.green },
      { name: '未定级', value: Math.max(0, targetAll.value.length - gradedTargets), c: window.CH.C.gray }
    ],
    centerLabel: '重点目标', centerValue: targetAll.value.length, showPct: false,
    narrow: false, center: ['31%', '50%'], radius: ['45%', '66%']
  });
  window.CH.ring(deviceChartEl.value, {
    value: M.deviceStats.onlineRate, label: '设备在线率', color: window.CH.C.cyan, fs: 24
  });
  window.CH.bar(flightChartEl.value, {
    x: flightMetrics.value.map(item => item.label), legend: false,
    grid: { left: 30, right: 8, top: 20, bottom: 24 },
    series: [{
      name: '数量', data: flightMetrics.value.map(item => item.value), width: 24,
      colorBy: p => p.dataIndex === 3 ? window.CH.C.red : [window.CH.C.blue, window.CH.C.green, window.CH.C.amber][p.dataIndex]
    }]
  });
}

function openVideo(target) {
  if (!target || target.type !== '无人机') return;
  selectedTarget.value = target;
  showVideo.value = true;
}

function renderMap() {
  map = new window.MapView(mapEl.value, {
    zoom: 1.06,
    maxDev: 46,
    maxAlarm: 8,
    onPick: pick => {
      if (!pick || pick.kind !== 'target' || !pick.data || pick.data.type !== '无人机') return;
      map.sel = pick.data.id;
      map.draw();
      openVideo(pick.data);
    }
  });
  const hint = document.createElement('div');
  hint.className = 'bs-map-hint';
  hint.textContent = '点击地图上的无人机查看实时视频';
  mapEl.value.appendChild(hint);
  map.setData({
    airspaces: M.airspaces,
    devices: M.devices.filter((d, i) => i % 4 === 0),
    targets: M.liveTargets,
    alarms: M.todayAlarms.slice(0, 8)
  });
}

function destroyVideo() {
  if (video) video.destroy();
  video = null;
}

async function mountVideo() {
  destroyVideo();
  if (!showVideo.value || !selectedTarget.value) return;
  await nextTick();
  if (!videoEl.value) return;
  video = new window.EOVideo(videoEl.value, {
    height: Math.max(300, Math.min(430, window.innerHeight * .46)),
    targetId: selectedTarget.value.id,
    device: opticalDevice.value ? opticalDevice.value.name : undefined,
    locked: !!selectedTarget.value.tracked
  });
}

watch([showVideo, selectedTarget], ([visible]) => {
  if (visible) mountVideo();
  else destroyVideo();
}, { flush: 'post' });

function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { viewportHeight.value = window.innerHeight; }, 120);
}

onMounted(() => {
  clockTimer = window.setInterval(() => { clock.value = M.systemNowStr(); }, 1000);
  refreshWeather();
  weatherTimer = window.setInterval(refreshWeather, 30 * 60 * 1000);
  window.addEventListener('resize', handleResize);
  requestAnimationFrame(() => {
    renderCharts();
    renderMap();
  });
});

onBeforeUnmount(() => {
  clearInterval(clockTimer);
  clearInterval(weatherTimer);
  clearTimeout(resizeTimer);
  window.removeEventListener('resize', handleResize);
  destroyVideo();
  if (map) map.destroy();
  map = null;
  window.CH.disposeAll();
});
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides" style="display: contents">
    <div class="bs-root">
      <header class="bs-hdr">
        <div class="bs-hdr-l"><img src="/assets/img/brand/logo-mark.png" alt="" width="30" height="30">无人机融合感知与低空安全管理平台</div>
        <div class="bs-hdr-t"><i class="bs-wing" aria-hidden="true"></i><span>低空安全数据大屏</span><i class="bs-wing r" aria-hidden="true"></i></div>
        <div class="bs-hdr-r"><span class="bs-weather" :title="weatherTitle"><span>{{ weatherState.city }} · {{ weatherTemp }}</span><span class="bs-weather-detail">{{ weatherDetail }}</span></span><span class="bs-clock">{{ clock }}</span><n-button class="bs-exit" tag="a" href="#/situation" size="small" ghost title="返回业务系统">退出大屏</n-button></div>
      </header>

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
                  <button @click="go('monitor')"><i class="is-offline"></i><span>离线</span><b>{{ M.deviceStats.offline }}</b></button>
                  <button @click="go('monitor')"><i class="is-abnormal"></i><span>异常</span><b>{{ M.deviceStats.abnormal }}</b></button>
                  <button @click="go('monitor')"><i class="is-alarm"></i><span>告警设备</span><b>{{ M.deviceStats.alarm }}</b></button>
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
  </n-config-provider>
</template>
