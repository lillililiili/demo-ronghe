/* 遥控器位置显示口径：有位置写坐标并注明是设备测算，没有就写“没有遥控器位置”。 */
const assert = require('node:assert/strict');

(async () => {
  const { pilotLocationText, pilotPoint, NO_PILOT_LOCATION } = await import('../src/services/pilotLocation.js');
  assert.equal(pilotLocationText({ longitude: 118.512345678, latitude: 37.41 }), '118.512346, 37.410000（设备测算的大概位置）');
  assert.equal(pilotLocationText({ longitude: '118.5', latitude: '37.4' }), '118.500000, 37.400000（设备测算的大概位置）');
  for (const missing of [null, undefined, {}, { longitude: 118.5 }, { longitude: null, latitude: 37.4 },
    { longitude: 'x', latitude: 37.4 }, { longitude: 200, latitude: 37.4 }]) {
    assert.equal(pilotLocationText(missing), NO_PILOT_LOCATION);
    assert.equal(pilotPoint(missing), null);
  }
  const { toTargets } = await import('../src/services/situationData.js');
  const [withPilot, withoutPilot] = toTargets([
    { target_id: 't1', object_type_code: 'UAV', latest_state: { location: { longitude: 118.5, latitude: 37.4 },
      pilot_location: { longitude: 118.49, latitude: 37.39 } } },
    { target_id: 't2', object_type_code: 'UAV', latest_state: { location: { longitude: 118.5, latitude: 37.4 } } }
  ]);
  assert.deepEqual(withPilot.pilotLocation, { longitude: 118.49, latitude: 37.39 });
  assert.equal(withoutPilot.pilotLocation, null);
  // 融合感知页（验收预跑 3-7）：目标已不在地图上的告警卡片手里没有遥控器位置，不能写成“没有遥控器位置”；
  // 悬停小卡片不接点击，免得盖住旁边的无人机。
  const fs = require('node:fs'), path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../src/pages/SituationPage.vue'), 'utf8');
  const { PILOT_LOCATION_IN_ALARM_DETAIL } = await import('../src/services/pilotLocation.js');
  assert.equal(PILOT_LOCATION_IN_ALARM_DETAIL, '目标已不在地图上，请在告警详情里查看');
  assert.match(page, /遥控器位置：\{\{ PILOT_LOCATION_IN_ALARM_DETAIL \}\}/);
  assert.doesNotMatch(page, /NO_PILOT_LOCATION/);
  assert.match(page, /interactiveTip: false/);
  console.log('全部通过：遥控器位置显示');
})().catch(error => { console.error(error); process.exitCode = 1; });
