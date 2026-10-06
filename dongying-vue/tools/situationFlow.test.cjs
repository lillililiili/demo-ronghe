#!/usr/bin/env node
/* 融合感知页动作可见性纯函数测试：用 data URL 替换 Vite 别名，仅测试生产源文件。 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n  期望 ${JSON.stringify(expected)}\n  实到 ${JSON.stringify(actual)}`);
}

async function main() {
  const filename = path.resolve(__dirname, '../src/pages/situation/situationFlow.js');
  const dataUrl = pathToFileURL(path.resolve(__dirname, '../src/services/situationData.js')).href;
  const source = fs.readFileSync(filename, 'utf8')
    .replace("@/services/situationData.js", dataUrl);
  const flow = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  const eo = { typeCode: 'EO', lon: 118.5, lat: 37.4,
    coverage: { kind: 'circle', status: 'available', radiusM: 5000 } };
  const target = { lon: 118.51, lat: 37.4, objectTypeCode: 'UAV', relatedAlarms: [{ eventState: 'CONFIRMED' }] };
  check('目标位于可用 EO 覆盖内时可跟踪', flow.eoCanMonitor(target, [eo]), true);
  check('离线 EO 覆盖不能冒充可跟踪', flow.eoCanMonitor(target, [{ ...eo, coverage: { ...eo.coverage, status: 'unavailable' } }]), false);
  check('干扰执行中不冒充反制', flow.disposalStage({ status: 'EXECUTING', actionType: 'JAMMING' }), 'jamming');
  check('反制执行中不冒充干扰', flow.disposalStage({ status: 'EXECUTING', actionType: 'COUNTERMEASURE' }), 'counter');
  check('处置完成后不再显示误报入口', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'countered' }), []);
  check('审批中不显示前端伪成功动作', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'requested' }), []);
  check('待核实事件只显示核实', flow.uavProcessActions({ eventState: 'PENDING_VERIFICATION', disposalStage: 'none' }), ['verify']);
  check('核实属实后显示反制候选入口并移除核实', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'none' }), ['counter']);
  check('未知状态不开放核实或反制', flow.uavProcessActions({ eventState: 'UNKNOWN', disposalStage: 'none' }), []);
  check('执行中不重复发起反制', flow.uavProcessActions({ eventState: 'CONFIRMED', disposalStage: 'counter' }), []);
  check('已移送不再发起反制', flow.uavProcessActions({ eventState: 'CONFIRMED', handoff: true }), []);
  check('误报事件不再显示动作', flow.uavProcessActions({ eventState: 'FALSE_POSITIVE', disposalStage: 'none' }), []);
  check('处罚交接完成后显示已移送', flow.uavProcessStatus({ eventState: 'CONFIRMED', disposalStage: 'countered', handoff: true }), '已移送处罚');
  check('反制完成不写成已干扰', flow.uavProcessStatus({ eventState: 'CONFIRMED', disposalStage: 'countered' }), '反制已完成');
  check('待核实告警进入融合感知待办', flow.situationAlarmNeedsAttention({ eventState: 'PENDING_VERIFICATION' }), true);
  check('已核实且尚未处置的告警显示待反制', flow.situationAlarmNeedsAttention({ eventState: 'CONFIRMED', disposalStage: 'none' }), true);
  check('已进入处置的告警不重复显示为待反制', flow.situationAlarmNeedsAttention({ eventState: 'CONFIRMED', disposalStage: 'counter' }), false);
  check('已移送告警不重复显示为待办', flow.situationAlarmNeedsAttention({ eventState: 'CONFIRMED', disposalStage: 'none', handoff: true }), false);
  check('航线风险待办只显示待通知', flow.situationRouteRiskNeedsAttention({ active: true, state: 'PENDING_NOTIFICATION' }), true);
  check('航线待核验风险不进入待通知列表', flow.situationRouteRiskNeedsAttention({ active: true, state: 'PENDING_VERIFICATION' }), false);
  check('失去当前依据的待通知风险不进入列表', flow.situationRouteRiskNeedsAttention({ active: false, state: 'PENDING_NOTIFICATION' }), false);
  check('待通知航线风险进入融合感知列表', flow.situationRouteRiskVisible({
    state: 'PENDING_NOTIFICATION', riskType: 'SPACE_OBJECT', planId: 'p1', routeVersionId: 'rv1'
  }), true);
  check('待核验航线风险不进入融合感知列表', flow.situationRouteRiskVisible({
    state: 'PENDING_VERIFICATION', riskType: 'SPACE_OBJECT', planId: 'p1', routeVersionId: 'rv1'
  }), false);
  check('没有航线关联的风险不进入航线风险列表', flow.situationRouteRiskVisible({
    state: 'PENDING_VERIFICATION', riskType: 'SPACE_OBJECT', planId: 'p1'
  }), false);

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exit(1); });
