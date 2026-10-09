import { deviceApi } from '@/services/deviceApi.js';
import { targetApi } from '@/services/targetApi.js';
import { listAlarms } from '@/services/alarmApi.js';
import { listAllFlightPlans, flightApi } from '@/services/flightApi.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { riskApi } from '@/services/riskApi.js';
import { handoffApi } from '@/services/handoffApi.js';
import { mapPool } from '@/services/apiClient.js';
import { isRealtimeConnected, onDataChange } from '@/services/realtime.js';
import { legalityApi } from '@/services/legalityApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { applyTrackComparison } from '@/services/trackPoints.js';
import {
  attachBearing, attachDeviceEvents, attachRecentTracks, attachTargetSourceLinks,
  bearingOrigins, SITUATION_DEVICE_TYPE_ORDER, toAirspaces, toAlarms, toDevices, toFlightPlans, toRisks, toTargets
} from '@/services/situationData.js';

// 态势地图保留设备台账中已支持的感知与联动态设备，类型集合由数据装配层统一维护。
const DEVICE_TYPES = new Set(SITUATION_DEVICE_TYPE_ORDER);
const FAST_MS = 5_000;
const SLOW_MS = 60_000;
const CONNECTED_POLL_MS = 30_000;
const NUDGE_GAP_MS = 500;
const MIN_NUDGE_INTERVAL_MS = 1_000;
// 推送只重读变化的那一组：目标变化只读目标与尾迹，不再连带告警、风险、移送一起重读；
// 设备资料、计划、空域各自只重读本组。设备在线状态随每次上报变化，最多每 10 秒重读一次设备组。
const SLOW_SEGMENTS = ['devices', 'flight-plans', 'airspaces', 'fusion-status'];
const SLOW_TOPIC_SEGMENTS = {
  device: ['devices'], device_state: ['devices'], plan: ['flight-plans'], airspace: ['airspaces'], '*': SLOW_SEGMENTS
};
const DEVICE_STATE_MIN_MS = 10_000;
const FAST_SEGMENTS = ['targets', 'alarms', 'risks', 'handoffs'];
const TOPIC_SEGMENTS = {
  target: ['targets'], legality: ['targets'], alarm: ['alarms'], risk: ['risks'], punishment: ['handoffs'], '*': FAST_SEGMENTS
};
const RECENT_TRACK_WINDOW_MS = 5 * 60_000;
/* 各组数据的读取权限与后端接口一致（ZT-09）：没有权限的组不发请求、不报“刷新失败”，地图上这一类保持为空。
   飞行计划同时要读航线版本，两项权限都要有。登录后权限有变化、后端答复 403 时同样按没有权限处理，本页不再重复请求。 */
const SEGMENT_PERMISSIONS = {
  targets: ['target:read'], alarms: ['alarm:read'], risks: ['risk:read'], handoffs: ['handoff:read'],
  devices: ['devices.read'], 'device-events': ['monitoring.read'], 'flight-plans': ['flight:read', 'route:read'],
  airspaces: ['airspace:read'], 'fusion-status': ['target:read']
};

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
  let unsubscribe = null;
  const routeVersions = new Map();
  const trajectoryComparisons = new Map();
  const failedSegments = new Set();
  const deniedSegments = new Set();
  const permitted = name => !deniedSegments.has(name) && (SEGMENT_PERMISSIONS[name] || []).every(code => hasPermission(code));
  function deny(name) {
    deniedSegments.add(name);
    failedSegments.delete(name);
  }
  // 重新登录或权限刷新后，按新权限重新判断哪些组可以读。
  const accessChanged = () => { deniedSegments.clear(); };

  function withComparison(targets) {
    return targets.map(target => {
      const saved = trajectoryComparisons.get(target.targetId);
      if (!saved || saved.evaluationId !== target.legalitySummary?.evaluation_id) return target;
      return { ...target, track: applyTrackComparison(target.track, saved.data) };
    });
  }

  function publish(generatedAt) {
    if (stopped || paused) return;
    const simulated = ['devices', 'targets', 'alarms', 'flightPlans', 'risks', 'handoffs']
      .some(key => snapshot[key].some(row => row.simulated === true || row.sourceMode === 'mock' || row.source_mode === 'mock'));
    snapshot = { ...snapshot, generatedAt, sourceMode: sourceMode(snapshot), simulated,
      failedSegments: [...failedSegments], deniedSegments: Object.keys(SEGMENT_PERMISSIONS).filter(name => !permitted(name)) };
    emit(snapshot);
  }

  async function retain(name, task, apply, empty) {
    if (!permitted(name)) { failedSegments.delete(name); apply(empty); return; }
    try { apply(await task()); failedSegments.delete(name); }
    catch (error) {
      if (error?.status === 403) { deny(name); apply(empty); return; }
      failedSegments.add(name); report(error, name);
    }
  }

  async function refreshFast(generatedAt, segments = FAST_SEGMENTS) {
    const day = shanghaiDay(generatedAt);
    const observedFrom = day.from;
    const wanted = new Set(segments);
    const tasks = [
      wanted.has('targets') && retain('targets', async () => {
        const [page, recent] = await Promise.all([
          // 地图只画此刻还没到期的目标（targetIsCurrent），只取这些（ZT-20 复测 2）：当天目标多时（四百多个）
          // 每轮分页拉完要几十秒，刚收到的目标等整轮拼完已过 15 秒有效期，被页面当作过期滤掉，图上始终看不到。
          // 不认 map_visible_at 的旧后端照旧返回当天全部目标，页面照旧筛。
          targetApi.listAll({ seen_from: observedFrom, seen_to: generatedAt, include_merged: false, map_visible_at: generatedAt }),
          // 近期轨迹接口最多允许 1 小时；实时尾迹沿用 5 分钟窗口。
          targetApi.recentTracks({ observed_from: Math.max(day.from, generatedAt - RECENT_TRACK_WINDOW_MS), observed_to: generatedAt, points_per_target: 24 })
        ]);
        const converted = attachBearing(toTargets(page.items), bearingOrigins(snapshot.devices));
        return withComparison(attachRecentTracks(converted, recent, snapshot.targets));
      }, value => { snapshot = { ...snapshot, targets: value }; }, []),
      wanted.has('alarms') && retain('alarms', () => allPages(listAlarms, {
        occurred_from: day.from, occurred_to: day.to, sort: 'occurred_at', order: 'desc'
      }), value => { snapshot = { ...snapshot, alarms: toAlarms(value) }; }, []),
      wanted.has('risks') && retain('risks', () => allPages(riskApi.listRisks, {
        occurred_from: day.from, occurred_to: day.to, sort: 'occurred_at', order: 'desc'
      }), value => { snapshot = { ...snapshot, risks: toRisks(value) }; }, []),
      wanted.has('handoffs') && retain('handoffs', () => allPages(handoffApi.listHandoffs, {
        created_from: day.from, created_to: day.to
      }), value => { snapshot = { ...snapshot, handoffs: value }; }, [])
    ];
    await Promise.all(tasks.filter(Boolean));
  }

  async function refreshSlow(generatedAt, segments = SLOW_SEGMENTS) {
    const day = shanghaiDay(generatedAt);
    const wanted = new Set(segments);
    if (wanted.has('devices')) lastDevicesAt = generatedAt;
    const deviceTask = wanted.has('devices') && retain('devices', async () => {
      const rows = await allPages(deviceApi.list, { enabled: true });
      // 部分旧后端不会消费 enabled 查询参数；前端仍须严格隐藏已停用的历史回放设备。
      const enabledRows = rows.filter(row => row.enabled !== false);
      let events = [];
      if (permitted('device-events')) {
        try {
          events = (await deviceApi.events({ after_seq: 0, limit: 200, latest: true }))?.items || [];
          failedSegments.delete('device-events');
        } catch (error) {
          if (error?.status === 403) deny('device-events');
          else { failedSegments.add('device-events'); report(error, 'device-events'); }
        }
      } else failedSegments.delete('device-events');
      return attachDeviceEvents(toDevices(enabledRows, { includeUnlocated: true }).filter(row => DEVICE_TYPES.has(row.typeCode)), events);
    }, value => { snapshot = { ...snapshot, devices: value }; }, []);

    const planTask = wanted.has('flight-plans') && retain('flight-plans', async () => {
      const plans = (await listAllFlightPlans({ window_from: day.from, window_to: day.to }))
        .filter(plan => ['PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED'].includes(plan.status_code));
      const ids = [...new Set(plans.map(plan => plan.route?.route_version_id).filter(Boolean))];
      await mapPool(ids.filter(id => !routeVersions.has(id)), 6, async id => {
        routeVersions.set(id, await flightApi.routeVersion(id));
      });
      return toFlightPlans(plans, Object.fromEntries(routeVersions));
    }, value => { snapshot = { ...snapshot, flightPlans: value }; }, []);

    const airspaceTask = wanted.has('airspaces') && retain('airspaces', async () => {
      const rows = await allPages(airspaceApi.list, { valid_at: generatedAt });
      const details = await mapPool(rows, 6, row => airspaceApi.detail(row.airspace_id));
      return toAirspaces(details);
    }, value => { snapshot = { ...snapshot, airspaces: value }; }, []);

    const fusionTask = wanted.has('fusion-status') && retain('fusion-status', () => targetApi.fusionStatus(), value => {
      snapshot = { ...snapshot, fusionStatus: value };
    }, null);
    await Promise.all([deviceTask, planTask, airspaceTask, fusionTask].filter(Boolean));
    snapshot = { ...snapshot, targets: attachBearing(snapshot.targets, bearingOrigins(snapshot.devices)) };
  }

  /* 后端推送数据变化时立即重读变化的那一组；设备、计划、空域变化顺带刷新资料组。进行中的一轮结束后再补一次。 */
  let pendingNudge = false;
  let pendingSegments = new Set();
  let pendingSlowSegments = new Set();
  let lastCycleAt = 0;
  let lastDevicesAt = 0;
  function nudge(topics) {
    topics.forEach(topic => {
      if (topic === 'device_state' && now() - lastDevicesAt < DEVICE_STATE_MIN_MS) return;
      (SLOW_TOPIC_SEGMENTS[topic] || []).forEach(segment => pendingSlowSegments.add(segment));
    });
    topics.forEach(topic => (TOPIC_SEGMENTS[topic] || []).forEach(segment => pendingSegments.add(segment)));
    if (!pendingSlowSegments.size && !pendingSegments.size) return;
    if (stopped || paused) return;
    if (running) { pendingNudge = true; return; }
    clearTimer();
    const wait = lastCycleAt + MIN_NUDGE_INTERVAL_MS - Date.now();
    if (wait > 0) timer = globalThis.setTimeout(() => cycle(false, true), wait);
    else void cycle(false, true);
  }

  async function cycle(forceSlow = false, nudged = false) {
    if (stopped || paused || running) return;
    running = true;
    pendingNudge = false;
    // 定时兜底的一轮读全部；推送触发的一轮只读变化的分组。
    const segments = nudged ? [...pendingSegments] : FAST_SEGMENTS;
    pendingSegments = new Set();
    lastCycleAt = Date.now();
    const generatedAt = now();
    try {
      // 实时目标与风险优先发起；资料请求并行，不再串在实时数据之前。
      const fast = refreshFast(generatedAt, segments).then(() => publish(generatedAt));
      const fullSlow = forceSlow || generatedAt - lastSlowAt >= slowMs;
      const slowSegments = fullSlow ? SLOW_SEGMENTS : [...pendingSlowSegments];
      pendingSlowSegments = new Set();
      const needsSlow = slowSegments.length > 0;
      const slow = needsSlow
        ? refreshSlow(generatedAt, slowSegments).then(() => { if (fullSlow) lastSlowAt = generatedAt; })
        : Promise.resolve();
      await Promise.all([fast, slow]);
      if (needsSlow) {
        // 两组完成顺序不固定，只报方位的目标须按最终设备位置再关联一次。
        snapshot = { ...snapshot, targets: attachBearing(snapshot.targets, bearingOrigins(snapshot.devices)) };
        publish(generatedAt);
      }
    } finally {
      running = false;
      if (!stopped && !paused) {
        const delay = pendingNudge
          ? NUDGE_GAP_MS
          : (typeof isRealtimeConnected === 'function' && isRealtimeConnected()
            ? Math.max(fastMs, CONNECTED_POLL_MS)
            : fastMs);
        timer = globalThis.setTimeout(() => cycle(false, pendingNudge), delay);
      }
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
      unsubscribe?.();
      globalThis.addEventListener?.('auth-access-change', accessChanged);
      unsubscribe = onDataChange([...new Set([...Object.keys(TOPIC_SEGMENTS), ...Object.keys(SLOW_TOPIC_SEGMENTS)])], topics => nudge(topics));
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
    stop() {
      stopped = true; paused = false; clearTimer(); unsubscribe?.(); unsubscribe = null;
      globalThis.removeEventListener?.('auth-access-change', accessChanged);
    },
    async refresh() { await cycle(true); },
    async loadTargetDetail(targetId) {
      if (!targetId) return null;
      const detail = await targetApi.detail(targetId);
      snapshot = { ...snapshot, targets: attachTargetSourceLinks(snapshot.targets, targetId, detail) };
      publish(now());
      const evaluationId = detail.legality_summary?.evaluation_id;
      if (evaluationId && detail.object_type_code === 'UAV') {
        try {
          const saved = trajectoryComparisons.get(targetId);
          const data = saved?.evaluationId === evaluationId ? saved.data : await legalityApi.trajectory(evaluationId);
          if (stopped) return detail;
          if (data.target_id !== targetId) throw new Error('轨迹比对结果与当前目标不一致');
          trajectoryComparisons.set(targetId, { evaluationId, data });
          snapshot = { ...snapshot, targets: withComparison(snapshot.targets) };
          publish(now());
        } catch (error) {
          if (!stopped) report(error, '轨迹分段比对（未比对的观测保持未知）');
        }
      }
      return detail;
    },
    current() { return snapshot; }
  };
  return api;
}
