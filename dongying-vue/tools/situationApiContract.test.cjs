#!/usr/bin/env node
/* 融合感知 REST 数据源契约测试：分页、串行轮询、暂停恢复、轨迹/航线与失败保留。 */
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
    riskApi, handoffApi, mapPool, attachBearing, attachDeviceEvents, attachRecentTracks,
    attachTargetSourceLinks, bearingOrigins, toAirspaces, toAlarms, toDevices, toFlightPlans,
    toRisks, toTargets } = globalThis.__situationContractDeps;\n${source}`;
  globalThis.__situationContractDeps = deps;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`);
}

async function main() {
  const data = await import('../src/services/situationData.js');
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
  const devices = Array.from({ length: 101 }, (_, index) => ({
    device_id: `d${index}`, device_no: `DEV-${index}`, name: `设备${index}`,
    device_type_code: index === 0 ? 'EO' : 'RADAR', device_type_name: index === 0 ? '光电' : '雷达',
    enabled: index !== 100,
    longitude: 118.5 + index / 100000, latitude: 37.4, connectivity: 'ONLINE', source_mode: 'replay',
    coverage: { kind: 'CIRCLE', status: 'AVAILABLE', radius_m: 5000, source_label: '接口配置' }
  }));
  const targetRow = {
    target_id: 't1', target_no: 'MB-1', object_type_code: 'UAV', source_mode: 'replay', last_seen_at: now - 2 * 60 * 60_000,
    freshness: 'STALE', stale: true,
    latest_state: { location: { longitude: 118.51, latitude: 37.41 }, fusion_confidence: 0.91 }
  };
  const planRow = { plan_id: 'p1', plan_no: 'FP-1', status_code: 'EXECUTING', start_at: now - 1000,
    end_at: now + 10000, source_mode: 'replay', route: { route_version_id: 'rv1' } };

  const deps = {
    ...data,
    mapPool: async (items, _limit, mapper) => Promise.all(items.map(mapper)),
    deviceApi: {
      list: async ({ page }) => {
        devicePages.push(page);
        return { items: page === 1 ? devices.slice(0, 100) : devices.slice(100), total: 101 };
      },
      events: async () => ({ items: [] })
    },
    targetApi: {
      listAll: async params => {
        targetQueries.push(params);
        targetCalls++;
        targetConcurrent++;
        maxTargetConcurrent = Math.max(maxTargetConcurrent, targetConcurrent);
        await delay(20);
        targetConcurrent--;
        if (failTargets) throw new Error('intentional target outage');
        const items = targetRow.last_seen_at >= params.seen_from && targetRow.last_seen_at <= params.seen_to ? [targetRow] : [];
        return { items, total: items.length };
      },
      recentTracks: async params => { trackQueries.push(params); return { items: [{ target_id: 't1', track_id: 'track-1', points: [
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
    listAlarms: async () => ({ items: [], total: 0 }),
    listAllFlightPlans: async () => [planRow],
    flightApi: { routeVersion: async () => ({ route_version_id: 'rv1', centerline: {
      coordinates: [[118.4, 37.3], [118.6, 37.5]]
    } }) },
    airspaceApi: { list: async () => ({ items: [], total: 0 }), detail: async value => value },
    riskApi: { listRisks: async () => ({ items: [], total: 0 }) },
    handoffApi: { listHandoffs: async () => ({ items: [], total: 0 }) }
  };
  const { createSituationApiSource } = await loadSource(deps);
  globalThis.document = { hidden: false };
  const snapshots = [];
  const errors = [];
  const source = createSituationApiSource({ fastMs: 10, slowMs: 10_000, now: () => clock });
  source.start(value => snapshots.push(value), (error, segment) => errors.push({ error, segment }));
  while (!snapshots.length) await delay(5);

  const first = snapshots[0];
  check('目标范围为北京时间当天零点至当前，不依赖机器时区',
    [targetQueries[0].seen_from, targetQueries[0].seen_to], [dayStart, now]);
  check('目标范围扩展不突破近期轨迹接口窗口限制',
    trackQueries[0], { observed_from: now - 5 * 60_000, observed_to: now, points_per_target: 24 });
  check('两小时前停止上报的目标仍然可见', first.targets.map(row => row.id), ['MB-1']);
  check('当天旧目标保留最后上报时间和过期事实',
    [first.targets[0].lastSeenAt, first.targets[0].freshness, first.targets[0].stale],
    [targetRow.last_seen_at, 'STALE', true]);
  check('设备列表按 total 继续读取第二页', devicePages, [1, 2]);
  check('只保留启用的四类融合设备并完整分页', first.devices.length, 100);
  check('回放来源由真实响应推导', first.sourceMode, 'replay');
  check('批量近期轨迹接入目标', first.targets[0].track.length, 2);
  check('近期轨迹保留观测身份、时间与点类型', first.targets[0].track.map(point =>
    [point.point_id, point.track_id, point.point_seq, point.t, point.kind]),
  [['point-1', 'track-1', 1, now - 1000, 'meas'], ['point-2', 'track-1', 2, now, 'pred']]);
  check('计划航线读取版本中心线', first.flightPlans[0].coordinates, [[118.4, 37.3], [118.6, 37.5]]);
  check('选中目标后按内部 device_id 关联来源', (await source.loadTargetDetail('t1')).source_links[0].device_id, 'd0');

  failTargets = true;
  const snapshotsBeforeFailure = snapshots.length;
  while (snapshots.length === snapshotsBeforeFailure) await delay(5);
  ok('目标刷新失败会上报分段错误', errors.some(row => row.segment === 'targets'));
  check('接口失败保留上次真实目标，不回退 mock', snapshots.at(-1).targets.map(row => row.id), ['MB-1']);
  ok('快轮询禁止目标请求重叠', maxTargetConcurrent === 1);

  source.pause();
  const callsAtPause = targetCalls;
  await delay(50);
  check('页面隐藏期间停止轮询', targetCalls, callsAtPause);
  source.resume();
  while (targetCalls === callsAtPause) await delay(5);
  ok('恢复可见后立即刷新', targetCalls > callsAtPause);
  source.stop();
  await delay(50);
  failTargets = false;
  clock = Date.parse('2026-09-22T16:00:01Z');
  source.start(value => snapshots.push(value), (error, segment) => errors.push({ error, segment }));
  while (snapshots.at(-1).generatedAt !== clock) await delay(5);
  check('北京时间跨天后切换新一天零点', targetQueries.at(-1).seen_from, Date.parse('2026-09-22T16:00:00Z'));
  check('跨天后实时尾迹不混入昨天', trackQueries.at(-1).observed_from, Date.parse('2026-09-22T16:00:00Z'));
  check('跨天后旧目标退出当天地图而不改历史', snapshots.at(-1).targets, []);
  source.stop();
  delete globalThis.document;
  delete globalThis.__situationContractDeps;

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exit(1); });
