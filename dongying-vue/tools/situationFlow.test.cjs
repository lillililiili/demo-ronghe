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
  check('未处置事件显示误报与反制', flow.uavProcessActions({ eventState: 'PENDING_VERIFICATION', disposalStage: 'none' }), ['false-positive', 'counter']);
  check('误报事件不再显示动作', flow.uavProcessActions({ eventState: 'FALSE_POSITIVE', disposalStage: 'none' }), []);
  check('处罚交接完成后显示已移送', flow.uavProcessStatus({ eventState: 'CONFIRMED', disposalStage: 'countered', handoff: true }), '已移送处罚');
  check('反制完成不写成已干扰', flow.uavProcessStatus({ eventState: 'CONFIRMED', disposalStage: 'countered' }), '反制已完成');

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exit(1); });
