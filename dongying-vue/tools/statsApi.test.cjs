const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('operations distinguishes unavailable metrics from genuine zero and keeps provenance', async () => {
  const source = fs.readFileSync('src/services/statsApi.js', 'utf8').replace(/^import .*;\n/, '');
  const { mapOperations } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const result = mapOperations({ summary: { total: 0, illegal: null }, generated_at: 123, source_mode: 'replay', simulated: true, availability: { illegal: { status: 'UNAVAILABLE', reason: '无权限' } } });
  assert.equal(result.total, 0);
  assert.equal(result.illegal, null);
  assert.equal(result.punish, null);
  assert.equal(result.generatedAt, 123);
  assert.equal(result.availability.illegal.reason, '无权限');
  assert.equal(result.sourceMode, 'replay');
});
