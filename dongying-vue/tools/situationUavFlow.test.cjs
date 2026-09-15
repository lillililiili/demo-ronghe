#!/usr/bin/env node
let passed = 0, failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n    期望 ${e}\n    实到 ${a}`);
}

async function main() {
  const F = await import('../src/pages/situation/situationUavFlow.js');
  const pending = { id: 'a1', eventState: 'PENDING_VERIFICATION', level: '中' };
  const confirmed = { id: 'a2', eventState: 'CONFIRMED', level: '中', disposalStage: 'none' };
  const high = { id: 'a3', eventState: 'CONFIRMED', level: '高', disposalStage: 'none' };
  const requested = { ...confirmed, disposalStage: 'requested' };
  const jamming = { ...high, disposalStage: 'jamming' };
  const done = { ...high, disposalStage: 'completed' };
  const handed = { ...done, handoff: true };

  check('待核实只显示误报', F.uavProcessAction(pending), 'false-positive');
  check('已核实待处置显示反制', F.uavProcessAction(confirmed), 'counter');
  check('待审批不再显示反制', F.uavProcessAction(requested), null);
  check('信号干扰中显示通知处罚', F.uavProcessAction(jamming), 'punish');
  check('完成后显示通知处罚', F.uavProcessAction(done), 'punish');
  check('已移送不再显示流程按钮', F.uavProcessAction(handed), null);
  check('误报终态无流程按钮', F.uavProcessAction({ eventState: 'FALSE_POSITIVE' }), null);

  check('高异常且置信 87 跳过审批', F.skipCountermeasureApproval(high, { fusedConf: 87 }), true);
  check('中异常即使高置信也要审批', F.skipCountermeasureApproval(confirmed, { fusedConf: 90 }), false);
  check('高异常但置信不足仍要审批', F.skipCountermeasureApproval(high, { fusedConf: 70 }), false);

  const eo = { typeCode: 'EO', id: 'SIM-EO-DY', coverage: { status: 'available' } };
  const uav = { objectTypeCode: 'UAV', sourceDeviceIds: ['SIM-EO-DY'] };
  check('光电可用且观测到该机才出视频按钮', F.eoCanMonitor(uav, [eo]), true);
  check('光电离线不出视频按钮', F.eoCanMonitor(uav, [{ ...eo, coverage: { status: 'unavailable' } }]), false);
  check('异物卡片不出光电视频', F.eoCanMonitor({ objectTypeCode: 'BIRD', sourceDeviceIds: ['SIM-EO-DY'] }, [eo]), false);

  console.log(failed ? `\n${passed} 条通过，${failed} 条失败` : `全部通过：${passed} 条`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
