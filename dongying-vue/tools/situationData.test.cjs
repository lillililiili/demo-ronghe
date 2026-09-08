#!/usr/bin/env node
/* 融合感知页装配层单测（node 直接跑，无框架）：node tools/situationData.test.cjs
   ------------------------------------------------------------------
   每条断言都要能失败——恒真的断言比没有更糟，它占着"已验证"的名额。
   这里钉住的都是"补默认值就会出错"的地方：没有研判的目标、没有位置的目标、
   认不出种类的空域、没有当前版本的空域、没有经纬度的设备。 */

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

/** 带一个孔洞的正方形：外环四角 + 内环，内环必须被丢掉（决策 11-2）。 */
const SQUARE_WITH_HOLE = {
  type: 'MultiPolygon',
  coordinates: [[
    [[118.0, 37.0], [118.2, 37.0], [118.2, 37.2], [118.0, 37.2], [118.0, 37.0]],
    [[118.05, 37.05], [118.1, 37.05], [118.1, 37.1], [118.05, 37.1], [118.05, 37.05]]
  ]]
};

function airspace(kindCode, boundary, extra) {
  return Object.assign({
    airspace_id: 'a-1', airspace_no: 'KY-1', name: '演示空域',
    current_version: boundary === null ? null : { kind_code: kindCode, boundary, max_altitude_m: 120 }
  }, extra || {});
}

async function main() {
  const S = await import('../src/services/situationData.js');

  /* ---- 空域几何 ---- */
  const rings = S.outerRings(SQUARE_WITH_HOLE);
  check('MultiPolygon 只取外环，孔洞丢弃', rings.length, 1);
  check('外环点数保持不变', rings[0].length, 5);
  check('外环包围盒中心', S.ringCenter(rings[0]), { lon: 118.1, lat: 37.1 });
  check('非 MultiPolygon 不产出环', S.outerRings({ type: 'Polygon', coordinates: [] }), []);
  check('坐标里有非数字则整条几何作废', S.outerRings({
    type: 'MultiPolygon', coordinates: [[[[118, 37], [118.1, 'x'], [118.1, 37.1], [118, 37]]]]
  }), []);

  /* ---- 空域种类字典 ---- */
  const kinds = [['PROHIBITED', '禁飞空域', 'nofly'], ['TEMPORARY_CONTROL', '临时管制区', 'nofly'],
    ['ALTITUDE_LIMIT', '限高区域', 'limit'], ['RESTRICTED', '重点防控区域', 'limit'], ['PERMITTED', '适飞空域', 'suit']];
  for (const [code, type, layer] of kinds) {
    const meta = S.airspaceKindMeta(code);
    check(`${code} → 类型`, meta && meta.type, type);
    check(`${code} → 图层`, meta && meta.layer, layer);
  }
  ok('认不出的种类返回 null，不猜图层', S.airspaceKindMeta('WHATEVER') === null);

  /* ---- 空域装配 ---- */
  const drawn = S.toAirspaces([airspace('PROHIBITED', SQUARE_WITH_HOLE)]);
  check('可画空域产出一条', drawn.length, 1);
  check('空域带上颜色', drawn[0].color, '#ff4d5e');
  // 阶段 12：map.js 的图层归属直接读这个字段（决策 12-3），缺了会掉进按类型名的回落分支。
  check('空域带上 layer（map.js 据此决定图层归属）', drawn[0].layer, 'nofly');
  // 阶段 12 起 map.js 删掉了按 type 猜图层的回落：漏传 layer 的空域不画、只告警。
  // 所以装配层必须给**每一片**空域都带上 layer，缺一片就等于那片在地图上凭空消失。
  for (const [code] of kinds) {
    const one = S.toAirspaces([airspace(code, SQUARE_WITH_HOLE)]);
    ok(`${code} 的空域必须带 layer（否则 map.js 不画）`, one.length === 1 && !!one[0].layer);
  }
  check('空域带上 center（map.js 必需）', drawn[0].center, { lon: 118.1, lat: 37.1 });
  // map.js 把 id 直接画到图上，所以它必须是业务编号；内部 ID 只留在 airspaceId 里，不上屏。
  check('上屏的是业务编号而不是内部 ID', drawn[0].id, 'KY-1');
  check('内部 ID 另存不上屏', drawn[0].airspaceId, 'a-1');
  check('没有当前生效版本的空域不画', S.toAirspaces([airspace('PROHIBITED', null)]).length, 0);
  check('种类认不出的空域不画', S.toAirspaces([airspace('MYSTERY', SQUARE_WITH_HOLE)]).length, 0);

  /* ---- 设备 ---- */
  const devices = S.toDevices([
    { device_id: 'd1', device_no: 'DEV-1', name: '雷达一号', longitude: 118.5, latitude: 37.4, connectivity: 'ONLINE' },
    { device_id: 'd2', device_no: 'DEV-2', name: '无坐标设备', connectivity: 'OFFLINE' }
  ]);
  check('没有经纬度的设备不进地图', devices.length, 1);
  check('设备状态走字典', devices[0].status, '在线');
  check('未知连接状态不猜成在线', S.toDevices([{ device_id: 'd3', longitude: 1, latitude: 1, connectivity: 'WAT' }])[0].status, '未知');

  /* ---- 合法性 ---- */
  const legal = S.legalByTarget([
    { target_id: 't1', legal_status: 'ILLEGAL', evaluated_at: 100 },
    { target_id: 't1', legal_status: 'LEGAL', evaluated_at: 200 },
    { target_id: 't2', legal_status: 'ABNORMAL', evaluated_at: 50 }
  ]);
  check('同一目标多条研判取最新', legal.t1, '合法');
  check('异常映射', legal.t2, '异常');
  check('没有研判的目标不在映射里', legal.t3, undefined);

  /* ---- 目标 ---- */
  const targets = S.toTargets([
    { target_id: 't1', target_no: 'MB-1', object_type_code: 'UAV', subtype: 'QUADCOPTER',
      latest_state: { location: { longitude: 118.6, latitude: 37.4 }, altitude_amsl_m: 120, speed_mps: 12, fusion_confidence: 0.87 } },
    // t3 故意没有任何研判：这条目标专门用来验"没有研判 ≠ 合法"。
    { target_id: 't3', target_no: 'MB-3', object_type_code: 'UAV', latest_state: { location: null } }
  ], legal);
  check('细类走共享字典，不把 QUADCOPTER 之类的码摆上屏', targets[0].typeLabel, '多旋翼无人机');
  check('大类仍是稳定的中文（筛选与"是不是无人机"依赖它）', targets[0].type, '无人机');
  check('有位置的目标 posValid=true', targets[0].posValid, true);
  check('置信度按百分比', targets[0].fusedConf, 87);
  check('有研判的目标用研判结论', targets[0].legal, '合法');
  ok('没有位置的目标仍然在列表里', targets.length === 2);
  check('没有位置的目标 posValid=false', targets[1].posValid, false);
  check('没有位置就不给经度，不补 0', targets[1].lon, null);
  check('没有研判的目标是待确认，不是合法', targets[1].legal, '待确认');
  check('没有置信度不补 0', targets[1].fusedConf, null);

  /* ---- 告警 ---- */
  const alarms = S.toAlarms([
    { alarm_id: 'a1', alarm_no: 'AL-1', target_no: 'MB-1', severity: 'HIGH', state: 'PENDING_VERIFICATION', raised_at: 100 },
    { alarm_id: 'a2', alarm_no: 'AL-2', target_no: 'MB-2', severity: 'LOW', state: 'CONFIRMED', raised_at: 300 },
    { alarm_id: 'a3', alarm_no: 'AL-3', target_no: 'MB-3', severity: 'HIGH', state: 'CLOSED', raised_at: 400 }
  ]);
  check('已关闭的告警不进列表', alarms.length, 2);
  check('按时间倒序', alarms.map(a => a.id), ['AL-2', 'AL-1']);
  check('等级走字典', alarms[1].level, '高');

  /* ---- 轨迹点 ---- */
  const track = S.toTrack([
    { longitude: 118.1, latitude: 37.1, point_kind: 'MEAS' },
    { longitude: null, latitude: 37.2, point_kind: 'PRED' },
    { longitude: 118.3, latitude: 37.3, point_kind: 'PRED' }
  ]);
  check('没有坐标的轨迹点丢弃', track.length, 2);
  check('kind 小写透传', track.map(p => p.kind), ['meas', 'pred']);

  /* ---- percent ---- */
  check('置信度四舍五入', S.percent(0.876), 88);
  check('没有置信度返回 null', S.percent(null), null);
  check('置信度为 0 不当成缺失', S.percent(0), 0);

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
