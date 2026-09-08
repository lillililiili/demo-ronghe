<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NCard, NConfigProvider, NDataTable, NIcon, NModal } from 'naive-ui';
import {
  BriefcaseOutline,
  DocumentAttachOutline,
  NotificationsOutline,
  RadioOutline
} from '@vicons/ionicons5';
import { dateZhCN, theme, themeOverrides, zhCN } from '@/ui/theme.js';
import { getDashboardSnapshot } from '@/services/dashboardApi.js';
import { ALARM_TYPE_LABEL, LEGALITY_LABEL, OBJECT_TYPE_LABEL, labelOf, targetTypeLabel } from '@/ui/labels.js';

const clock = ref('');
const viewportHeight = ref(window.innerHeight);
const showVideo = ref(false);
const selectedTarget = ref(null);
const trendEl = ref(null);
const targetChartEl = ref(null);
const deviceChartEl = ref(null);
const flightChartEl = ref(null);
const mapEl = ref(null);
const videoEl = ref(null);
const loading = ref(true);
const error = ref('');
const snapshot = ref(null);

let clockTimer = null;
let resizeTimer = null;
let map = null;
let video = null;

const alarmColor = { 高: 'var(--red)', 中: 'var(--amber)', 低: 'var(--cyan)' };
const SEVERITY_ZH = { CRITICAL: '高', HIGH: '高', MEDIUM: '中', LOW: '低' };
const STATE_ZH = {
  PENDING_VERIFICATION: '待核实', EVIDENCE_REQUIRED: '证据待补充', CONFIRMED: '已核实待处置',
  FALSE_POSITIVE: '误报'
};
const AIRSPACE_KIND = {
  PROHIBITED: { type: '禁飞空域', color: '#ff4d5e' },
  RESTRICTED: { type: '限制空域', color: '#a97bff' },
  HEIGHT_LIMIT: { type: '限高空域', color: '#ffb020' },
  ALTITUDE_LIMIT: { type: '限高空域', color: '#ffb020' },
  SUITABLE: { type: '适飞空域', color: '#2fd06e' }
};
const GRADE_ZH = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' };

function formatClock(date) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
function formatTime(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dash(value) { return value == null ? '—' : value; }
function avail(key) { return snapshot.value?.availability?.[key] === 'AVAILABLE'; }

const rowLimit = computed(() => viewportHeight.value < 760 ? 2 : viewportHeight.value < 850 ? 3 : 4);

const kpis = computed(() => {
  const k = snapshot.value?.kpis || {};
  return [
    { label: '今日感知目标', value: dash(k.sensed_today), color: '#ffd53d', page: 'situation' },
    { label: '今日告警', value: dash(k.alarms_today), color: 'var(--cyan)', page: 'alarms' },
    { label: '待研判目标', value: dash(k.pending_assessment), color: 'var(--amber)', page: 'legality' },
    { label: '交接待办', value: dash(k.pending_handoffs), color: 'var(--red)', page: 'punish' }
  ];
});

const closureItems = computed(() => {
  const c = snapshot.value?.closure || {};
  return [
    { label: '待核实告警', value: dash(c.pending_verification), page: 'alarms', tone: 'warn', icon: NotificationsOutline },
    { label: '已核实待处置', value: dash(c.confirmed_blocked), page: 'alarms', tone: 'bad', icon: RadioOutline },
    { label: '交接待办', value: dash(c.pending_handoffs), page: 'punish', tone: 'warn', icon: BriefcaseOutline },
    { label: '证据管理', value: '未建设', page: 'evidence', tone: 'good', icon: DocumentAttachOutline }
  ];
});

const targetSummary = computed(() => {
  if (!avail('assessments') && !avail('targets')) return '无读取权限';
  const risk = snapshot.value?.target_risk;
  const n = snapshot.value?.kpis?.sensed_today;
  if (!risk) return n == null ? '—' : `今日 ${n}`;
  return `高 ${risk.high} · 中 ${risk.medium} · 低 ${risk.low} · 未定级 ${risk.ungraded}`;
});
const deviceSummary = computed(() => {
  const d = snapshot.value?.devices;
  if (!d) return avail('devices') ? '—' : '无读取权限';
  const rate = d.online_rate == null ? '—' : `${d.online_rate}%`;
  return `在线率 ${rate} · 关注 ${d.abnormal + d.alarm}`;
});
const alarmSummary = computed(() => {
  if (!avail('alarms')) return '无读取权限';
  const total = snapshot.value?.kpis?.alarms_today;
  const pending = snapshot.value?.closure?.pending_verification;
  return `今日 ${dash(total)} 条 · 待核实 ${dash(pending)}`;
});
const deviceLegend = computed(() => snapshot.value?.devices || { offline: '—', abnormal: '—', alarm: '—' });

const alarmRows = computed(() => (snapshot.value?.alarms?.items || []).slice(0, rowLimit.value).map(row => ({
  id: row.alarm_id,
  time: formatTime(row.received_at),
  type: labelOf(ALARM_TYPE_LABEL, row.alarm_type, row.alarm_type),
  level: SEVERITY_ZH[row.severity] || row.severity || '—',
  status: STATE_ZH[row.state] || row.state || '—'
})));

const opticalDevice = computed(() => (snapshot.value?.map?.devices || []).find(d =>
  /光电|EO|光学/.test(`${d.device_type_name || ''}${d.channel || ''}${d.name || ''}`)));

const mono = text => h('span', { class: 'mono' }, text);
const colored = (text, color) => h('span', { style: { color } }, text);

function go(page) {
  showVideo.value = false;
  location.hash = '#/' + page;
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
  { title: '时间', key: 'time', render: row => mono(row.time) },
  { title: '告警类型', key: 'type' },
  { title: '等级', key: 'level', render: row => colored(`● ${row.level}`, alarmColor[row.level] || 'var(--txt-2)') },
  { title: '状态', key: 'status' }
];

function renderCharts() {
  if (!window.CH) return;
  const days = snapshot.value?.trend?.days || [];
  window.CH.line(trendEl.value, {
    x: days.map(x => x.md),
    series: [
      { name: '发现目标', data: days.map(x => x.total), color: window.CH.C.blue, area: true },
      { name: '非法目标', data: days.map(x => x.illegal), color: window.CH.C.red }
    ]
  });
  const risk = snapshot.value?.target_risk || { high: 0, medium: 0, low: 0, ungraded: 0 };
  const riskTotal = risk.high + risk.medium + risk.low + risk.ungraded;
  window.CH.donut(targetChartEl.value, {
    data: [
      { name: '高风险', value: risk.high, c: window.CH.C.red },
      { name: '中风险', value: risk.medium, c: window.CH.C.amber },
      { name: '低风险', value: risk.low, c: window.CH.C.green },
      { name: '未定级', value: risk.ungraded, c: window.CH.C.gray }
    ],
    centerLabel: '重点目标', centerValue: riskTotal, showPct: false,
    narrow: false, center: ['31%', '50%'], radius: ['45%', '66%']
  });
  const devices = snapshot.value?.devices;
  window.CH.ring(deviceChartEl.value, {
    value: devices?.online_rate ?? 0, label: '设备在线率', color: window.CH.C.cyan, fs: 24
  });
  const flights = snapshot.value?.flights;
  window.CH.bar(flightChartEl.value, {
    x: ['今日计划', '执行中'], legend: false,
    grid: { left: 30, right: 8, top: 20, bottom: 24 },
    series: [{
      name: '数量',
      data: [flights?.today ?? 0, flights?.executing ?? 0],
      width: 24,
      colorBy: p => p.dataIndex === 1 ? window.CH.C.green : window.CH.C.blue
    }]
  });
}

function ringCentroid(ring) {
  let x = 0, y = 0;
  ring.forEach(p => { x += Number(p[0]); y += Number(p[1]); });
  return { lon: x / ring.length, lat: y / ring.length };
}

function mapAirspaces(items) {
  return (items || []).map(a => {
    const ring = a.boundary?.coordinates?.[0]?.[0];
    if (!ring?.length) return null;
    const poly = ring.map(p => [Number(p[0]), Number(p[1])]);
    const kind = AIRSPACE_KIND[a.kind_code] || { type: a.kind_code || '空域', color: '#8ca0be' };
    const limit = [a.min_altitude_m, a.max_altitude_m].filter(v => v != null).join('–');
    return {
      id: a.airspace_no || a.airspace_id, name: a.name, type: kind.type, color: kind.color, poly,
      center: ringCentroid(poly), limitTx: limit ? `${limit} m AMSL` : '—', unit: '—'
    };
  }).filter(Boolean);
}

function mapDevices(items) {
  return (items || []).map(d => ({
    id: d.device_id, name: d.name, type: d.device_type_name, channel: d.channel,
    status: ({ ONLINE: '在线', OFFLINE: '离线', ABNORMAL: '异常', UNKNOWN: '未知' })[d.connectivity] || d.connectivity || '未知',
    alarm: !!d.has_alarm, lon: Number(d.longitude), lat: Number(d.latitude)
  }));
}

function mapTargets(items) {
  return (items || []).map(t => ({
    id: t.target_id,
    type: t.object_type_code === 'UAV' ? '无人机' : labelOf(OBJECT_TYPE_LABEL, t.object_type_code, t.object_type_code || '目标'),
    subtype: targetTypeLabel(t.subtype, t.object_type_code),
    lon: Number(t.longitude), lat: Number(t.latitude),
    alt: t.altitude_amsl_m, speed: t.speed_mps, heading: t.heading_deg,
    legal: labelOf(LEGALITY_LABEL, t.legal_status, t.legal_status),
    risk: GRADE_ZH[t.grade] || t.grade,
    fusedConf: t.fusion_confidence == null ? null : Math.round(Number(t.fusion_confidence) * 100)
  }));
}

function mapAlarms(items) {
  return (items || []).map(a => ({
    targetId: a.target_id,
    type: labelOf(ALARM_TYPE_LABEL, a.alarm_type, a.alarm_type),
    level: SEVERITY_ZH[a.severity] || a.severity,
    time: formatTime(a.received_at),
    status: STATE_ZH[a.state] || a.state,
    district: ''
  }));
}

function openVideo(target) {
  if (!target || target.type !== '无人机') return;
  selectedTarget.value = target;
  showVideo.value = true;
}

function renderMap() {
  if (!mapEl.value) return;
  if (map) { map.destroy(); map = null; }
  map = new window.MapView(mapEl.value, {
    zoom: 1.06, maxDev: 46, maxAlarm: 8,
    onPick: pick => {
      if (!pick || pick.kind !== 'target' || !pick.data || pick.data.type !== '无人机') return;
      map.sel = pick.data.id;
      map.draw();
      openVideo(pick.data);
    }
  });
  const hint = document.createElement('div');
  hint.className = 'bs-map-hint';
  hint.textContent = '点击地图上的无人机查看实时视频（Demo 模拟画面）';
  mapEl.value.appendChild(hint);
  const layer = snapshot.value?.map || {};
  map.setData({
    airspaces: mapAirspaces(layer.airspaces),
    devices: mapDevices(layer.devices),
    targets: mapTargets(layer.targets),
    alarms: mapAlarms(layer.alarms)
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
    device: opticalDevice.value?.name,
    locked: false
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

async function load() {
  loading.value = true;
  error.value = '';
  try {
    snapshot.value = await getDashboardSnapshot();
    await nextTick();
    renderCharts();
    renderMap();
  } catch (e) {
    snapshot.value = null;
    error.value = e.message || '大屏数据加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  clock.value = formatClock(new Date());
  clockTimer = window.setInterval(() => { clock.value = formatClock(new Date()); }, 1000);
  window.addEventListener('resize', handleResize);
  load();
});

onBeforeUnmount(() => {
  clearInterval(clockTimer);
  clearTimeout(resizeTimer);
  window.removeEventListener('resize', handleResize);
  destroyVideo();
  if (map) map.destroy();
  map = null;
  window.CH?.disposeAll?.();
});
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN" style="display: contents">
    <div class="bs-root">
      <header class="bs-hdr">
        <div class="bs-hdr-l"><img src="/assets/img/brand/logo-mark.png" alt="" width="30" height="30">无人机融合感知与低空安全管理平台</div>
        <div class="bs-hdr-t"><i class="bs-wing" aria-hidden="true"></i><span>低空安全数据大屏</span><i class="bs-wing r" aria-hidden="true"></i></div>
        <div class="bs-hdr-r"><span class="bs-clock">{{ clock }}</span><n-button class="bs-exit" tag="a" href="#/situation" size="small" ghost title="返回业务系统">退出大屏</n-button></div>
      </header>

      <div v-if="error" class="bs-banner" role="alert">
        <span>{{ error }}</span>
        <button type="button" class="bs-module-link" @click="load">重试</button>
      </div>
      <div v-else-if="loading" class="bs-banner">正在加载大屏数据…</div>

      <div class="bs-grid">
        <aside class="bs-col">
          <section class="panel">
            <div class="ph"><h3>感知与违法趋势</h3><div class="bs-panel-meta"><span class="sub">{{ snapshot?.trend?.simulated ? '近 7 日 · 样本事实' : '近 7 日' }}</span><button class="bs-module-link" @click="go('stats')">进入统计 →</button></div></div>
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
              <div class="v">{{ item.value }}</div><div class="ring"></div><div class="lb">{{ item.label }}</div>
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
                  <button @click="go('monitor')"><i class="is-offline"></i><span>离线</span><b>{{ dash(deviceLegend.offline) }}</b></button>
                  <button @click="go('monitor')"><i class="is-abnormal"></i><span>异常</span><b>{{ dash(deviceLegend.abnormal) }}</b></button>
                  <button @click="go('monitor')"><i class="is-alarm"></i><span>告警设备</span><b>{{ dash(deviceLegend.alarm) }}</b></button>
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
              <n-data-table class="bs-naive-table" :columns="alarmColumns" :data="alarmRows" :pagination="false" :bordered="false" :single-line="true" table-layout="auto" size="small" :row-props="alarmRowProps" />
            </div>
          </section>
        </aside>
      </div>
    </div>

    <n-modal v-model:show="showVideo" :auto-focus="false" @after-leave="destroyVideo">
      <n-card class="bs-video-card" :title="`实时视频 · ${selectedTarget?.id || ''}`" closable :bordered="true" role="dialog" aria-modal="true" @close="showVideo = false">
        <div v-if="selectedTarget" class="bs-video-modal">
          <div class="bs-video-meta"><span>{{ opticalDevice?.name || '光电设备' }} · EO 可见光 · Demo 模拟</span><span class="bs-video-state"><i></i>实时预览</span></div>
          <div ref="videoEl" id="bsVideoModal"></div>
          <div class="bs-video-info"><span>目标编号 <b class="mono">{{ selectedTarget.id }}</b></span><span>目标类型 <b>{{ selectedTarget.type }}</b></span><span>合法性 <b>{{ selectedTarget.legal || '待确认' }}</b></span><span>风险等级 <b>{{ selectedTarget.risk || '—' }}</b></span></div>
        </div>
      </n-card>
    </n-modal>
  </n-config-provider>
</template>
