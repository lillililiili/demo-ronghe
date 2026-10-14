const assert = require('node:assert/strict');
const test = require('node:test');
const PlanTime = require('../web/plan-time.js');
const StartCheck = require('../web/start-check.js');

const scene = () => ({
  sites: [
    {id: 's1', name: '点位 A', devices: [{id: 'd1', kind: 'radar', name: '雷达 01'}, {id: 'dx', kind: 'dcd', name: '协议破解 01'}]},
    {id: 's2', name: '点位 B', devices: [{id: 'dy', kind: 'aoa', name: 'AOA 01'}]},
  ],
  targets: [
    {id: 't1', name: '无人机 01', deviceId: 'dx', secondaryDeviceId: 'dy'},
    {id: 't2', name: '无人机 02', deviceId: 'd1', secondaryDeviceId: ''},
  ],
  risks: [{id: 'r1', name: '设备故障', deviceId: 'dy'}, {id: 'r2', name: '设备离线', deviceId: 'd1'}],
  plans: [{id: 'p1', name: '巡检任务 01', start: '09:00', end: '09:30'}, {id: 'p2', name: '巡检任务 02', start: '10:00', end: '10:30'}],
});
const named = [{site_id: 's1', device_id: 'dx'}, {site_id: 's2', device_id: 'dy'}];

test('the devices the server names are taken out of the draft and nothing else is', () => {
  const draft = scene(), done = StartCheck.removeRetiredDevices(draft, named);
  assert.deepEqual(done.removed, [{site: '点位 A', device: '协议破解 01'}, {site: '点位 B', device: 'AOA 01'}]);
  assert.deepEqual(draft.sites.map(site => [site.id, site.devices.map(device => device.id)]), [['s1', ['d1']]]);
  assert.deepEqual(done.emptiedSites, ['点位 B'], 'a group whose devices were all removed goes with them');
});

test('targets and conditions that used a removed device move to a device that can still report', () => {
  const draft = scene(), done = StartCheck.removeRetiredDevices(draft, named);
  assert.equal(draft.targets[0].deviceId, 'd1');
  assert.equal(draft.targets[0].secondaryDeviceId, '', 'a removed auxiliary device is simply dropped');
  assert.equal(draft.targets[1].deviceId, 'd1');
  assert.equal(draft.risks[0].deviceId, 'd1');
  assert.equal(draft.risks[1].deviceId, 'd1');
  assert.deepEqual(done.retargeted, [{target: '无人机 01', to: '雷达 01'}]);
  assert.deepEqual(done.unassigned, []);
});

test('when no device that can report a target is left, the targets are emptied for a person to choose again', () => {
  const draft = {
    sites: [{id: 's1', name: '点位 A', devices: [{id: 'dx', kind: 'dcd', name: '协议破解 01'}, {id: 'dz', kind: 'weather', name: '气象 01'}]}],
    targets: [{id: 't1', name: '无人机 01', deviceId: 'dx', secondaryDeviceId: ''}],
    risks: [{id: 'r1', deviceId: 'dx'}],
  };
  const done = StartCheck.removeRetiredDevices(draft, [{site_id: 's1', device_id: 'dx'}]);
  assert.equal(draft.targets[0].deviceId, '', 'a weather device cannot report a target, so it is not used');
  assert.equal(draft.risks[0].deviceId, 'dz', 'a condition may point at any remaining device');
  assert.deepEqual(done.unassigned, ['无人机 01']);
  assert.deepEqual(done.retargeted, []);
});

test('only the site and device pair the server named is removed, even if another site reuses the id', () => {
  const draft = {sites: [
    {id: 's1', name: '点位 A', devices: [{id: 'dx', kind: 'dcd', name: '协议破解 01'}, {id: 'd1', kind: 'radar', name: '雷达 01'}]},
    {id: 's2', name: '点位 B', devices: [{id: 'dx', kind: 'radar', name: '雷达 02'}]},
  ], targets: [], risks: []};
  StartCheck.removeRetiredDevices(draft, [{site_id: 's1', device_id: 'dx'}]);
  assert.deepEqual(draft.sites.map(site => site.devices.map(device => device.name)), [['雷达 01'], ['雷达 02']]);
});

test('nothing named, nothing removed, and a scene without lists does not crash', () => {
  const draft = scene();
  assert.deepEqual(StartCheck.removeRetiredDevices(draft, []).removed, []);
  assert.deepEqual(StartCheck.removeRetiredDevices(draft, undefined).removed, []);
  assert.equal(draft.sites.length, 2);
  assert.deepEqual(StartCheck.removeRetiredDevices({}, named).removed, []);
});

test('the summary after removal says what was deleted, what was switched and what the person still has to choose', () => {
  const lines = StartCheck.removalSummary(StartCheck.removeRetiredDevices(scene(), named));
  assert.match(lines[0], /已从草稿里删掉：“协议破解 01”（点位 A）、“AOA 01”（点位 B）/);
  assert.match(lines[1], /设备全被删光的设备组也去掉了：点位 B/);
  assert.match(lines[2], /“无人机 01”→“雷达 01”/);
  assert.equal(lines.length, 3);
  const empty = StartCheck.removalSummary({removed: [], emptiedSites: [], retargeted: [], unassigned: ['无人机 01']});
  assert.deepEqual(empty, ['这些目标现在没有可用的上报设备，请在右边“上报设备”里重新选一台：“无人机 01”。']);
  assert.deepEqual(StartCheck.removalSummary({removed: [], emptiedSites: [], retargeted: [], unassigned: []}), []);
});

test('"start from now" changes only the tasks the server named, to an hour from now on the Beijing clock', () => {
  const draft = scene(), now = Date.UTC(2026, 9, 13, 13, 5);
  const done = StartCheck.applyNowWindow(draft, ['p1'], now, PlanTime);
  assert.deepEqual(done.window, {start: '21:05', end: '22:05'});
  assert.deepEqual(done.changed, ['巡检任务 01']);
  assert.deepEqual([draft.plans[0].start, draft.plans[0].end], ['21:05', '22:05']);
  assert.deepEqual([draft.plans[1].start, draft.plans[1].end], ['10:00', '10:30']);
  assert.deepEqual(StartCheck.applyNowWindow(draft, undefined, now, PlanTime).changed, []);
});

test('the main button offers exactly the fixes that match the reminders on screen', () => {
  const mode = {code: 'NORMAL_MODE_IGNORES'}, window = {code: 'PLAN_OUTSIDE_WINDOW'};
  assert.deepEqual(StartCheck.fixesFor({notices: []}), {fixes: [], primary: '开始'});
  assert.deepEqual(StartCheck.fixesFor({}), {fixes: [], primary: '开始'});
  assert.deepEqual(StartCheck.fixesFor({notices: [mode]}), {fixes: [{code: 'MODE', label: '改成“异常”模式'}], primary: '改成“异常”模式并开始'});
  assert.deepEqual(StartCheck.fixesFor({notices: [window]}), {fixes: [{code: 'WINDOW', label: '把任务改成从现在起一小时'}], primary: '把任务改成从现在起一小时并开始'});
  const both = StartCheck.fixesFor({notices: [window, mode]});
  assert.deepEqual(both.fixes.map(fix => fix.code), ['MODE', 'WINDOW']);
  assert.equal(both.primary, '两项都按建议改好并开始');
  assert.deepEqual(StartCheck.fixesFor({notices: [{code: 'SOMETHING_NEW'}]}).fixes, [], 'a reminder with no automatic fix only offers to start anyway');
  const stuck = {code: 'NORMAL_MODE_IGNORES', can_fix: false};
  assert.deepEqual(StartCheck.fixesFor({notices: [stuck]}), {fixes: [], primary: '开始'}, 'the mode cannot be changed while the receiver is on, so no one-click switch is offered');
  assert.deepEqual(StartCheck.fixesFor({notices: [stuck, window]}).fixes.map(fix => fix.code), ['WINDOW'], 'the other fix is still offered');
  assert.deepEqual(StartCheck.fixesFor({notices: [{...mode, can_fix: true}]}).fixes.map(fix => fix.code), ['MODE']);
});

test('what the server says is shown as text, never as markup', () => {
  const html = StartCheck.block({title: '有设备 <b>停用</b>', message: '“a” & <script>alert(1)</script>', items: ['<img src=x onerror=1>', '“协议破解 01”（点位 A）']});
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.doesNotMatch(StartCheck.block({title: 't', message: 'm'}), /<ul/);
});
