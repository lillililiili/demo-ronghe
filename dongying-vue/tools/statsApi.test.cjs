const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('operations distinguishes unavailable metrics from genuine zero and keeps provenance', async () => {
  const source = fs.readFileSync('src/services/statsApi.js', 'utf8').split('const number =')[1].split('export const statsApi')[0];
  const { mapOperations } = await import('data:text/javascript;base64,' + Buffer.from('const number =' + source).toString('base64'));
  const result = mapOperations({ summary: { total: 0, illegal: null }, generated_at: 123, source_mode: 'replay', simulated: true, availability: { illegal: { status: 'UNAVAILABLE', reason: '无权限' } } });
  assert.equal(result.total, 0);
  assert.equal(result.illegal, null);
  assert.equal(result.punish, null);
  assert.equal(result.generatedAt, 123);
  assert.equal(result.availability.illegal.reason, '无权限');
  assert.equal(result.sourceMode, 'replay');
});

test('airborne distribution has its own denominator and keeps unidentified separate', async () => {
  const source = fs.readFileSync('src/services/statsApi.js', 'utf8').split('const number =')[1].split('export const statsApi')[0];
  const { mapOperations } = await import('data:text/javascript;base64,' + Buffer.from('const number =' + source).toString('base64'));
  for (const factor of [1, 3]) {
    const result = mapOperations({ summary: { total: 10 * factor }, by_type: [{ name: '人员', value: 4 * factor }],
      airborne_types: { items: [{ name: '无人机', value: 2 * factor }], total: 2 * factor, unidentified: 4 * factor } });
    assert.equal(result.airborneTypes.total, 2 * factor);
    assert.equal(result.airborneTypes.unidentified, 4 * factor);
    assert.deepEqual(result.airborneTypes.items, [{ name: '无人机', value: 2 * factor }]);
    assert.equal(result.total, 10 * factor);
  }
  assert.equal(mapOperations({ by_type: [{ name: '人员', value: 8 }] }).airborneTypes, null);
  assert.deepEqual(mapOperations({ airborne_types: { items: [], total: 0, unidentified: 0 } }).airborneTypes,
    { items: [], total: 0, unidentified: 0 });
  assert.deepEqual(mapOperations({ airborne_types: { items: [] } }).airborneTypes,
    { items: [], total: null, unidentified: null });
});
