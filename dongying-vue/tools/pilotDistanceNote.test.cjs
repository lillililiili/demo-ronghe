const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceRoot = path.resolve(__dirname, '../src');
const load = file => import(pathToFileURL(path.join(sourceRoot, file)).href);

const NOTE = '飞手离无人机约 800 米（超过 500 米），是否经批准请核实';
const c026 = facts => ({ rule_code: 'C02-6', result_code: 'PASS', facts, message: `${NOTE}；参数为 DEMO 演示值，尚未确认` });

test('the legality detail takes the sentence from the pilot-distance check only when the pilot is beyond the threshold', async () => {
  const { pilotDistanceNote, pilotDistanceHit } = await load('ui/pilotDistanceNote.js');
  const far = { legal_status: 'LEGAL', hit_details: [{ rule_code: 'C01', result_code: 'PASS', facts: {} }, c026({ distance_m: 800, vlos_m: 500, beyond_vlos: true, pilot_distance_note: NOTE })] };
  assert.equal(pilotDistanceNote(far), NOTE);
  assert.equal(pilotDistanceHit(far).rule_code, 'C02-6');
  // 在 500 米以内、没有遥控器位置（不适用）、旧研判里的超视距不通过：都不是这一句。
  assert.equal(pilotDistanceNote({ hit_details: [c026({ distance_m: 55 })] }), '');
  assert.equal(pilotDistanceNote({ hit_details: [{ rule_code: 'C02-6', result_code: 'NOT_APPLICABLE', reason_code: 'PILOT_POSITION_UNAVAILABLE', facts: {} }] }), '');
  assert.equal(pilotDistanceHit({ hit_details: [{ rule_code: 'C02-6', result_code: 'FAIL', reason_code: 'BVLOS_EXCEEDED', facts: { distance_m: 800 } }] }), null);
  assert.equal(pilotDistanceNote(null), '');
});

test('targets carry the sentence in their legality summary, which pages may pass on its own', async () => {
  const { pilotDistanceNote } = await load('ui/pilotDistanceNote.js');
  const target = { target_id: 't-1', legality_summary: { legal_status: 'ILLEGAL', grade: 'HIGH', pilot_distance_note: ` ${NOTE} ` } };
  assert.equal(pilotDistanceNote(target), NOTE);
  assert.equal(pilotDistanceNote(target.legality_summary), NOTE);
  assert.equal(pilotDistanceNote({ legality_summary: { legal_status: 'LEGAL' } }), '');
  assert.equal(pilotDistanceNote({ legality_summary: { pilot_distance_note: '  ' } }), '');
});
