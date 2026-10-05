const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../web/external.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../web/external.js'), 'utf8');

test('the inbox presents all six distinct notification channels', () => {
  for (const kind of ['sms', 'voice', 'risk', 'punishment', 'plan_feedback', 'device_maintenance']) {
    assert.match(html, new RegExp(`data-tab="${kind}"`));
    assert.match(script, new RegExp(`\\b${kind}:\\[`));
  }
});

test('the two platform history channels can page through source records', () => {
  assert.match(script, /\['risk','punishment','plan_feedback','device_maintenance'\]\.includes\(tab\)/);
});
