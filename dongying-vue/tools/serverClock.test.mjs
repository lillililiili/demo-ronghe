import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteServerDate, resetServerClock, serverClockOffset, serverNow } from '../src/services/serverClock.js';

// CDX-P01：地图"此刻"按平台时钟。偏差取响应头 Date（只精确到秒）。
const LOCAL = Date.parse('2026-10-07T09:00:00.300Z');
const header = ms => new Date(ms).toUTCString();
const sample = (platformMs, localMid, roundTrip = 200) => noteServerDate(header(platformMs), localMid - roundTrip / 2, localMid + roundTrip / 2);

test('本机比平台快 30 秒：按平台时间算此刻', () => {
  resetServerClock();
  for (let i = 0; i < 3; i++) sample(LOCAL - 30_000 + i * 1000, LOCAL + i * 1000);
  assert.ok(Math.abs(serverClockOffset() + 30_000) <= 1_000, `offset ${serverClockOffset()}`);
  assert.ok(Math.abs(serverNow() - (Date.now() - 30_000)) <= 1_100);
});

test('偏差在 Date 只精确到秒的误差以内时按 0 算', () => {
  resetServerClock();
  for (let i = 0; i < 5; i++) sample(LOCAL + i * 1000, LOCAL + i * 1000);
  assert.equal(serverClockOffset(), 0);
});

test('往返太慢的响应不拿来估偏差；没有样本时就是本机时间', () => {
  resetServerClock();
  sample(LOCAL - 60_000, LOCAL, 5_000);
  noteServerDate('', LOCAL, LOCAL);
  noteServerDate('not a date', LOCAL, LOCAL);
  assert.equal(serverClockOffset(), 0);
});

test('取最近几次的中位数，个别异常响应带不偏', () => {
  resetServerClock();
  for (let i = 0; i < 5; i++) sample(LOCAL + 20_000 + i * 1000, LOCAL + i * 1000);
  sample(LOCAL + 300_000, LOCAL + 6000);
  sample(LOCAL - 300_000, LOCAL + 7000);
  assert.ok(Math.abs(serverClockOffset() - 20_000) <= 1_000, `offset ${serverClockOffset()}`);
  resetServerClock();
});
