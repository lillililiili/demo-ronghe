#!/usr/bin/env node
/* 融合感知 REST 数据源契约测试：分页、串行轮询、暂停恢复、轨迹/航线与失败保留、按权限读取。 */
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;

function ok(name, condition) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`✗ ${name}`);
}

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n  期望 ${JSON.stringify(expected)}\n  实到 ${JSON.stringify(actual)}`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loadSource(deps) {
  const filename = path.resolve(__dirname, '../src/pages/situation/situationApiSource.js');
  let source = fs.readFileSync(filename, 'utf8');
  source = source.replace(/import[\s\S]*?from ['"][^'"]+['"];\r?\n/g, '');
  source = `const { deviceApi, targetApi, listAlarms, listAllFlightPlans, flightApi, airspaceApi,
    riskApi, handoffApi, mapPool, attachBearing, attachDeviceEvents, attachRecentTracks, extendRecentTracks,
    attachTargetSourceLinks, bearingOrigins, planIsCurrent, toAirspaces, toAlarms, toDevices, toFlightPlans,
    toRisks, toTargets, SITUATION_DEVICE_TYPE_ORDER, isRealtimeConnected, onDataChange, hasPermission, authUser } = globalThis.__situationContractDeps;\n${source}`;
  globalThis.__situationContractDeps = deps;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`);
}

async function main() {
  const data = await import('../src/services/situationData.js');

  // 两次重读之间本机接上的点要和上一点序号连续，地图才画成连线（放大到街道级也不断成一个个点）。
  const vm = require('node:vm');
  const mapContext = { window: {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/assets/js/map.js'), 'utf8'), mapContext);
  const continuous = mapContext.window.MapView.trackContinuous;
  const tail = [{ lon: 118.5, lat: 37.4, track_id: 'k1', point_seq: 7, t: 1000, kind: 'meas', corridor_relation: 'WITHIN' }];
  let local = data.extendRecentTracks([{ targetId: 'a', lon: 118.501, lat: 37.401, observedAt: 2000 }], [{ targetId: 'a', track: tail }]);
  local = data.extendRecentTracks([{ targetId: 'a', lon: 118.502, lat: 37.402, observedAt: 3000 }], local);
  const extended = local[0].track;
  check('本机接上的点序号连续、沿用走廊关系', extended.map(point => [point.point_seq, point.corridor_relation]),
    [[7, 'WITHIN'], [8, 'WITHIN'], [9, 'WITHIN']]);
  let steady = [{ targetId: 'b', track: Array.from({ length: 24 }, (_, i) => ({ lon: 118.5, lat: 37.4 + i / 1e5,
    track_id: 'k2', point_seq: i, t: 10_000 + i * 300, kind: 'meas', corridor_relation: 'WITHIN' })) }];
  for (let second = 1; second <= 5; second++) {
    steady = data.extendRecentTracks([{ targetId: 'b', lon: 118.5, lat: 37.41 + second / 1e5, observedAt: 16_900 + second * 1000 }], steady);
  }
  const steadyTrack = steady[0].track;
  ok(`本机接点时尾迹时长不变（${steadyTrack.at(-1).t - steadyTrack[0].t}ms）`, steadyTrack.at(-1).t - steadyTrack[0].t <= 6900);
  check('本机接点时最老的点按时间丢掉', steadyTrack.at(-1).point_seq, 28);
  check('本机接上的点在地图上连成线', [continuous(extended[0], extended[1]), continuous(extended[1], extended[2])], [true, true]);
  let devicePages = [];
  let targetCalls = 0;
  let targetConcurrent = 0;
  let maxTargetConcurrent = 0;
  let failTargets = false;
  const now = Date.parse('2026-09-22T09:00:00Z');
  const dayStart = Date.parse('2026-09-21T16:00:00Z');
  let clock = now;
  const targetQueries = [];
  const trackQueries = [];
  const calls = { alarms: 0, risks: 0, handoffs: 0, plans: 0 };
  const riskQueries = [];
  const riskRows = Array.from({ length:101 }, () => ({ risk: { risk_id:require('node:crypto').randomUUID(),
    risk_type:'SPACE_OBJECT',state:'NOTIFIED',current_status:'CURRENT',source_mode:'replay',occurred_at:now-86400000 } }));
  let eventCalls = 0;
  let handoffsForbidden = false;
  let realtimeConnected = false;
  let extraTarget = null;
  let rejectSlimTracks = false;
  let emptyTracks = false;
  let noRouteBatch = false;
  const airspaceQueries = [];
  let airspaceDetailCalls = 0;
  let rejectAirspaceInclude = false;
  const airspaceRows = [];
  const airspaceVersion = { kind_code: 'PROHIBITED', max_altitude_m: 120,
    boundary: { type: 'MultiPolygon', coordinates: [[[[118.4, 37.3], [118.5, 37.3], [118.5, 37.4], [118.4, 37.3]]]] } };
  const routeBatchQueries = [];
  let routeSingleCalls = 0;
  const ALL_CODES = ['target:read', 'alarm:read', 'risk:read', 'handoff:read', 'devices.read', 'monitoring.read',
    'flight:read', 'route:read', 'airspace:read'];
  let granted = new Set(ALL_CODES);
  let pushHandler = null;
  let alarmsGate = null;
  const devices = Array.from({ length: 101 }, (_, index) => ({
    device_id: `d${index}`, device_no: `DEV-${index}`, name: `设备${index}`,
    device_type_code: index === 0 ? 'EO' : 'RADAR', device_type_name: index === 0 ? '光电' : '雷达',
    enabled: index !== 100,
    longitude: 118.5 + index / 100000, latitude: 37.4, connectivity: 'ONLINE', source_mode: 'replay',
    coverage: { kind: 'CIRCLE', status: 'AVAILABLE', radius_m: 5000, source_label: '接口配置' }
  }));
  devices[2].device_type_code = 'weather_sensor';
  devices[3].device_type_code = 'NEW_SENSOR';
  devices[1].longitude = null;
  devices[1].latitude = null;
  devices[1].simulated = true;
  const targetRow = {
    target_id: 't1', target_no: 'MB-1', object_type_code: 'UAV', source_mode: 'replay', last_seen_at: now - 2 * 60 * 60_000,
    freshness: 'STALE', stale: true,
    latest_state: { location: { longitude: 118.51, latitude: 37.41 }, fusion_confidence: 0.91 }
  };
  let extraPlans = [];
  const planRow = { plan_id: 'p1', plan_no: 'FP-1', status_code: 'EXECUTING', start_at: now - 1000,
    end_at: now + 10000, source_mode: 'replay', route: { route_version_id: 'rv1' } };

  const deps = {
    ...data,
    mapPool: async (items, _limit, mapper) => Promise.all(items.map(mapper)),
    deviceApi: {
      list: async ({ page, enabled, statistics_scope }) => {
        check('设备范围与大屏后台同源', [enabled, statistics_scope], [true, true]);
        devicePages.push(page);
        return { items: page === 1 ? devices.slice(0, 100) : devices.slice(100), total: 101 };
      },
      events: async () => { eventCalls++; return { items: [] }; }
    },
    targetApi: {
      currentPredictions: async () => ({ items: [], total: 0 }),
      listAll: async params => {
        targetQueries.push(params);
        targetCalls++;
        targetConcurrent++;
        maxTargetConcurrent = Math.max(maxTargetConcurrent, targetConcurrent);
        await delay(20);
        targetConcurrent--;
        if (failTargets) throw new Error('intentional target outage');
        const items = [targetRow, extraTarget].filter(row => row && row.last_seen_at >= params.seen_from && row.last_seen_at <= params.seen_to);
        return { items, total: items.length };
      },
      recentTracks: async params => {
        trackQueries.push(params);
        if (rejectSlimTracks && (params.slim || params.target_ids)) { const error = new Error('VALIDATION_ERROR'); error.status = 400; throw error; }
        if (emptyTracks) return { items: [] };
        return { items: [{ target_id: 't1', track_id: 'track-1', points: [
        { point_id: 'point-1', track_id: 'track-1', point_seq: 1, observed_at: now - 1000,
          sort_time: now - 1000, time_basis: 'OBSERVED', received_at: now - 900,
          location: { longitude: 118.5, latitude: 37.4, coordinate_system: 'WGS84' }, point_kind: 'MEAS' },
        { point_id: 'point-2', track_id: 'track-1', point_seq: 2, observed_at: now,
          sort_time: now, time_basis: 'OBSERVED', received_at: now + 100,
          location: { longitude: 118.51, latitude: 37.41, coordinate_system: 'WGS84' }, point_kind: 'PRED' }
      ] }] }; },
      fusionStatus: async () => ({ status: 'RUNNING' }),
      detail: async () => ({ source_links: [{ device_id: 'd0' }] })
    },
    listAlarms: async () => { calls.alarms++; if (alarmsGate) await alarmsGate; return { items: [], total: 0 }; },
    listAllFlightPlans: async () => { calls.plans++; return [planRow, ...extraPlans]; },
    flightApi: {
      routeVersion: async () => { routeSingleCalls++; return { route_version_id: 'rv1', centerline: {
        coordinates: [[118.4, 37.3], [118.6, 37.5]]
      } }; },
      routeVersionBatch: async ids => {
        routeBatchQueries.push(ids);
        if (noRouteBatch) { const error = new Error('NOT_FOUND'); error.status = 404; throw error; }
        return { items: ids.filter(id => id === 'rv1').map(id => ({ route_version_id: id, centerline: {
          coordinates: [[118.4, 37.3], [118.6, 37.5]]
        } })) };
      }
    },
    airspaceApi: {
      list: async params => {
        airspaceQueries.push(params);
        if (rejectAirspaceInclude && params.include) { const error = new Error('VALIDATION_ERROR'); error.status = 400; throw error; }
        const rows = airspaceRows.map(row => params.include ? { ...row, current_version: airspaceVersion } : row);
        return { items: rows, total: rows.length };
      },
      detail: async id => { airspaceDetailCalls++; return { ...airspaceRows.find(row => row.airspace_id === id), current_version: airspaceVersion }; }
    },
    riskApi: { listCurrentRisks: async query => {
      calls.risks++;riskQueries.push(query);
      if (!query.plan_id) throw new Error('当前风险接口必须明确 plan_id');
      const rows = query.plan_id === planRow.plan_id ? riskRows : [];
      return { items:rows.slice((query.page-1)*query.size,query.page*query.size),total:rows.length };
    }, listRisks:async()=>{throw new Error('不得将当天历史列表用作实时风险');} },
    handoffApi: { listHandoffs: async () => {
      calls.handoffs++;
      if (handoffsForbidden) { const error = new Error('无权访问'); error.status = 403; throw error; }
      return { items: [], total: 0 };
    } },
    onDataChange: (_topics, handler) => { pushHandler = handler; return () => { if (pushHandler === handler) pushHandler = null; }; },
    isRealtimeConnected: () => realtimeConnected,
    hasPermission: code => granted.has(code),
    authUser: { value: { user_type: 'BACKEND' } }
  };
  const { createSituationApiSource } = await loadSource(deps);
  globalThis.document = { hidden: false };
  const snapshots = [];
  const errors = [];
  const source = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
  source.start(value => snapshots.push(value), (error, segment) => errors.push({ error, segment }));
  while (!snapshots.some(frame => frame.risks.length === 101)) await delay(5);

  const first = snapshots.find(frame => frame.risks.length === 101);
  check('目标范围为北京时间当天零点至当前，不依赖机器时区',
    [targetQueries[0].seen_from, targetQueries[0].seen_to], [dayStart, now]);
  check('只取此刻地图显示还没到期的目标，不再每轮分页拉完当天全部目标（ZT-20 复测 2）',
    [targetQueries[0].map_visible_at, targetQueries[0].include_merged], [now, false]);
  check('目标范围扩展不突破近期轨迹接口窗口限制',
    trackQueries[0], { observed_from: now - 5 * 60_000, observed_to: now, points_per_target: 24, slim: true, target_ids: 't1' });
  check('两小时前停止上报的目标仍然可见', first.targets.map(row => row.id), ['MB-1']);
  check('当天旧目标保留最后上报时间和过期事实',
    [first.targets[0].lastSeenAt, first.targets[0].freshness, first.targets[0].stale],
    [targetRow.last_seen_at, 'STALE', true]);
  check('当前航线风险完整读取当前投影分页',first.risks.length,101);
  check('当前风险不按今天发生时间截断跨日风险',riskQueries.slice(0,2),[{plan_id:planRow.plan_id,page:1,size:100},{plan_id:planRow.plan_id,page:2,size:100}]);
  check('当前投影保留真实风险ID、持续状态及已通知事实',[first.risks[0].riskId,first.risks[0].currentStatus,first.risks[0].state],
    [riskRows[0].risk.risk_id,'CURRENT','NOTIFIED']);
  check('设备列表按 total 继续读取第二页', devicePages, [1, 2]);
  check('所有启用设备完整分页，新增类型不被前台隐藏', first.devices.length, 100);
  ok('新增类型与天气设备均保留', first.devices.some(row => row.deviceId === 'd2') && first.devices.some(row => row.deviceId === 'd3'));
  check('API 无坐标设备仍保留在感知列表', first.devices.find(row => row.deviceId === 'd1')?.posValid, false);
  check('模拟来源标记不能被发布快照重置', first.simulated, true);
  check('回放来源由真实响应推导', first.sourceMode, 'replay');
  check('批量近期轨迹接入目标', first.targets[0].track.length, 2);
  check('近期轨迹保留观测身份、时间与点类型', first.targets[0].track.map(point =>
    [point.point_id, point.track_id, point.point_seq, point.t, point.kind]),
  [['point-1', 'track-1', 1, now - 1000, 'meas'], ['point-2', 'track-1', 2, now, 'pred']]);
  check('计划航线读取版本中心线', first.flightPlans[0].coordinates, [[118.4, 37.3], [118.6, 37.5]]);
  check('航线中心线一次取回，不逐条请求', [routeBatchQueries, routeSingleCalls], [[['rv1']], 0]);
  check('选中目标后按内部 device_id 关联来源', (await source.loadTargetDetail('t1')).source_links[0].device_id, 'd0');

  failTargets = true;
  pushHandler(['target']);
  const failureStarted = Date.now();
  while (!errors.some(row => row.segment === 'targets') && Date.now() - failureStarted < 3000) await delay(5);
  ok('目标刷新失败会上报分段错误', errors.some(row => row.segment === 'targets'));
  check('接口失败保留上次真实目标，不回退 mock', snapshots.at(-1).targets.map(row => row.id), ['MB-1']);
  ok('SSE 与失败重试禁止目标请求重叠', maxTargetConcurrent === 1);

  source.pause();
  const callsAtPause = targetCalls;
  await delay(50);
  check('页面隐藏期间停止读取', targetCalls, callsAtPause);
  source.resume();
  while (targetCalls === callsAtPause) await delay(5);
  ok('恢复可见后立即刷新', targetCalls > callsAtPause);
  source.stop();
  await delay(50);
  failTargets = false;
  // 更换任务编号、时间与状态：只读取此刻有效的任务，不拿今天的全部任务凑实时风险。
  const secondId = require('node:crypto').randomUUID();
  extraPlans = [
    { ...planRow, plan_id:secondId, start_at:clock-86400000 },
    { ...planRow, plan_id:require('node:crypto').randomUUID(), start_at:clock+1 },
    { ...planRow, plan_id:require('node:crypto').randomUUID(), end_at:clock },
    { ...planRow, plan_id:require('node:crypto').randomUUID(), status_code:'COMPLETED' }
  ];
  const planFrames=[],queriesBefore=riskQueries.length;
  const planScoped=createSituationApiSource({fastMs:60_000,slowMs:60_000,now:()=>clock});
  planScoped.start(value=>planFrames.push(value),()=>{});
  while(planFrames.length<3)await delay(5);
  check('多任务读取只含当前有效任务、跨日有效任务仍纳入',
    [...new Set(riskQueries.slice(queriesBefore).map(query=>query.plan_id))],[planRow.plan_id,secondId]);
  check('风险读取等任务就绪且完整分页',planFrames.at(-1).risks.length,101);
  planScoped.stop();extraPlans=[];
  const tracksBeforeDay = trackQueries.length;
  clock = Date.parse('2026-09-22T16:00:01Z');
  source.start(value => snapshots.push(value), (error, segment) => errors.push({ error, segment }));
  while (snapshots.at(-1).generatedAt !== clock) await delay(5);
  check('北京时间跨天后切换新一天零点', targetQueries.at(-1).seen_from, Date.parse('2026-09-22T16:00:00Z'));
  ok('跨天后实时尾迹不混入昨天', trackQueries.slice(tracksBeforeDay).every(query => query.observed_from >= Date.parse('2026-09-22T16:00:00Z')));
  check('图上没有目标时不读尾迹', trackQueries.length, tracksBeforeDay);
  check('跨天后旧目标退出当天地图而不改历史', snapshots.at(-1).targets, []);
  source.stop();

  // 推送触发的一轮只重读变化的分组；定时兜底拉长到不会在测试期间触发。
  const pushed = createSituationApiSource({ fastMs: 60_000, slowMs: 60_000, now: () => clock });
  const pushedSnapshots = [];
  pushed.start(value => pushedSnapshots.push(value), () => {});
  while (pushedSnapshots.length < 2) await delay(5);
  const counts = () => ({ targets: targetCalls, devices: devicePages.length, ...calls });
  async function afterPush(topics, until) {
    const before = counts();
    pushHandler(topics);
    const started = Date.now();
    while (!until(before, counts()) && Date.now() - started < 3_000) await delay(5);
    await delay(50);
    const after = counts();
    return Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));
  }
  check('目标变化只读目标，不连带告警、风险、移送和设备',
    await afterPush(['target'], (a, b) => b.targets > a.targets),
    { targets: 1, devices: 0, alarms: 0, risks: 0, handoffs: 0, plans: 0 });
  check('告警变化只读告警',
    await afterPush(['alarm'], (a, b) => b.alarms > a.alarms),
    { targets: 0, devices: 0, alarms: 1, risks: 0, handoffs: 0, plans: 0 });
  check('计划变化只读计划资料组',
    await afterPush(['plan'], (a, b) => b.plans > a.plans),
    { targets: 0, devices: 0, alarms: 0, risks: 0, handoffs: 0, plans: 1 });
  check('设备状态信号保留到节流结束再读取，不能丢掉最后一次变化',
    await afterPush(['device_state'], (a, b) => b.devices > a.devices),
    { targets: 0, devices: 2, alarms: 0, risks: 0, handoffs: 0, plans: 0 });
  clock += 11_000;
  check('后续设备状态信号仍只读取设备',
    await afterPush(['device_state'], (a, b) => b.devices > a.devices),
    { targets: 0, devices: 2, alarms: 0, risks: 0, handoffs: 0, plans: 0 });
  pushed.stop();
  ok('停止后取消订阅', pushHandler === null);

  // SSE 已连接时，保留推送触发的即时刷新，但不再每 10ms 走一次完整兜底轮询。
  realtimeConnected = true;
  const connected = createSituationApiSource({ fastMs: 10, slowMs: 60_000, now: () => clock });
  const connectedSnapshots = [];
  connected.start(value => connectedSnapshots.push(value), () => {});
  while (!connectedSnapshots.length) await delay(5);
  const connectedBefore = targetCalls;
  await delay(100);
  check('SSE 在线时完整轮询至少降到 30 秒', targetCalls - connectedBefore, 0);
  connected.stop();
  realtimeConnected = false;

  // 尾迹不随每次位置推送整包重下：5 秒内只读目标，用最新位置把尾迹接上；到 5 秒或出现新目标才重读尾迹。
  clock = now;
  const savedRow = { ...targetRow, latest_state: { ...targetRow.latest_state } };
  targetRow.last_seen_at = now;
  const paced = createSituationApiSource({ fastMs: 60_000, slowMs: 60_000, now: () => clock });
  const pacedSnapshots = [];
  paced.start(value => pacedSnapshots.push(value), () => {});
  while (pacedSnapshots.length < 2) await delay(5);
  async function pushTarget() {
    const before = pacedSnapshots.length;
    pushHandler(['target']);
    const started = Date.now();
    while (pacedSnapshots.length === before && Date.now() - started < 3_000) await delay(5);
    await delay(20);
    return pacedSnapshots.at(-1).targets.find(row => row.targetId === 't1');
  }
  let tracksBefore = trackQueries.length;
  const risksBeforePacing = calls.risks;
  clock = now + 1000;
  targetRow.latest_state = { location: { longitude: 118.52, latitude: 37.42 }, observed_at: now + 1000 };
  let moved = await pushTarget();
  check('5 秒内的位置推送不重读尾迹', trackQueries.length - tracksBefore, 0);
  check('5 秒内的位置推送不连带重读风险', calls.risks-risksBeforePacing, 0);
  check('尾迹在本机接上最新位置', moved.track.map(point => [point.lon, point.lat, point.track_id, point.point_id]).at(-1),
    [118.52, 37.42, 'track-1', null]);
  check('接上的点在原尾迹之后', moved.track.length, 3);
  clock = now + 2000;
  moved = await pushTarget();
  check('同一位置不重复接点', moved.track.length, 3);
  clock = now + 3000;
  extraTarget = { target_id: 't2', target_no: 'MB-2', object_type_code: 'UAV', source_mode: 'replay', last_seen_at: now,
    latest_state: { location: { longitude: 118.6, latitude: 37.5 }, observed_at: now + 3000 } };
  await pushTarget();
  check('新目标出现立即补读尾迹，只要图上目标', trackQueries.slice(tracksBefore).map(query => query.target_ids), ['t1,t2']);
  extraTarget = null;
  tracksBefore = trackQueries.length;
  clock = now + 4000;
  await pushTarget();
  check('补读后 5 秒内不再重读', trackQueries.length - tracksBefore, 0);
  clock = now + 8100;
  moved = await pushTarget();
  check('连续目标推送不能饿死当前风险更新，满 5 秒完整重读分页', calls.risks-risksBeforePacing, 2);
  check('满 5 秒重读尾迹，后端点替换本机接上的点', [trackQueries.length - tracksBefore, moved.track.map(point => point.point_id)],
    [1, ['point-1', 'point-2']]);
  emptyTracks = true;
  clock = now + 13_200;
  targetRow.latest_state = { location: { longitude: 118.53, latitude: 37.43 }, observed_at: now + 13_200 };
  moved = await pushTarget();
  check('重读没带回尾迹时沿用本机尾迹，不一闪而空', moved.track.map(point => point.point_id), ['point-1', 'point-2', null]);
  emptyTracks = false;
  rejectSlimTracks = true;
  tracksBefore = trackQueries.length;
  clock = now + 18_300;
  moved = await pushTarget();
  check('旧后端不认精简参数时改回整包读取', trackQueries.slice(tracksBefore).map(query => [!!query.slim, query.target_ids || '']),
    [[true, 't1'], [false, '']]);
  check('改回整包后尾迹照常', moved.track.length, 2);
  clock = now + 23_400;
  await pushTarget();
  check('之后不再先试精简参数', [!!trackQueries.at(-1).slim, trackQueries.length - tracksBefore], [false, 3]);
  paced.stop();
  rejectSlimTracks = false;
  Object.assign(targetRow, savedRow);

  // 前台账号即使保留旧后台权限码，也不能请求后台专属设备事件；身份缺失同样不猜测为后台。
  for (const userType of ['FRONTEND', undefined]) {
    deps.authUser.value = { user_type: userType };
    const before = eventCalls, frames = [], failures = [];
    const frontend = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
    frontend.start(value => frames.push(value), (_error, segment) => failures.push(segment));
    while (frames.length < 2) await delay(5);
    check('非后台身份不请求设备事件：' + String(userType), eventCalls - before, 0);
    ok('非后台身份仍读取有权设备台账：' + String(userType), frames.at(-1).devices.length === 100);
    check('非后台身份不将事件读取标记为服务异常：' + String(userType), failures, []);
    frontend.stop();
  }
  deps.authUser.value = { user_type: 'BACKEND' };

  granted=new Set(ALL_CODES.filter(code=>code!=='flight:read'));
  const noFlight=createSituationApiSource({fastMs:60_000,slowMs:60_000,now:()=>clock});
  const noFlightFrames=[],noFlightErrors=[],currentCalls=calls.risks;
  noFlight.start(value=>noFlightFrames.push(value),(_error,segment)=>noFlightErrors.push(segment));
  while(noFlightFrames.length<2)await delay(5);
  check('缺少任务读取权限时不请求当前风险接口',calls.risks-currentCalls,0);
  check('缺任务权限不伪造风险或报服务故障',[noFlightFrames.at(-1).risks,noFlightErrors],[[],[]]);
  noFlight.stop();

  // ZT-09：值班员没有设备监测（monitoring.read）和风险读取权限：不请求设备事件和风险，也不报刷新失败。
  granted = new Set(ALL_CODES.filter(code => code !== 'monitoring.read' && code !== 'risk:read'));
  const duty = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
  const dutySnapshots = [];
  const dutyErrors = [];
  const eventsBefore = eventCalls;
  const risksBefore = calls.risks;
  duty.start(value => dutySnapshots.push(value), (error, segment) => dutyErrors.push(segment));
  while (dutySnapshots.length < 2) await delay(5);
  check('没有设备监测权限时不请求设备事件', eventCalls - eventsBefore, 0);
  check('没有风险权限时不请求风险', calls.risks - risksBefore, 0);
  check('没有权限的分组不报刷新失败', dutyErrors, []);
  check('没有权限的分组不算刷新失败', dutySnapshots.at(-1).failedSegments, []);
  check('快照注明没有权限的分组', dutySnapshots.at(-1).deniedSegments, ['risks', 'device-events']);
  ok('有权限的设备照常读取', dutySnapshots.at(-1).devices.length === 100);

  // 后端答复 403（登录后权限被收回）：按没有权限处理，不反复请求、不报刷新失败。
  handoffsForbidden = true;
  const handoffsBefore = calls.handoffs;
  pushHandler(['punishment']);
  const deniedStarted = Date.now();
  while (!dutySnapshots.at(-1).deniedSegments.includes('handoffs') && Date.now() - deniedStarted < 3000) await delay(5);
  pushHandler(['punishment']);
  await delay(1100);
  check('403 的分组只请求一次', calls.handoffs - handoffsBefore, 1);
  check('403 不报刷新失败', dutyErrors, []);
  check('403 的分组记为没有权限', dutySnapshots.at(-1).deniedSegments, ['risks', 'handoffs', 'device-events']);
  duty.stop();
  handoffsForbidden = false;

  // 飞行计划要连同航线版本一起读：有计划权限、没有航线权限时整组不读，不报刷新失败。
  granted = new Set(ALL_CODES.filter(code => code !== 'route:read'));
  const noRoute = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
  const noRouteSnapshots = [];
  const noRouteErrors = [];
  const plansBefore = calls.plans;
  noRoute.start(value => noRouteSnapshots.push(value), (error, segment) => noRouteErrors.push(segment));
  while (noRouteSnapshots.length < 2) await delay(5);
  check('没有航线权限时不请求飞行计划', calls.plans - plansBefore, 0);
  check('没有航线权限不报刷新失败', noRouteErrors, []);
  check('缺航线权限也不读无法关联的当前风险', noRouteSnapshots.at(-1).deniedSegments, ['risks','flight-plans']);
  noRoute.stop();
  granted = new Set(ALL_CODES);

  // CDX-P01：同一轮里告警等几组分页读得慢时，目标一读回就先发布到地图，不等整轮读完。
  let openAlarms;
  alarmsGate = new Promise(resolve => { openAlarms = resolve; });
  const early = createSituationApiSource({ fastMs: 60_000, slowMs: 60_000, now: () => clock });
  const earlySnapshots = [];
  const alarmsBeforeEarly = calls.alarms;
  early.start(value => earlySnapshots.push(value), () => {});
  const earlyStarted = Date.now();
  while ((!earlySnapshots.length || calls.alarms === alarmsBeforeEarly) && Date.now() - earlyStarted < 3_000) await delay(5);
  await delay(30);
  ok('告警还没读完，目标已先发布', earlySnapshots.length === 1 && earlySnapshots[0].generatedAt === clock);
  openAlarms();
  alarmsGate = null;
  while (earlySnapshots.length < 2 && Date.now() - earlyStarted < 3_000) await delay(5);
  ok('整轮读完后照旧再发布一次', earlySnapshots.length >= 2);
  early.stop();

  // 空域连同当前版本一次取回，不逐片请求详情；旧后端不认 include 时改回逐片读取。
  airspaceRows.push({ airspace_id: 'as1', airspace_no: 'ASP-1', name: '禁飞区一' }, { airspace_id: 'as2', airspace_no: 'ASP-2', name: '禁飞区二' });
  for (const oldBackend of [false, true]) {
    rejectAirspaceInclude = oldBackend;
    const detailsBefore = airspaceDetailCalls;
    const spaceSource = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
    const spaceSnapshots = [];
    spaceSource.start(value => spaceSnapshots.push(value), () => {});
    while (!spaceSnapshots.some(value => value.airspaces.length === 2)) await delay(5);
    spaceSource.stop();
    check(oldBackend ? '旧后端：改回逐片读取空域详情' : '空域一次取回，不逐片请求详情', airspaceDetailCalls - detailsBefore, oldBackend ? 2 : 0);
  }
  ok('空域列表请求带 include=current_version', airspaceQueries.some(query => query.include === 'current_version'));
  rejectAirspaceInclude = false;
  airspaceRows.length = 0;

  // 没有批量航线接口的旧后端：改回逐条读取，航线照常画出。
  noRouteBatch = true;
  const singleBefore = routeSingleCalls;
  const oldBackend = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
  const oldSnapshots = [];
  const oldErrors = [];
  oldBackend.start(value => oldSnapshots.push(value), (error, segment) => oldErrors.push(segment));
  while (!oldSnapshots.some(value => value.flightPlans.length)) await delay(5);
  check('旧后端不认批量航线时逐条补读', routeSingleCalls - singleBefore, 1);
  check('逐条补读后航线照常', oldSnapshots.find(value => value.flightPlans.length).flightPlans[0].coordinates,
    [[118.4, 37.3], [118.6, 37.5]]);
  check('改回逐条读取不报刷新失败', oldErrors, []);
  oldBackend.stop();
  noRouteBatch = false;
  // K03：完整分页与失败保留；无目标权限不能读取预测或保留旧位置。
  const predictionPages = [];
  const forecastRows = Array.from({ length: 101 }, (_, index) => ({ prediction_id: `p-${index}`, target_id: `forecast-target-${index}`,
    status: index % 2 ? 'UNKNOWN' : 'READY', source_mode: index % 2 ? 'replay' : 'live', warnings: [] }));
  let forecastFailure = false;
  deps.targetApi.currentPredictions = async ({ page, size }) => {
    predictionPages.push(page);
    if (forecastFailure) throw new Error('prediction unavailable');
    return { items: forecastRows.slice((page - 1) * size, page * size), total: forecastRows.length };
  };
  const forecastSource = createSituationApiSource({ fastMs: 60_000, slowMs: 60_000, now: () => clock });
  const forecastSnapshots = [];
  forecastSource.start(value => forecastSnapshots.push(value), () => {});
  const forecastStart = Date.now();
  while (!forecastSnapshots.some(value => value.predictions.length === 101) && Date.now() - forecastStart < 3_000) await delay(5);
  await delay(50);
  check('预测完整读取两页，不截断全图数量', forecastSource.current().predictions.length, 101);
  check('预测分页顺序', predictionPages.slice(0, 2), [1, 2]);
  forecastFailure = true;
  await forecastSource.refresh();
  check('预测失败保留事项供未知状态展示', forecastSource.current().predictions.length, 101);
  ok('预测失败单独标记，不假装正常', forecastSource.current().failedSegments.includes('predictions'));
  const hadTargetRead = granted.has('target:read');
  granted.delete('target:read');
  await forecastSource.refresh();
  check('无目标权限清空预测', forecastSource.current().predictions, []);
  if (hadTargetRead) granted.add('target:read');
  forecastSource.stop();
  // 权限改变与单目标/分页请求交错：旧结果即使晚返回也不得恢复旧标识或位置。
  const originalAdd = globalThis.addEventListener, originalRemove = globalThis.removeEventListener;
  const accessListeners = new Set();
  globalThis.addEventListener = (name, listener) => { if (name === 'auth-access-change') accessListeners.add(listener); };
  globalThis.removeEventListener = (name, listener) => { if (name === 'auth-access-change') accessListeners.delete(listener); };
  const previousGrants = granted; granted = new Set(['target:read']);
  const oldForecast = { ...forecastRows[0], source_mode: 'replay', simulated: true, anchor: { location: { longitude: 118.25, latitude: 37.15 } } };
  let listReader = async () => ({ items: [oldForecast], total: 1 });
  deps.targetApi.currentPredictions = params => listReader(params);
  const guarded = createSituationApiSource({ fastMs: 60_000, slowMs: 60_000, now: () => clock });
  guarded.start(() => {}, () => {});
  await delay(60);
  check('仅预测记录也计入模拟来源', guarded.current().simulated, true);
  check('仅预测记录保留回放来源', guarded.current().sourceMode, 'replay');
  guarded.setSourceTarget(oldForecast.target_id);
  deps.targetApi.prediction = async () => ({ ...oldForecast, target_id: 'unrelated-target' });
  let mismatch = false;
  try { await guarded.loadTargetPrediction(oldForecast.target_id); } catch { mismatch = true; }
  ok('单目标错配被拒绝', mismatch);
  ok('单目标错配令旧预测转未知', guarded.current().failedSegments.includes('predictions'));
  await guarded.refresh();
  ok('完整重读成功后恢复可用', !guarded.current().failedSegments.includes('predictions'));

  let releaseList;
  listReader = () => new Promise(resolve => { releaseList = resolve; });
  const oldListRequest = guarded.refresh();
  deps.targetApi.prediction = async () => { throw Object.assign(new Error('target scope changed'), { status: 403 }); };
  try { await guarded.loadTargetPrediction(oldForecast.target_id); } catch { /* expected */ }
  check('单目标403先清除旧范围缓存', guarded.current().predictions, []);
  releaseList({ items: [oldForecast], total: 1 });
  await oldListRequest;
  check('先前分页响应晚到也不恢复403目标', guarded.current().predictions, []);
  ok('403等待重新读取期间保持不可用', guarded.current().failedSegments.includes('predictions'));

  listReader = async () => ({ items: [oldForecast], total: 1 });
  await guarded.refresh();
  let releaseSelected;
  deps.targetApi.prediction = () => new Promise(resolve => { releaseSelected = resolve; });
  const oldSelectedRequest = guarded.loadTargetPrediction(oldForecast.target_id);
  listReader = async () => { throw Object.assign(new Error('prediction read forbidden'), { status: 403 }); };
  await guarded.refresh();
  releaseSelected(oldForecast);
  check('分页403后在途单目标结果不回写', await oldSelectedRequest, null);
  check('分页403清空所有预测标识坐标', guarded.current().predictions, []);
  ok('分页403记为无权限且不重复失败重试', guarded.current().deniedSegments.includes('predictions') && !guarded.current().failedSegments.includes('predictions'));

  // 相同权限码但数据范围或账号已改变，也不能沿用旧结果。
  for (const listener of accessListeners) listener();
  listReader = async () => ({ items: [oldForecast], total: 1 });
  await guarded.refresh();
  listReader = () => new Promise(resolve => { releaseList = resolve; });
  const beforeAccessChange = guarded.refresh();
  for (const listener of accessListeners) listener();
  check('权限刷新立即清空缓存，不等下一次轮询', guarded.current().predictions, []);
  releaseList({ items: [oldForecast], total: 1 });
  await beforeAccessChange;
  check('旧权限下的在途分页不能写回', guarded.current().predictions, []);
  const newForecast = { ...oldForecast, target_id: 'new-visible-target', prediction_id: 'new-visible-snapshot' };
  listReader = async () => ({ items: [newForecast], total: 1 });
  await guarded.refresh();
  check('重新读取只显示新范围结果', guarded.current().predictions.map(row => row.target_id), ['new-visible-target']);
  guarded.stop(); granted = previousGrants;
  if (originalAdd) globalThis.addEventListener = originalAdd; else delete globalThis.addEventListener;
  if (originalRemove) globalThis.removeEventListener = originalRemove; else delete globalThis.removeEventListener;
  deps.targetApi.currentPredictions = async () => ({ items: [], total: 0 });
  delete globalThis.document;
  delete globalThis.__situationContractDeps;

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exit(1); });
