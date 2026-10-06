const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/* TC-RPT-001 现场记录：浏览器时区不是 +8 时，运行统计的日期框显示会比实际统计的日期差一天。
   日期框选的是"哪一天"，naive 按浏览器本地时区渲染时间戳，所以初值和回读必须都按本地自然日来：
   以前初值写死 +08:00、回读又按 Asia/Shanghai 格式化，两头各用一套时区就对不上。 */
const source = readFileSync(path.join(__dirname, '../src/pages/StatsPage.vue'), 'utf8');

function roundTrip(timezone, day) {
  const seed = source.match(/dateRange\.value = \[(Date\.parse\(`\$\{data\.from\}[^`]*`\)), /);
  const format = source.match(/const date = (value => new Intl\.DateTimeFormat\([^;]+?\)\.format\(value\));/);
  assert.ok(seed, '找不到日期框初值');
  assert.ok(format, '找不到查询日期的格式化');
  const script = `const data = { from: ${JSON.stringify(day)} };`
    + `const seeded = ${seed[1].replace('${data.from}', day)};`
    + `const date = ${format[1]};`
    + `const shown = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(seeded);`
    + `console.log(JSON.stringify({ sent: date(seeded), shown }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: timezone } }).toString());
}

test('the stats date box shows and sends the same day in any browser timezone', () => {
  // 东八区以外也必须一致：显示哪一天，就按哪一天查。
  for (const timezone of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Pacific/Auckland']) {
    const { sent, shown } = roundTrip(timezone, '2026-09-05');
    assert.equal(shown, '2026-09-05', `${timezone} 的日期框显示错了一天`);
    assert.equal(sent, '2026-09-05', `${timezone} 送给后端的日期与框里显示的不一致`);
  }
});

test('the stats page still says the range is counted in Beijing days', () => {
  // 口径没变：这几天按北京自然日统计，必须在界面上说明，只是不再用时区换算去改显示。
  assert.match(source, /统计日期（北京时间）/);
  assert.doesNotMatch(source, /T00:00:00\+08:00/);
});
