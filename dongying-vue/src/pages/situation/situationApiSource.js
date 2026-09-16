import { deviceApi } from '@/services/deviceApi.js';
import { targetApi } from '@/services/targetApi.js';
import { listAlarms } from '@/services/alarmApi.js';
import { listAllFlightPlans, flightApi } from '@/services/flightApi.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { riskApi } from '@/services/riskApi.js';
import { handoffApi } from '@/services/handoffApi.js';
import { mapPool } from '@/services/apiClient.js';
import {
  attachBearing, attachDeviceEvents, attachRecentTracks, attachTargetSourceLinks,
  bearingOrigins, toAirspaces, toAlarms, toDevices, toFlightPlans, toRisks, toTargets
} from '@/services/situationData.js';

const DEVICE_TYPES = new Set(['RADAR', 'EO', 'FIVE_G_A', 'TDOA']);
const FAST_MS = 5_000;
const SLOW_MS = 60_000;
const TARGET_WINDOW_MS = 5 * 60_000;

async function allPages(load, params = {}) {
  const items = [];
  let page = 1;
  let total = 0;
  do {
    const result = await load({ ...params, page, size: 100 });
    const batch = Array.isArray(result?.items) ? result.items : [];
    items.push(...batch);
    total = Math.max(0, Number(result?.total) || 0);
    if (!batch.length || items.length >= total) break;
    page += 1;
  } while (true);
  return items;
}

function shanghaiDay(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const from = Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60_000;
  return { from, to: from + 24 * 60 * 60_000 };
}

function sourceMode(snapshot) {
  const modes = new Set();
  const visit = rows => (rows || []).forEach(row => {
    const mode = String(row?.sourceMode || row?.source_mode || '').toLowerCase();
    if (mode === 'live' || mode === 'replay') modes.add(mode);
    if (mode === 'mixed') { modes.add('live'); modes.add('replay'); }
  });
  visit(snapshot.devices); visit(snapshot.targets); visit(snapshot.alarms);
  visit(snapshot.flightPlans); visit(snapshot.risks); visit(snapshot.handoffs);
  if (modes.size > 1) return 'mixed';
  return modes.values().next().value || 'unknown';
}

/**
 * 融合感知页真实数据源。一个串行调度器承载快慢轮询，页面隐藏时完全停表；
 * 任一分段失败只保留该分段最后一次真实结果，不会切回演示数据。
 */
export function createSituationApiSource({ fastMs = FAST_MS, slowMs = SLOW_MS, now = () => Date.now() } = {}) {
  let snapshot = {
    generatedAt: 0, sourceMode: 'unknown', simulated: false, devices: [], targets: [], alarms: [],
    flightPlans: [], risks: [], airspaces: [], handoffs: [], fusionStatus: null
  };
  let timer = null;
  let stopped = true;
  let paused = false;
  let running = false;
  let lastSlowAt = 0;
  let emit = () => {};
  let report = () => {};
  const routeVersions = new Map();

  function publish(generatedAt) {
    snapshot = { ...snapshot, generatedAt, sourceMode: sourceMode(snapshot), simulated: false };
    emit(snapshot);
  }

  async function retain(name, task, apply) {
    try { apply(await task()); }
    catch (error) { report(error, name); }
  }

  async function refreshFast(generatedAt) {
    const day = shanghaiDay(generatedAt);
    const observedFrom = generatedAt - TARGET_WINDOW_MS;
    const tasks = [
      retain('targets', async () => {
        const page = await targetApi.listAll({ seen_from: observedFrom, seen_to: generatedAt, include_merged: false });
        const recent = await targetApi.recentTracks({ observed_from: observedFrom, observed_to: generatedAt, points_per_target: 24 });
        const converted = attachBearing(toTargets(page.items), bearingOrigins(snapshot.devices));
        return attachRecentTracks(converted, recent, snapshot.targets, generatedAt, fastMs);
      }, value => { snapshot = { ...snapshot, targets: value }; }),
      retain('alarms', () => allPages(listAlarms, {
        occurred_from: day.from, occurred_to: day.to, sort: 'occurred_at', order: 'desc'
      }), value => { snapshot = { ...snapshot, alarms: toAlarms(value) }; }),
      retain('risks', () => allPages(riskApi.listRisks, {
        occurred_from: day.from, occurred_to: day.to, sort: 'occurred_at', order: 'desc'
      }), value => { snapshot = { ...snapshot, risks: toRisks(value) }; }),
      retain('handoffs', () => allPages(handoffApi.listHandoffs, {
        created_from: day.from, created_to: day.to
      }), value => { snapshot = { ...snapshot, handoffs: value }; })
    ];
    await Promise.all(tasks);
  }

  async function refreshSlow(generatedAt) {
    const day = shanghaiDay(generatedAt);
    const deviceTask = retain('devices', async () => {
      const rows = await allPages(deviceApi.list, { enabled: true });
      // 部分旧后端不会消费 enabled 查询参数；前端仍须严格隐藏已停用的历史回放设备。
      const enabledRows = rows.filter(row => row.enabled !== false);
      let events = [];
      try { events = (await deviceApi.events({ after_seq: 0, limit: 200 }))?.items || []; }
      catch (error) { report(error, 'device-events'); }
      return attachDeviceEvents(toDevices(enabledRows).filter(row => DEVICE_TYPES.has(row.typeCode)), events);
    }, value => { snapshot = { ...snapshot, devices: value }; });

    const planTask = retain('flight-plans', async () => {
      const plans = (await listAllFlightPlans({ window_from: day.from, window_to: day.to }))
        .filter(plan => ['PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED'].includes(plan.status_code));
      const ids = [...new Set(plans.map(plan => plan.route?.route_version_id).filter(Boolean))];
      await mapPool(ids.filter(id => !routeVersions.has(id)), 6, async id => {
        routeVersions.set(id, await flightApi.routeVersion(id));
      });
      return toFlightPlans(plans, Object.fromEntries(routeVersions));
    }, value => { snapshot = { ...snapshot, flightPlans: value }; });

    const airspaceTask = retain('airspaces', async () => {
      const rows = await allPages(airspaceApi.list, { valid_at: generatedAt });
      const details = await mapPool(rows, 6, row => airspaceApi.detail(row.airspace_id));
      return toAirspaces(details);
    }, value => { snapshot = { ...snapshot, airspaces: value }; });

    const fusionTask = retain('fusion-status', () => targetApi.fusionStatus(), value => {
      snapshot = { ...snapshot, fusionStatus: value };
    });
    await Promise.all([deviceTask, planTask, airspaceTask, fusionTask]);
    snapshot = { ...snapshot, targets: attachBearing(snapshot.targets, bearingOrigins(snapshot.devices)) };
  }

  async function cycle(forceSlow = false) {
    if (stopped || paused || running) return;
    running = true;
    const generatedAt = now();
    try {
      if (forceSlow || generatedAt - lastSlowAt >= slowMs) {
        await refreshSlow(generatedAt);
        lastSlowAt = generatedAt;
      }
      await refreshFast(generatedAt);
      publish(generatedAt);
    } finally {
      running = false;
      if (!stopped && !paused) timer = globalThis.setTimeout(() => cycle(false), fastMs);
    }
  }

  function clearTimer() {
    if (timer != null) globalThis.clearTimeout(timer);
    timer = null;
  }

  const api = {
    start(onSnapshot, onError) {
      clearTimer();
      emit = typeof onSnapshot === 'function' ? onSnapshot : () => {};
      report = typeof onError === 'function' ? onError : () => {};
      stopped = false;
      paused = typeof document !== 'undefined' && document.hidden;
      if (!paused) void cycle(true);
      return () => api.stop();
    },
    pause() { paused = true; clearTimer(); },
    resume() {
      if (stopped) return;
      paused = false;
      clearTimer();
      if (!running) void cycle(true);
    },
    stop() { stopped = true; paused = false; clearTimer(); },
    async refresh() { await cycle(true); },
    async loadTargetDetail(targetId) {
      if (!targetId) return null;
      const detail = await targetApi.detail(targetId);
      snapshot = { ...snapshot, targets: attachTargetSourceLinks(snapshot.targets, targetId, detail) };
      publish(now());
      return detail;
    },
    current() { return snapshot; }
  };
  return api;
}
