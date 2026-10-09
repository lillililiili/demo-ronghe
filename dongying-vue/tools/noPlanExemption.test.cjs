const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceRoot = path.resolve(__dirname, '../src');
const load = file => import(pathToFileURL(path.join(sourceRoot, file)).href);

const c01 = facts => ({ rule_code: 'C01', result_code: 'FAIL', facts });

test('a legal no-task flight explains the height and the ordinary-airspace rule from the C01 facts', async () => {
  const { noPlanExemptReason } = await load('ui/noPlanExemption.js');
  const detail = { legal_status: 'LEGAL', plan_match_code: 'NONE', hit_details: [c01({ match_reason: 'NO_PLAN_CANDIDATE', no_plan_exempt: true, height_agl_m: 99.6 })] };
  assert.equal(noPlanExemptReason(detail), '没有报备任务；离地约 100 米，不超过 120 米，不在禁飞区、管制区、限高区、临时管控区内，按规定无需申请');
  // 高度缺了（不该出现，后台没有离地高度不会标无需申请）也不编数字。
  assert.equal(noPlanExemptReason({ ...detail, hit_details: [c01({ no_plan_exempt: true })] }),
    '没有报备任务；不超过 120 米，不在禁飞区、管制区、限高区、临时管控区内，按规定无需申请');
});

test('list rows without explicit exemption facts do not infer a height or airspace exemption', async () => {
  const { noPlanExemptReason } = await load('ui/noPlanExemption.js');
  assert.equal(noPlanExemptReason({ legal_status: 'LEGAL', plan_match_code: 'NONE' }), '');
  // 有本机候选任务、对上了任务、非法或不可判定的，都不是这一类。
  assert.equal(noPlanExemptReason({ legal_status: 'LEGAL', plan_match_code: 'NONE', plan_id: 'p-1' }), '');
  assert.equal(noPlanExemptReason({ legal_status: 'LEGAL', plan_match_code: 'FULL', plan_id: 'p-1' }), '');
  assert.equal(noPlanExemptReason({ legal_status: 'ILLEGAL', plan_match_code: 'NONE' }), '');
  assert.equal(noPlanExemptReason({ legal_status: 'UNDETERMINED', plan_match_code: 'NONE' }), '');
  // 详情带了单项检查却没有无需申请标记（旧研判、或规则集把没有任务配成合法）：照旧写法。
  assert.equal(noPlanExemptReason({ legal_status: 'LEGAL', plan_match_code: 'NONE', hit_details: [c01({ match_reason: 'NO_PLAN_CANDIDATE' })] }), '');
  assert.equal(noPlanExemptReason(null), '');
});
