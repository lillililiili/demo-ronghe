#!/usr/bin/env node
/* 融合感知显式模拟源单测：node tools/situationMock.test.cjs */
let passed = 0, failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n    期望 ${e}\n    实到 ${a}`);
}

function ok(name, condition) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`✗ ${name}`);
}

async function main() {
  const M = await import('../src/pages/situation/situationMock.js');
  const startedAt = 1700000000000;
  const devices = M.createMockDevices(startedAt, startedAt);

  const counts = devices.reduce((result, device) => {
    result[device.typeCode] = (result[device.typeCode] || 0) + 1;
    return result;
  }, {});
  check('四类设备按东营全域多站组网', counts, { RADAR: 6, EO: 6, FIVE_G_A: 12, TDOA: 18 });
  check('共提供 42 台模拟设备', devices.length, 42);
  check('四类图标互不相同', new Set(devices.map(device => device.icon)).size, 4);
  check('在线与离线设备数量', [devices.filter(device => device.status === '在线').length, devices.filter(device => device.status === '离线').length], [40, 2]);
  ok('雷达单站采用 5 km 圆形覆盖', devices.filter(device => device.typeCode === 'RADAR').every(device => device.coverage.kind === 'circle' && device.coverage.radiusM === 5000));
  ok('光电单站采用 2 km / 45° 定向视场', devices.filter(device => device.typeCode === 'EO').every(device => device.coverage.kind === 'sector' && device.coverage.rangeM === 2000 && device.coverage.fovDeg === 45));
  ok('5G-A 单站采用 1 km 圆形覆盖', devices.filter(device => device.typeCode === 'FIVE_G_A').every(device => device.coverage.radiusM === 1000));
  ok('TDOA 节点采用 1 km 有效范围', devices.filter(device => device.typeCode === 'TDOA').every(device => device.coverage.radiusM === 1000));
  ok('离线设备的覆盖范围均标为不可用', devices.filter(device => device.status === '离线').every(device => device.coverage.status === 'unavailable'));
  ok('四类范围均标明参数来源和更新时间', devices.every(device => device.coverage.sourceLabel === '公开指标参考 · 前端演示配置' && Number.isFinite(device.coverage.updatedAt)));
  check('每个主要区域提供三架被监测目标', M.MOCK_ROUTES.length, 18);
  ok('十八条闭合航线的各段采样点都处于至少一个可用范围内', M.MOCK_ROUTES.every(route => M.routeIsCovered(route, devices)));
  check('三类目标速度采用实际飞行量级', [...new Set(M.MOCK_ROUTES.map(route => route.speed))], [8.5, 11.5, 22]);
  ok('闭合航线周期为分钟级而非几十秒快速绕圈', M.MOCK_ROUTES.every(route => route.durationMs >= 180000 && route.durationMs <= 300000));

  const source = M.createSituationMockSource({ startedAt, tickMs: 1000 });
  const before = source.snapshot(startedAt + 11999);
  const after = source.snapshot(startedAt + 12001);
  check('12 秒前只有初始异常', before.alarms.map(alarm => alarm.id), ['SIM-ALM-001']);
  check('12 秒后新增第二条异常', after.alarms.map(alarm => alarm.id), ['SIM-ALM-001', 'SIM-ALM-002']);
  ok('目标快照提供位置插值区间', after.targets.every(target => target.movement && target.movement.endsAt > target.movement.startedAt));
  ok('每架目标都由至少一个当前可用站点监测', after.targets.every(target => target.sourceDeviceIds.length > 0));
  ok('所有模拟编号均明确带 SIM', [...after.devices, ...after.targets, ...after.alarms].every(item => String(item.id).includes('SIM')));

  let last;
  for (let i = 0; i < M.MOCK_TRACK_LIMIT + 20; i++) last = source.snapshot(startedAt + i * 1000);
  ok('所有目标轨迹限制固定长度', last.targets.every(target => target.track.length <= M.MOCK_TRACK_LIMIT));
  ok('达到上限后的全部目标轨迹长度一致', last.targets.every(target => target.track.length === M.MOCK_TRACK_LIMIT));
  source.stop();

  const live = M.createSituationMockSource({ startedAt: Date.now(), tickMs: 15 });
  let emissions = 0;
  const stop = live.start(() => { emissions++; });
  await new Promise(resolve => setTimeout(resolve, 55));
  ok('启动后持续产生位置快照', emissions >= 3);
  live.pause();
  const pausedAt = emissions;
  await new Promise(resolve => setTimeout(resolve, 45));
  check('页面隐藏时暂停快照定时器', emissions, pausedAt);
  live.resume();
  await new Promise(resolve => setTimeout(resolve, 45));
  ok('页面恢复后继续产生快照', emissions > pausedAt);
  stop();
  const stoppedAt = emissions;
  await new Promise(resolve => setTimeout(resolve, 45));
  check('停止后不再产生快照', emissions, stoppedAt);

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
