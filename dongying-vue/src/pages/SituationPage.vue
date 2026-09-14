<script setup>
/* 融合感知指挥台：本期显式使用页面私有模拟源。
   模拟数据不会在接口失败时被当作真实数据，也不会发起任何真实设备指令。 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { createSituationMockSource } from '@/pages/situation/situationMock.js';

const U = window.UI;
usePageChrome('situation');

const VIEWED_STORAGE_KEY = 'situation.mock.viewed.v1';
const SCENARIO_STORAGE_KEY = 'situation.mock.started-at.v1';
const mapHost = ref(null);
const snapshot = ref({ generatedAt: 0, simulated: true, devices: [], targets: [], alarms: [], airspaces: [] });
const selection = ref(null);
const expandedType = ref('');
const fuseOpen = ref(false);
const source = createSituationMockSource({ startedAt: loadScenarioStartedAt() });
const layers = ref({ coverage: true, device: true, track: true, airspace: true });
const statusAnnouncement = ref('模拟场景准备中');
let viewedKeys = loadViewedKeys();
let rawSnapshot = null;
let map = null;
let stopSource = null;

function loadScenarioStartedAt() {
  try {
    const stored = Number(sessionStorage.getItem(SCENARIO_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
    const startedAt = Date.now();
    sessionStorage.setItem(SCENARIO_STORAGE_KEY, String(startedAt));
    return startedAt;
  } catch {
    return Date.now();
  }
}

const devices = computed(() => snapshot.value.devices || []);
const alarms = computed(() => (snapshot.value.alarms || []).slice().sort((a, b) => b.ts - a.ts));
const targets = computed(() => snapshot.value.targets || []);
const onlineDeviceCount = computed(() => devices.value.filter(device => device.status === '在线').length);
const deviceGroups = computed(() => ['RADAR', 'EO', 'FIVE_G_A', 'TDOA'].map(typeCode => {
  const items = devices.value.filter(device => device.typeCode === typeCode);
  const sample = items[0] || {};
  const meters = items.map(device => device.coverage?.kind === 'sector' ? device.coverage.rangeM : device.coverage?.radiusM)
    .filter(Number.isFinite);
  const min = meters.length ? Math.min(...meters) : null;
  const max = meters.length ? Math.max(...meters) : null;
  const range = min == null ? '参数未知' : min === max ? `${min / 1000} km` : `${min / 1000}–${max / 1000} km`;
  return {
    typeCode, label: sample.type || typeCode, icon: sample.icon, color: sample.color,
    items, total: items.length, online: items.filter(device => device.status === '在线').length,
    hasNew: items.some(device => device.newAlert),
    rangeText: typeCode === 'EO' ? `单站 ${range} 定向视场` : `单站 ${range} 有效范围`
  };
}));
const newAlarmCount = computed(() => alarms.value.filter(alarm => alarm.isNew).length);
const selectedTarget = computed(() => {
  if (selection.value?.kind !== 'target') return null;
  return targets.value.find(target => target.id === selection.value.id) || null;
});
const fusionDevices = computed(() => {
  const ids = new Set(selectedTarget.value?.sourceDeviceIds || []);
  return devices.value.filter(device => ids.has(device.id));
});
const fusionConfidence = computed(() => selectedTarget.value?.fusedConf ?? null);
const clockText = computed(() => formatClock(snapshot.value.generatedAt));
const fuseIcon = U.icon('radar');

function loadViewedKeys() {
  try {
    const value = JSON.parse(sessionStorage.getItem(VIEWED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

function alarmKey(alarm) {
  return `${alarm?.id || ''}:${Number(alarm?.ts || 0)}`;
}

function persistViewedKeys() {
  sessionStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify([...viewedKeys]));
}

function isNewAlarm(alarm) {
  return !viewedKeys.has(alarmKey(alarm));
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatClock(value) {
  if (!Number(value)) return '—';
  return new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false });
}

function reportAge(value) {
  if (!Number(value) || !snapshot.value.generatedAt) return '未上报';
  const seconds = Math.max(0, Math.round((snapshot.value.generatedAt - Number(value)) / 1000));
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function iconHtml(device) {
  return U.icon(device.icon || 'device');
}

function statusClass(status) {
  return status === '在线' ? 'is-online' : status === '离线' ? 'is-offline' : 'is-warning';
}

function toggleDeviceType(typeCode) {
  expandedType.value = expandedType.value === typeCode ? '' : typeCode;
}

function decorate(next) {
  const nextAlarms = (next.alarms || []).map(alarm => ({ ...alarm, isNew: isNewAlarm(alarm) }));
  const targetAlarms = new Map();
  nextAlarms.forEach(alarm => {
    const rows = targetAlarms.get(alarm.targetId) || [];
    rows.push(alarm);
    targetAlarms.set(alarm.targetId, rows);
  });
  const nextDevices = (next.devices || []).map(device => {
    const relatedAlerts = (device.relatedAlerts || []).map(alarm => ({ ...alarm, isNew: isNewAlarm(alarm) }));
    return { ...device, relatedAlerts, newAlert: relatedAlerts.some(alarm => alarm.isNew) };
  });
  const nextTargets = (next.targets || []).map(target => {
    const related = targetAlarms.get(target.id) || [];
    return {
      ...target,
      activeRisk: related.length > 0,
      newAlert: related.some(alarm => alarm.isNew),
      relatedAlarms: related
    };
  });
  return { ...next, alarms: nextAlarms, devices: nextDevices, targets: nextTargets };
}

function applySnapshot(next) {
  rawSnapshot = next;
  const decorated = decorate(next);
  snapshot.value = decorated;
  const count = decorated.alarms.filter(alarm => alarm.isNew).length;
  statusAnnouncement.value = count
    ? `模拟数据已更新，${count} 条新异常`
    : '模拟数据已更新，当前无未查看异常';
  if (!map) return;
  map.setData({
    airspaces: decorated.airspaces,
    devices: decorated.devices,
    targets: decorated.targets,
    alarms: []
  });
  if (selection.value) map.pinHit(selection.value.kind, selection.value.id);
}

function markViewed(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return;
  let changed = false;
  list.forEach(alarm => {
    const key = alarmKey(alarm);
    if (!viewedKeys.has(key)) {
      viewedKeys.add(key);
      changed = true;
    }
  });
  if (!changed) return;
  persistViewedKeys();
  if (rawSnapshot) applySnapshot(rawSnapshot);
}

function selectDevice(device) {
  if (!device) return;
  markViewed(device.relatedAlerts || []);
  selection.value = { kind: 'device', id: device.id };
  fuseOpen.value = false;
  if (map) {
    map.sel = null;
    map.centerAt(device.lon, device.lat, { scale: map.zoom });
    map.pinHit('device', device.id);
  }
}

function selectTarget(target) {
  if (!target) return;
  markViewed(target.relatedAlarms || []);
  selection.value = { kind: 'target', id: target.id };
  if (map) {
    map.sel = target.id;
    map.centerAt(target.lon, target.lat, { scale: map.zoom });
    map.pinHit('target', target.id);
  }
}

function selectAlarm(alarm) {
  markViewed(alarm);
  selectTarget(targets.value.find(target => target.id === alarm.targetId));
}

function clearSelection() {
  selection.value = null;
  fuseOpen.value = false;
  if (!map) return;
  map.sel = null;
  map.clearPinnedHit();
}

function renderDeviceTip(device) {
  const coverage = device.coverage || { status: 'unknown' };
  const unavailable = coverage.status === 'unavailable';
  const coverageState = coverage.status === 'unknown' ? '覆盖参数未知'
    : unavailable ? `${device.coverageText}（当前不可用）` : device.coverageText;
  const related = (device.relatedAlerts || []).slice(0, 2);
  return `<section class="sit-map-pop sit-map-pop-device" style="--sensor:${esc(device.color)}">
    <header><span class="sit-map-pop-icon">${iconHtml(device)}</span><span><b>${esc(device.name)}</b><small class="mono">${esc(device.id)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭设备详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${statusClass(device.status)}">${esc(device.status)}</span><span>最新上报 ${esc(reportAge(device.lastReportAt))}</span></div>
    <dl><dt>覆盖参数</dt><dd class="${unavailable ? 'is-unavailable' : ''}">${esc(coverageState)}</dd>
      <dt>参数来源</dt><dd>${esc(coverage.sourceLabel || '未提供')}</dd>
      <dt>更新时间</dt><dd class="mono">${formatClock(coverage.updatedAt)}</dd></dl>
    <div class="sit-map-pop-alerts"><b>相关设备告警</b>${related.length
      ? related.map(alarm => `<span class="${alarm.isNew ? 'is-new' : ''}">${esc(alarm.title)} · ${alarm.isNew ? '新异常' : '已查看，风险持续'}</span>`).join('')
      : '<span>当前无关联告警</span>'}</div>
  </section>`;
}

function renderTargetTip(target) {
  const alarm = (target.relatedAlarms || [])[0];
  const sourceNames = devices.value.filter(device => (target.sourceDeviceIds || []).includes(device.id)).map(device => device.type).join(' / ');
  return `<section class="sit-map-pop sit-map-pop-target${target.newAlert ? ' is-new' : ''}">
    <header><span class="sit-map-pop-icon">${U.icon('plane')}</span><span><b>${esc(target.id)}</b><small>${esc(target.typeLabel)}</small></span>
      <button type="button" data-tip-act="close" aria-label="关闭无人机详情">${U.icon('close')}</button></header>
    <div class="sit-map-pop-status"><span class="sit-state ${target.activeRisk ? 'is-risk' : 'is-online'}">${target.activeRisk ? '风险持续' : '跟踪中'}</span><span>${alarm ? esc(alarm.type) : '暂无关联异常'}</span></div>
    <div class="sit-target-metrics"><span><small>高度</small><b>${esc(target.alt)} m</b></span><span><small>速度</small><b>${esc(target.speed)} m/s</b></span><span><small>融合置信</small><b>${esc(target.fusedConf)}%</b></span></div>
    <p>感知来源：${esc(sourceNames || '未提供')}</p>
    <div class="sit-map-pop-note">${target.activeRisk ? '已查看，风险状态仍保留。' : '目标处于模拟实时跟踪中。'}</div>
    <div class="sit-map-pop-actions"><button type="button" disabled title="模拟态不下发真实设备指令">光电跟踪 · 模拟态</button></div>
  </section>`;
}

function renderMapTip(hit) {
  if (hit?.kind === 'device') return renderDeviceTip(hit.data);
  if (hit?.kind === 'target') return renderTargetTip(hit.data);
  return null;
}

function onMapPick(hit) {
  if (hit?.kind === 'device') selectDevice(devices.value.find(device => device.id === hit.data.id));
  if (hit?.kind === 'target') selectTarget(targets.value.find(target => target.id === hit.data.id));
}

function onTipAction(action) {
  if (action === 'close') clearSelection();
}

function toggleLayer(key) {
  layers.value = { ...layers.value, [key]: !layers.value[key] };
  if (!map) return;
  if (key === 'airspace') {
    ['nofly', 'limit', 'suit'].forEach(layer => map.setLayer(layer, layers.value.airspace));
    return;
  }
  map.setLayer(key, layers.value[key]);
}

function toggleFuse() {
  if (selectedTarget.value) fuseOpen.value = !fuseOpen.value;
}

function onVisibilityChange() {
  if (document.hidden) source.pause();
  else source.resume();
  if (map?.setPaused) map.setPaused(document.hidden);
}

onMounted(() => {
  map = new window.MapView(mapHost.value, {
    maxDev: 120,
    maxAlarm: 0,
    zoom: 1,
    legend: false,
    fusionProfile: true,
    sensorIconScale: .82,
    maxDpr: 2,
    layers: { alarm: false, coverage: true },
    interactiveTip: true,
    renderTip: renderMapTip,
    onTipAction,
    onPick: onMapPick,
    onEmptyPick: clearSelection
  });
  stopSource = source.start(applySnapshot);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (stopSource) stopSource();
  stopSource = null;
  source.stop();
  if (map) map.destroy();
  map = null;
});
</script>

<template>
  <div id="view" class="view situation-page" @keydown.esc="clearSelection">
    <main class="sit-stage" aria-label="融合感知实时地图">
      <div id="stMap" ref="mapHost" class="sit-map"></div>

      <div class="sit-live-pill" aria-label="当前使用非生产模拟数据">
        <span class="sit-live-dot" aria-hidden="true"></span>
        <b>模拟数据</b>
        <span>非生产实时数据</span>
        <span>{{ targets.length }} 架监测目标</span>
        <time class="mono">{{ clockText }}</time>
      </div>
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ statusAnnouncement }}</p>

      <aside class="sit-glass sit-device-dock" aria-labelledby="sit-device-title">
        <header class="sit-dock-head">
          <span><small>SENSING FIELD</small><b id="sit-device-title">感知设备</b></span>
          <em><i></i>{{ onlineDeviceCount }} 在线 / {{ devices.length - onlineDeviceCount }} 离线</em>
        </header>
        <div class="sit-device-list">
          <section v-for="group in deviceGroups" :key="group.typeCode" class="sit-device-group" :style="{ '--sensor': group.color }">
            <button type="button" class="sit-device-row"
              :class="{ 'is-selected': group.items.some(device => selection?.kind === 'device' && selection.id === device.id), 'has-new': group.hasNew }"
              :aria-expanded="expandedType === group.typeCode" :aria-controls="`sit-device-${group.typeCode}`"
              :aria-label="`${expandedType === group.typeCode ? '收起' : '展开'}${group.label}设备，共${group.total}台`"
              @click="toggleDeviceType(group.typeCode)">
              <span class="sit-device-icon" v-html="iconHtml(group)"></span>
              <span class="sit-device-copy"><b>{{ group.label }}<small>{{ group.total }} 台</small></b><em>{{ group.rangeText }}</em></span>
              <span class="sit-device-state"><b>{{ group.online }}/{{ group.total }}</b><small>{{ expandedType === group.typeCode ? '收起' : '展开' }}</small></span>
            </button>
            <div v-show="expandedType === group.typeCode" :id="`sit-device-${group.typeCode}`" class="sit-device-node-list">
              <button v-for="device in group.items" :key="device.id" type="button" class="sit-device-node"
                :class="[{ 'is-selected': selection?.kind === 'device' && selection.id === device.id, 'has-new': device.newAlert }, statusClass(device.status)]"
                :aria-pressed="selection?.kind === 'device' && selection.id === device.id"
                :aria-label="`查看${device.type}设备 ${device.name}`" @click="selectDevice(device)">
                <span><i></i><b>{{ device.name }}</b><small class="mono">{{ device.id }}</small></span>
                <em>{{ device.status }} · {{ reportAge(device.lastReportAt) }}</em>
              </button>
            </div>
          </section>
        </div>
        <footer>共 {{ devices.length }} 台模拟设备；覆盖参数为公开指标量级，非现场实测。</footer>
      </aside>

      <aside class="sit-glass sit-alert-dock" aria-labelledby="sit-alert-title">
        <header class="sit-dock-head">
          <span><small>UAV ANOMALIES</small><b id="sit-alert-title">无人机实时异常</b></span>
          <em :class="{ 'has-new': newAlarmCount }">{{ newAlarmCount ? `${newAlarmCount} 条未查看` : '已全部查看' }}</em>
        </header>
        <div class="sit-alert-list">
          <button v-for="alarm in alarms" :key="alarmKey(alarm)" type="button" class="sit-alert-row"
            :class="[{ 'is-new': alarm.isNew, 'is-selected': selection?.kind === 'target' && selection.id === alarm.targetId }, `level-${alarm.level}`]"
            :aria-pressed="selection?.kind === 'target' && selection.id === alarm.targetId"
            :aria-label="`查看${alarm.targetId}的${alarm.type}，${alarm.isNew ? '新异常' : '已查看，风险持续'}`" @click="selectAlarm(alarm)">
            <span class="sit-alert-level">{{ alarm.level }}</span>
            <span class="sit-alert-copy"><b class="mono">{{ alarm.targetId }}</b><em>{{ alarm.type }} · {{ alarm.district }}</em></span>
            <span class="sit-alert-meta"><time class="mono">{{ formatClock(alarm.ts) }}</time><b>{{ alarm.isNew ? '新异常' : '已查看，风险持续' }}</b></span>
          </button>
        </div>
        <footer>查看只停止提示动画，不改变风险状态。</footer>
      </aside>

      <nav class="sit-layerbar" aria-label="地图图层">
        <button type="button" :aria-pressed="layers.coverage" @click="toggleLayer('coverage')">覆盖范围</button>
        <button type="button" :aria-pressed="layers.device" @click="toggleLayer('device')">设备点位</button>
        <button type="button" :aria-pressed="layers.track" @click="toggleLayer('track')">无人机轨迹</button>
        <button type="button" :aria-pressed="layers.airspace" @click="toggleLayer('airspace')">防控空域</button>
      </nav>

      <aside v-if="selectedTarget" class="sit-fuse-dock" :class="{ 'is-open': fuseOpen }" aria-label="多源融合结果">
        <button type="button" class="sit-fuse-orb" :aria-expanded="fuseOpen"
          :aria-label="fuseOpen ? '收起多源融合' : '展开多源融合'" @click="toggleFuse">
          <span class="sit-fuse-orb-cap"><small>多源融合</small><b>{{ fusionConfidence ?? '—' }}%</b></span>
          <span class="sit-fuse-orb-ball" aria-hidden="true"><span v-html="fuseIcon"></span></span>
        </button>
        <section class="sit-glass sit-fuse-panel">
          <header class="sit-dock-head"><span><small>FUSION LINKS</small><b>{{ selectedTarget.id }}</b></span><em>{{ fusionConfidence }}% 置信</em></header>
          <div class="sit-fuse-links">
            <span v-for="device in fusionDevices" :key="device.id" :style="{ '--sensor': device.color }">
              <i></i><b>{{ device.type }}</b><em>{{ device.status }}</em>
            </span>
          </div>
          <p>各来源为模拟链路，不代表现场已联调。</p>
        </section>
      </aside>
    </main>
  </div>
</template>
