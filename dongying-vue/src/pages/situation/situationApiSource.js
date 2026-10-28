import { deviceApi } from '@/services/deviceApi.js';
import { targetApi } from '@/services/targetApi.js';
import { listAlarms } from '@/services/alarmApi.js';
import { listAllFlightPlans, flightApi } from '@/services/flightApi.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { riskApi } from '@/services/riskApi.js';
import { handoffApi } from '@/services/handoffApi.js';
import { mapPool } from '@/services/apiClient.js';
import { onDataChange } from '@/services/realtime.js';
import { legalityApi } from '@/services/legalityApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { authUser } from '@/services/auth.js';
import { applyTrackComparison } from '@/services/trackPoints.js';
import { serverNow } from '@/services/serverClock.js';
import { attachEoCameraStates } from './eoCameraState.js';
import {
  attachBearing, attachDeviceEvents, attachRecentTracks, attachTargetSourceLinks, extendRecentTracks,
  mergeTrackHistory, thinTrackHistory, toTrack, bearingOrigins, planIsCurrent, toAirspaces, toAlarms, toDevices, toFlightPlans, toRisks, toTargets
} from '@/services/situationData.js';

// 设备范围由后端统一筛选，未知类型仍留在清单中。

const FAST_MS = 5_000;
const SLOW_MS = 60_000;
const MIN_NUDGE_INTERVAL_MS = 1_000;
// 推送只重读变化的那一组：目标变化只读目标与尾迹，不再连带告警、风险、移送一起重读；
// 设备资料、计划、空域各自只重读本组。设备在线状态随每次上报变化，最多每 2 秒重读一次设备组。
const SLOW_SEGMENTS = ['devices', 'flight-plans', 'airspaces', 'fusion-status'];
const SLOW_TOPIC_SEGMENTS = {
  device: ['devices'], device_state: ['devices'], plan: ['flight-plans'], airspace: ['airspaces'],
  fusion: ['fusion-status'], 'time-boundary': ['flight-plans', 'airspaces'], '*': SLOW_SEGMENTS
};
const DEVICE_STATE_MIN_MS = 2_000;
const FAST_SEGMENTS = ['targets', 'alarms', 'risks', 'handoffs', 'predictions', 'eo-status'];
const TOPIC_SEGMENTS = {
  tracking: ['eo-status'], device_state: ['eo-status'], device: ['eo-status'],
  target: ['targets', 'predictions'], prediction: ['predictions', 'alarms'], legality: ['targets'], alarm: ['alarms', 'predictions'], disposal: ['alarms'], risk: ['risks'], punishment: ['handoffs'],
  'time-boundary': ['risks'], '*': FAST_SEGMENTS
};
const RECENT_TRACK_WINDOW_MS = 5 * 60_000;
/* 尾迹不随每次位置推送整包重下：最多 5 秒重读一次，只要图上目标、只要坐标（slim）；
   两次重读之间用目标最新位置把尾迹往前接上。新目标出现时立即补读。 */
const TRACK_REFRESH_MS = 5_000;
const RISK_PRESENCE_REFRESH_MS = 5_000;
// 与后端 target_ids 上限一致；图上目标更多时不按目标限定，仍只要坐标。
const MAX_TRACK_TARGET_IDS = 100;
const MAX_ROUTE_VERSION_BATCH = 100;
// 目标首次出现时读回整条轨迹（从第一次被发现起），同时最多读这么多个目标，不和其他数据抢请求。
const HISTORY_LOAD_CONCURRENCY = 2;
/* 各组数据的读取权限与后端接口一致（ZT-09）：没有权限的组不发请求、不报“刷新失败”，地图上这一类保持为空。
   飞行任务同时要读航线版本，两项权限都要有。登录后权限有变化、后端答复 403 时同样按没有权限处理，本页不再重复请求。 */
const SEGMENT_PERMISSIONS = {
  predictions: ['target:read'], targets: ['target:read'], 'target-sources': ['target:read'], alarms: ['alarm:read'], risks: ['risk:read', 'flight:read', 'route:read'], handoffs: ['handoff:read'],
  devices: ['devices.read'], 'eo-status': ['devices.read'], 'device-events': ['monitoring.read'], 'flight-plans': ['flight:read', 'route:read'],
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
  visit(snapshot.flightPlans); visit(snapshot.risks); visit(snapshot.handoffs); visit(snapshot.predictions);
  if (modes.size > 1) return 'mixed';
  return modes.values().next().value || 'unknown';
}

/**
 * 融合感知页真实数据源。SSE 分段独立刷新，每段至多一个在途请求；页面隐藏时完全停表。
 * 任一分段失败只保留该分段最后一次真实结果，不会切回演示数据。
 */
export function createSituationApiSource({ fastMs = FAST_MS, slowMs = SLOW_MS, now = serverNow } = {}) {
  let snapshot = {
    generatedAt: 0, sourceMode: 'unknown', simulated: false, devices: [], targets: [], alarms: [],
    flightPlans: [], risks: [], airspaces: [], handoffs: [], predictions: [], eoReports: [], fusionStatus: null
  };
  let stopped = true;
  let selectedSourceTarget = null;
  let sourceSelectionGeneration = 0;
  let predictionAccessGeneration = 0;
  let paused = false;
  let readGeneration = 0;
  let boundaryTimer = null;
  let eoTimer = null;
  let boundaryDay = shanghaiDay(now()).from;
  let emit = () => {};
  let report = () => {};
  let unsubscribe = null;
  let lastTracksAt = 0;
  let lastRisksAt = 0;
  let slimTracks = true;
  let batchRouteVersions = true;
  let batchAirspaces = true;
  const routeVersions = new Map();
  // 每个目标的整条轨迹（targetId → { trackId, points }）；points 为空表示还在读。之后每轮尾迹接到它末尾。
  const trackHistories = new Map();
  const historyQueue = [];
  let historyLoads = 0;
  const trajectoryComparisons = new Map();
  const failedSegments = new Set();
  const deniedSegments = new Set();
  // 设备事件是后台专属接口；前台角色遗留 monitoring.read 也不具备后台身份。
  const permitted = name => !deniedSegments.has(name)
    && (name !== 'device-events' || authUser.value?.user_type === 'BACKEND')
    && (SEGMENT_PERMISSIONS[name] || []).every(code => hasPermission(code));
  function deny(name) {
    deniedSegments.add(name);
    failedSegments.delete(name);
    if (name === 'targets' || name === 'predictions') {
      predictionAccessGeneration += 1;
      deniedSegments.add('predictions'); failedSegments.delete('predictions');
      snapshot = { ...snapshot, predictions: [] };
    }
  }
  // 权限或账号变化时先清除旧坐标/标识，在途响应不能写回旧范围的数据。
  const accessChanged = () => {
    predictionAccessGeneration += 1;
    readGeneration += 1;
    deniedSegments.clear(); failedSegments.delete('predictions');
    trackHistories.clear(); historyQueue.length = 0;
    snapshot = { ...snapshot, predictions: [], eoReports: [] };
    publish(now()); nudge(['prediction']);
  };

  /* 尾迹只有最近 24 点；读过整条轨迹的目标把尾迹接到整条轨迹后面，并记下接好的结果供下一轮再接。
     已不在图上的目标（以目标组读回的列表为准）不再保留，重新出现时重读。 */
  function withHistory(targets, { prune = true } = {}) {
    const present = new Set(targets.map(target => target.targetId));
    if (prune) for (const targetId of trackHistories.keys()) if (!present.has(targetId)) trackHistories.delete(targetId);
    return targets.map(target => {
      const history = trackHistories.get(target.targetId);
      const last = target.track?.[target.track.length - 1];
      if (!history?.points || (last?.track_id && last.track_id !== history.trackId)) return target;
      const track = thinTrackHistory(mergeTrackHistory(history.points, (target.track || []).filter(point => point.track_id === history.trackId)));
      history.points = track;
      return { ...target, track, tailSpanMs: null };
    });
  }

  // 后台尾迹带回的融合轨迹编号：没读过整条的（或换了一条融合轨迹的）排队读一次。
  function requestHistories(recent) {
    for (const item of recent?.items || []) {
      if (!item.target_id || !item.track_id) continue;
      const known = trackHistories.get(item.target_id);
      if (known?.trackId === item.track_id) continue;
      trackHistories.set(item.target_id, { trackId: item.track_id, points: null });
      historyQueue.push(item.target_id);
    }
    pumpHistories();
  }

  function pumpHistories() {
    while (historyLoads < HISTORY_LOAD_CONCURRENCY && historyQueue.length) {
      const targetId = historyQueue.shift();
      const entry = trackHistories.get(targetId);
      if (!entry || entry.points) continue;
      const generation = readGeneration;
      historyLoads += 1;
      Promise.resolve().then(() => targetApi.pointsAll(entry.trackId, { size: 100 }))
        .then(page => {
          if (trackHistories.get(targetId) !== entry) return;
          // 读的途中离开页面或换了账号：丢掉这次结果，回来后重读。
          if (stopped || generation !== readGeneration) { trackHistories.delete(targetId); return; }
          entry.points = toTrack(page.items || []);
          // 这时目标组可能还没发布本轮目标，不按它清理；下一轮读回目标时照常接上。
          snapshot = { ...snapshot, targets: withComparison(withHistory(snapshot.targets, { prune: false })) };
          publish(now());
        })
        // 读不到整条轨迹时照旧只画尾迹，这条轨迹不再反复重读；目标离开地图后再出现时重试。
        .catch(() => { entry.failed = true; })
        .finally(() => { historyLoads -= 1; pumpHistories(); });
    }
  }

  function withComparison(targets) {
    return targets.map(target => {
      const saved = trajectoryComparisons.get(target.targetId);
      if (!saved || saved.evaluationId !== target.legalitySummary?.evaluation_id) return target;
      return { ...target, track: applyTrackComparison(target.track, saved.data) };
    });
  }

  function publish(generatedAt) {
    if (stopped || paused) return;
    if (!permitted('predictions')) snapshot = { ...snapshot, predictions: [] };
    if (!permitted('eo-status')) snapshot = { ...snapshot, eoReports: [] };
    snapshot = { ...snapshot, devices: attachEoCameraStates(snapshot.devices, snapshot.eoReports, now()) };
    const simulated = ['devices', 'targets', 'alarms', 'flightPlans', 'risks', 'handoffs', 'predictions']
      .some(key => snapshot[key].some(row => row.simulated === true || row.sourceMode === 'mock' || row.source_mode === 'mock'));
    snapshot = { ...snapshot, generatedAt: Math.max(snapshot.generatedAt, generatedAt), sourceMode: sourceMode(snapshot), simulated,
      targetRefreshStartedAt: lanes.get('targets').running ? lanes.get('targets').startedAt : 0,
      failedSegments: [...failedSegments], deniedSegments: Object.keys(SEGMENT_PERMISSIONS).filter(name => !permitted(name)) };
    emit(snapshot);
  }

  async function retain(name, task, apply, empty) {
    if (!permitted(name)) { failedSegments.delete(name); apply(empty); return; }
    const generation = readGeneration, predictionGeneration = predictionAccessGeneration;
    const current = () => !stopped && !paused && generation === readGeneration
      && (name !== 'predictions' || predictionGeneration === predictionAccessGeneration);
    try {
      const result = await task();
      if (!current()) return;
      if (!permitted(name)) { apply(empty); return; }
      apply(result); failedSegments.delete(name);
      if (name === 'targets') snapshot = { ...snapshot, targetUpdatedAt: now() };
    }
    catch (error) {
      if (!current()) return;
      if (error?.status === 403) { deny(name); apply(empty); return; }
      failedSegments.add(name); report(error, name);
      if (name === 'eo-status') apply(empty);
    }
  }

  async function loadRecentTracks(targets, generatedAt, dayFrom) {
    const ids = [...new Set(targets.map(target => target.targetId).filter(Boolean))];
    if (!ids.length) return { items: [] };
    // 近期轨迹接口最多允许 1 小时；实时尾迹沿用 5 分钟窗口。
    const base = { observed_from: Math.max(dayFrom, generatedAt - RECENT_TRACK_WINDOW_MS), observed_to: generatedAt, points_per_target: 24 };
    if (!slimTracks) return targetApi.recentTracks(base);
    try {
      return await targetApi.recentTracks({ ...base, slim: true, ...(ids.length <= MAX_TRACK_TARGET_IDS ? { target_ids: ids.join(',') } : {}) });
    } catch (error) {
      // 不认 target_ids/slim 的旧后端答 400：本页改回原来的整包读取。
      if (error?.status !== 400) throw error;
      slimTracks = false;
      return targetApi.recentTracks(base);
    }
  }

  // 当天计划引用的航线中心线一次取回（每 100 条一批），不再每条计划单独请求；已取过的不再取。
  async function loadRouteVersions(ids) {
    const single = list => mapPool(list, 6, async id => { routeVersions.set(id, await flightApi.routeVersion(id)); });
    if (!ids.length) return;
    if (!batchRouteVersions) { await single(ids); return; }
    for (let index = 0; index < ids.length; index += MAX_ROUTE_VERSION_BATCH) {
      const chunk = ids.slice(index, index + MAX_ROUTE_VERSION_BATCH);
      try {
        const page = await flightApi.routeVersionBatch(chunk);
        (page?.items || []).forEach(version => routeVersions.set(version.route_version_id, version));
      } catch (error) {
        if (error?.status === 403) throw error;
        // 没有批量接口的旧后端（400/404/405）：本页改回逐条读取；其他错误只本轮逐条补读。
        if ([400, 404, 405].includes(error?.status)) batchRouteVersions = false;
        await single(ids.slice(index));
        return;
      }
    }
  }

  // 空域连同当前版本一次取回（列表带 include=current_version），不再每片空域单独请求详情。
  async function loadAirspaceDetails(generatedAt) {
    if (batchAirspaces) {
      try {
        return await allPages(airspaceApi.list, { valid_at: generatedAt, include: 'current_version' });
      } catch (error) {
        if (error?.status === 403) throw error;
        // 不认 include 的旧后端答 400：本页改回逐片读取；其他错误（如某片空域版本重叠）只本轮逐片读取。
        if (error?.status === 400) batchAirspaces = false;
      }
    }
    const rows = await allPages(airspaceApi.list, { valid_at: generatedAt });
    return mapPool(rows, 6, row => airspaceApi.detail(row.airspace_id));
  }

  async function refreshFast(generatedAt, segments = FAST_SEGMENTS) {
    const generation = readGeneration;
    const day = shanghaiDay(generatedAt);
    const observedFrom = day.from;
    const wanted = new Set(segments);
    if (wanted.has('risks')) lastRisksAt = generatedAt;
    // 短时预测和统一风险读回即发布，不能等待其他历史分页耗尽预测有效期。
    const tasks = [
      wanted.has('eo-status') && retain('eo-status', () => allPages(deviceApi.eoSituation),
        value => { snapshot = { ...snapshot, eoReports: value }; }, []),
      wanted.has('predictions') && retain('predictions', () => allPages(targetApi.currentPredictions),
        value => { snapshot = { ...snapshot, predictions: value }; }, []),
      wanted.has('targets') && retain('targets', async () => {
        // 地图只画此刻还没到期的目标（targetIsCurrent），只取这些（ZT-20 复测 2）：当天目标多时（四百多个）
        // 每轮分页拉完要几十秒，刚收到的目标等整轮拼完已过 15 秒有效期，被页面当作过期滤掉，图上始终看不到。
        // 不认 map_visible_at 的旧后端照旧返回当天全部目标，页面照旧筛。
        // last_seen_at can advance while this request is in flight. A request-start upper bound
        // would drop the most actively reporting targets; keep the day window and let map expiry
        // plus targetIsCurrent validate the actual observation against the current platform time.
        const page = await targetApi.listAll({ seen_from: observedFrom, seen_to: day.to, include_merged: false, map_visible_at: generatedAt });
        if (stopped || paused || generation !== readGeneration) return [];
        const converted = attachBearing(toTargets(page.items), bearingOrigins(snapshot.devices));
        const known = new Set(snapshot.targets.map(target => target.targetId));
        const due = generatedAt - lastTracksAt >= TRACK_REFRESH_MS || generatedAt < lastTracksAt
          || converted.some(target => !known.has(target.targetId));
        const extended = extendRecentTracks(converted, snapshot.targets);
        if (!due) return withComparison(withHistory(extended));
        const recent = await loadRecentTracks(converted, generatedAt, day.from);
        if (generation === readGeneration) { lastTracksAt = generatedAt; requestHistories(recent); }
        // 这次没带回某个目标的尾迹时沿用本机接上的尾迹，不让尾迹一闪而空。
        return withComparison(withHistory(attachRecentTracks(extended, recent, snapshot.targets)));
      }, value => { snapshot = { ...snapshot, targets: value }; }, [])
        // 目标一读回就先发布（CDX-P01）：不等同一轮的告警、风险、移送分页读完。当天记录多时那几组要读很久，
        // 等它们读完，刚收到的目标已过了地图有效期，被页面当成过期滤掉。整轮读完后照旧再发布一次。
        .then(async () => {
          if (stopped || paused || generation !== readGeneration) return;
          publish(generatedAt);
          if (selectedSourceTarget) void requestSegment('target-sources');
        }),
      wanted.has('alarms') && retain('alarms', () => allPages(listAlarms, {
        view: 'risk_case', risk_stage: 'PREDICTED,ENTERED,OBSERVED', attention_group: 'CURRENT,AWAITING_CONFIRMATION', sort: 'occurred_at', order: 'desc'
      }), value => { snapshot = { ...snapshot, alarms: toAlarms(value) }; }, []),
      // 当前投影由后端按实际关联聚合，不能把当天全部历史或跨日仍持续的风险按发生日期截断。
      wanted.has('risks') && retain('risks', async () => {
        const planIds = [...new Set(snapshot.flightPlans.filter(plan => planIsCurrent(plan, generatedAt)).map(plan => plan.planId))];
        const pages = await mapPool(planIds, 4, plan_id => allPages(riskApi.listCurrentRisks, { plan_id }));
        return pages.flat();
      }, value => {
        snapshot = { ...snapshot, risks: toRisks(value.map(item => item.risk)) };
      }, []),
      wanted.has('handoffs') && retain('handoffs', () => allPages(handoffApi.listHandoffs, {
        created_from: day.from, created_to: day.to
      }), value => { snapshot = { ...snapshot, handoffs: value }; }, [])
    ];
    await Promise.all(tasks.filter(Boolean));
  }

  async function refreshSelectedSources() {
    const targetId = selectedSourceTarget;
    const generation = sourceSelectionGeneration, accessGeneration = readGeneration;
    const current = () => !stopped && !paused && generation === sourceSelectionGeneration
      && accessGeneration === readGeneration && targetId === selectedSourceTarget && permitted('target-sources');
    if (!targetId || !current()) { failedSegments.delete('target-sources'); return; }
    try {
      const detail = await targetApi.detail(targetId);
      if (!current()) return;
      snapshot = { ...snapshot, targets: attachTargetSourceLinks(snapshot.targets, targetId, detail) };
      failedSegments.delete('target-sources');
    } catch (error) {
      if (!current()) return;
      snapshot = { ...snapshot, targets: snapshot.targets.map(target => target.targetId !== targetId ? target : {
        ...target, sourceLinks: (target.sourceLinks || []).map(link => ({ ...link, fusion_status: 'UNKNOWN',
          contribution_attributes: [], fusion_reason: '融合来源读取失败或无权查看', observation_at: null }))
      }) };
      failedSegments.add('target-sources'); report(error, 'target-sources');
    }
  }

  async function refreshSlow(generatedAt, segments = SLOW_SEGMENTS) {
    const generation = readGeneration;
    const current = () => !stopped && !paused && generation === readGeneration;
    const day = shanghaiDay(generatedAt);
    const wanted = new Set(segments);
    const deviceTask = wanted.has('devices') && retain('devices', async () => {
      const rows = await allPages(deviceApi.list, { enabled: true, statistics_scope: true, sort: 'device_no_asc' });
      // 部分旧后端不会消费 enabled 查询参数；只有明确启用的设备才进入感知列表。
      if (!current()) return [];
      const enabledRows = rows.filter(row => row.enabled === true);
      let events = [];
      if (permitted('device-events')) {
        try {
          events = (await deviceApi.events({ after_seq: 0, limit: 200, latest: true }))?.items || [];
          if (current()) failedSegments.delete('device-events');
        } catch (error) {
          if (!current()) return [];
          if (error?.status === 403) deny('device-events');
          else { failedSegments.add('device-events'); report(error, 'device-events'); }
        }
      } else if (current()) failedSegments.delete('device-events');
      return attachDeviceEvents(toDevices(enabledRows, { includeUnlocated: true }), events);
    }, value => { snapshot = { ...snapshot, devices: value }; }, []);

    const planTask = wanted.has('flight-plans') && retain('flight-plans', async () => {
      const plans = (await listAllFlightPlans({ window_from: day.from, window_to: day.to, exclude_retired_simulation: true }))
        .filter(plan => ['PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED'].includes(plan.status_code));
      const ids = [...new Set(plans.map(plan => plan.route?.route_version_id).filter(Boolean))];
      await loadRouteVersions(ids.filter(id => !routeVersions.has(id)));
      return toFlightPlans(plans, Object.fromEntries(routeVersions));
    }, value => { snapshot = { ...snapshot, flightPlans: value }; }, []);

    const airspaceTask = wanted.has('airspaces') && retain('airspaces', async () => {
      return toAirspaces(await loadAirspaceDetails(generatedAt));
    }, value => { snapshot = { ...snapshot, airspaces: value }; }, []);

    const fusionTask = wanted.has('fusion-status') && retain('fusion-status', () => targetApi.fusionStatus(), value => {
      snapshot = { ...snapshot, fusionStatus: value };
    }, null);
    await Promise.all([deviceTask, planTask, airspaceTask, fusionTask].filter(Boolean));
    if (current()) snapshot = { ...snapshot, targets: attachBearing(snapshot.targets, bearingOrigins(snapshot.devices)) };
  }

  // 每个分段独立串行；慢告警/历史分页不阻塞下一次目标与预测。
  // 同一分段在途期间的变化合并成一次，失败只对该分段退避。
  const lanes = new Map([...FAST_SEGMENTS, ...SLOW_SEGMENTS, 'target-sources'].map(name => [name,
    { running: false, pending: false, timer: null, lastAt: 0, retryDelay: 0, retryAt: 0, startedAt: 0, pendingPromise: null, activePromise: null, resolvePending: null }]));
  function schedule(name) {
    const lane = lanes.get(name);
    if (!lane || stopped || paused || lane.running || lane.timer || !lane.pending) return;
    const interval = name === 'devices' ? DEVICE_STATE_MIN_MS : MIN_NUDGE_INTERVAL_MS;
    const wait = Math.max(0, lane.lastAt + interval - Date.now(), lane.retryAt - Date.now());
    lane.timer = globalThis.setTimeout(() => { lane.timer = null; void readSegment(name); }, wait);
  }
  function requestSegment(name, immediate = false) {
    const lane = lanes.get(name);
    if (!lane || stopped || paused) return Promise.resolve();
    lane.pending = true;
    if (immediate) { lane.lastAt = 0; lane.retryAt = 0; }
    if (!lane.pendingPromise) lane.pendingPromise = new Promise(resolve => { lane.resolvePending = resolve; });
    schedule(name);
    return lane.pendingPromise;
  }
  async function readSegment(name) {
    const lane = lanes.get(name);
    if (stopped || paused || lane.running || !lane.pending) return;
    lane.running = true; lane.pending = false; lane.lastAt = Date.now(); lane.startedAt = now();
    if (name === 'targets') publish(now());
    const resolve = lane.resolvePending;
    lane.activePromise = lane.pendingPromise;
    lane.pendingPromise = null; lane.resolvePending = null;
    const generation = readGeneration, generatedAt = now();
    try {
      if (name === 'target-sources') await refreshSelectedSources();
      else if (FAST_SEGMENTS.includes(name)) await refreshFast(generatedAt, [name]);
      else await refreshSlow(generatedAt, [name]);
      if (generation !== readGeneration || stopped || paused) return;
      publish(generatedAt);
      if (name === 'flight-plans' && !failedSegments.has(name)) void requestSegment('risks');
      if (name === 'targets' && snapshot.risks.length && (generatedAt - lastRisksAt >= RISK_PRESENCE_REFRESH_MS || generatedAt < lastRisksAt)) {
        void requestSegment('risks');
      }
    } finally {
      lane.running = false; lane.activePromise = null;
      if (generation === readGeneration && failedSegments.has(name)) {
        lane.pending = true;
        lane.retryDelay = Math.min(lane.retryDelay ? lane.retryDelay * 2 : fastMs, 30_000);
        lane.retryAt = Date.now() + lane.retryDelay;
      } else { lane.retryDelay = 0; lane.retryAt = 0; }
      resolve?.();
      if (name === 'targets' && generation === readGeneration) publish(now());
      schedule(name);
    }
  }
  function nudge(topics) {
    const names = new Set();
    topics.forEach(topic => {
      (SLOW_TOPIC_SEGMENTS[topic] || []).forEach(name => names.add(name));
      (TOPIC_SEGMENTS[topic] || []).forEach(name => names.add(name));
    });
    names.forEach(name => { void requestSegment(name); });
  }
  async function cycle(forceSlow = false) {
    if (stopped || paused) return;
    const generation = readGeneration;
    const names = [...FAST_SEGMENTS.filter(name => name !== 'risks'), ...(forceSlow ? SLOW_SEGMENTS : [])];
    await Promise.all(names.map(name => requestSegment(name, true)));
    if (!stopped && !paused && generation === readGeneration) {
      if (!forceSlow) await requestSegment('risks', true);
      else await (lanes.get('risks').pendingPromise || lanes.get('risks').activePromise);
    }
  }

  // 有效空域查询只返回当前版本；未来生效、任务起止和跨日可能没有写库。
  // 只补读这些随时间变化的投影，不再定时扫描目标、设备、告警和移送。
  function armBoundary() {
    globalThis.clearTimeout(boundaryTimer);
    if (stopped || paused) return;
    const at = now();
    const deadlines = snapshot.flightPlans.flatMap(plan => [plan.startAt, plan.endAt]).filter(value => value > at);
    const wait = Math.max(50, Math.min(slowMs, shanghaiDay(at).to - at + 50, ...deadlines.map(value => value - at + 50)));
    boundaryTimer = globalThis.setTimeout(() => {
      const day = shanghaiDay(now()).from;
      nudge(day !== boundaryDay ? ['*'] : ['time-boundary']);
      boundaryDay = day; armBoundary();
    }, wait);
  }

  function armEoTelemetry() {
    globalThis.clearTimeout(eoTimer);
    if (stopped || paused) return;
    eoTimer = globalThis.setTimeout(() => {
      if (permitted('eo-status')) void requestSegment('eo-status');
      armEoTelemetry();
    }, DEVICE_STATE_MIN_MS);
  }

  function clearTimer() {
    globalThis.clearTimeout(eoTimer);
    for (const lane of lanes.values()) {
      globalThis.clearTimeout(lane.timer); lane.timer = null; lane.pending = false;
      lane.retryDelay = 0; lane.retryAt = 0;
      lane.resolvePending?.(); lane.resolvePending = null; lane.pendingPromise = null;
    }
  }

  const api = {
    start(onSnapshot, onError) {
      readGeneration += 1; clearTimer();
      snapshot = { ...snapshot, startedAt: now(), targetUpdatedAt: 0 };
      emit = typeof onSnapshot === 'function' ? onSnapshot : () => {};
      report = typeof onError === 'function' ? onError : () => {};
      stopped = false;
      unsubscribe?.();
      globalThis.addEventListener?.('auth-access-change', accessChanged);
      unsubscribe = onDataChange([...new Set([...Object.keys(TOPIC_SEGMENTS), ...Object.keys(SLOW_TOPIC_SEGMENTS)])], topics => nudge(topics));
      paused = typeof document !== 'undefined' && document.hidden;
      if (!paused) { void cycle(true); armBoundary(); armEoTelemetry(); }
      return () => api.stop();
    },
    pause() { paused = true; readGeneration += 1; clearTimer(); globalThis.clearTimeout(boundaryTimer); },
    resume() {
      if (stopped) return;
      paused = false;
      clearTimer();
      void cycle(true);
      armBoundary();
      armEoTelemetry();
    },
    setSourceTarget(targetId) {
      if (selectedSourceTarget !== (targetId || null)) { sourceSelectionGeneration += 1; failedSegments.delete('target-sources'); }
      selectedSourceTarget = targetId || null;
    },
    stop() {
      selectedSourceTarget = null; sourceSelectionGeneration += 1; predictionAccessGeneration += 1;
      stopped = true; paused = false; readGeneration += 1; clearTimer(); globalThis.clearTimeout(boundaryTimer); unsubscribe?.(); unsubscribe = null;
      globalThis.removeEventListener?.('auth-access-change', accessChanged);
    },
    async refresh() { await cycle(true); },
    async loadTargetDetail(targetId) {
      if (!targetId) return null;
      const generation = sourceSelectionGeneration;
      let detail;
      try { detail = await targetApi.detail(targetId); }
      catch (error) {
        if (!stopped && targetId === selectedSourceTarget && generation === sourceSelectionGeneration) {
          snapshot = { ...snapshot, targets: snapshot.targets.map(target => target.targetId !== targetId ? target : {
            ...target, sourceLinks: (target.sourceLinks || []).map(link => ({ ...link, fusion_status: 'UNKNOWN',
              contribution_attributes: [], fusion_reason: '融合来源读取失败或无权查看', observation_at: null }))
          }) };
          publish(now());
        }
        throw error;
      }
      if (stopped || targetId !== selectedSourceTarget || generation !== sourceSelectionGeneration) return detail;
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
    async loadTargetPrediction(targetId) {
      if (!targetId || !permitted('predictions')) return null;
      const generation = sourceSelectionGeneration;
      const accessGeneration = predictionAccessGeneration;
      let prediction;
      try {
        prediction = await targetApi.prediction(targetId);
        if (prediction?.target_id !== targetId) throw new Error('预测结果与当前目标不一致，请重新读取');
      } catch (error) {
        if (!stopped && targetId === selectedSourceTarget && generation === sourceSelectionGeneration
          && accessGeneration === predictionAccessGeneration && permitted('predictions')) {
          predictionAccessGeneration += 1;
          failedSegments.add('predictions');
          // 单个目标可能已移出数据范围；清空旧范围缓存，再从当前权限的分页接口重新读取。
          if (error?.status === 403) snapshot = { ...snapshot, predictions: [] };
          publish(now()); nudge(['prediction']);
        }
        throw error;
      }
      if (stopped || targetId !== selectedSourceTarget || generation !== sourceSelectionGeneration
        || accessGeneration !== predictionAccessGeneration || !permitted('predictions')) return null;
      const rows = snapshot.predictions.filter(row => row.target_id !== targetId);
      snapshot = { ...snapshot, predictions: [...rows, prediction] };
      publish(now());
      return prediction;
    },
    current() { return snapshot; }
  };
  return api;
}
