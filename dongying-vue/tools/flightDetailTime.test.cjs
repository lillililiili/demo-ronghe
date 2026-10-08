const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const components = [
  ['PlanFilingDetails.vue', 'time', '未提供'],
  ['PlanDeviceCheck.vue', 'date', '未记录'],
  ['PlanVerificationPanel.vue', 'date', '未记录'],
  ['DeviceAbnormalNoticeButton.vue', 'date', '未记录']
];

for (const [file, name, empty] of components) {
  const source = readFileSync(path.join(__dirname, '../src/pages/flights/components', file), 'utf8');
  const formatter = source.match(new RegExp(`function ${name}\\([^\\n]+`))[0];
  test(`${file}: plan/check/notice times remain Beijing time across client timezones`, () => {
    const timestamps = ['2026-10-06T16:00:00Z', '2026-10-07T15:59:00Z', '2026-01-01T00:00:00Z'].map(Date.parse);
    for (const timezone of ['America/New_York', 'UTC', 'Asia/Shanghai']) {
      const actual = execFileSync(process.execPath, ['-e', `${formatter}\nconsole.log(JSON.stringify(${JSON.stringify(timestamps)}.map(${name})));`],
        { encoding: 'utf8', env: { ...process.env, TZ: timezone } });
      assert.deepEqual(JSON.parse(actual), ['2026/10/7 00:00:00', '2026/10/7 23:59:00', '2026/1/1 08:00:00'], timezone);
    }
  });
  test(`${file}: missing time stays explicitly missing`, () => {
    const format = new Function(`${formatter}\nreturn ${name};`)();
    assert.equal(format(null), empty);
    assert.equal(format(undefined), empty);
  });
}
