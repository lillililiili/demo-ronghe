const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('录像只选平台证据收的格式，文件名与计时便于辨认', async () => {
  const capture = await import('../src/components/video/eoCapture.js');
  assert.deepEqual({ ...capture.recordingFormat(type => type === 'video/webm;codecs=vp8') },
    { mimeType: 'video/webm;codecs=vp8', type: 'video/webm', extension: 'webm' });
  assert.equal(capture.recordingFormat(type => type === 'video/mp4').extension, 'mp4');
  assert.equal(capture.recordingFormat(type => type === 'video/x-matroska'), null);
  assert.equal(capture.recordingFormat(() => { throw new Error('unsupported'); }), null);
  assert.equal(capture.recordingFormat(undefined), null);
  const at = new Date(2026, 9, 6, 9, 5, 7).getTime();
  assert.equal(capture.captureFileName('EO_STILL', at, 'jpg'), 'eo-still-20261006-090507.jpg');
  assert.equal(capture.captureFileName('EO_VIDEO', at, 'webm'), 'eo-video-20261006-090507.webm');
  assert.equal(capture.elapsedText(59_999), '00:59');
  assert.equal(capture.elapsedText(capture.MAX_RECORDING_MS), '01:00');
  // 一分钟录像按码率上限估算，不超过证据单文件 32 MiB。
  assert.ok(capture.MAX_RECORDING_MS / 1000 * capture.RECORDING_BITS_PER_SECOND / 8 < 32 * 1024 * 1024);
});

test('不能取证的原因在点击时说明，保存结果说清关联与能否重试', async () => {
  const capture = await import('../src/components/video/eoCapture.js');
  const ready = { permitted: true, playing: true, recordable: true };
  assert.equal(capture.captureBlocked({ ...ready, kindCode: 'EO_STILL' }), '');
  assert.equal(capture.captureBlocked({ ...ready, kindCode: 'EO_VIDEO' }), '');
  assert.equal(capture.captureBlocked({ ...ready, permitted: false, kindCode: 'EO_STILL' }), '当前账号没有截图、录像取证的权限。');
  assert.equal(capture.captureBlocked({ ...ready, playing: false, kindCode: 'EO_STILL' }), '视频播放时才能截图，请先播放视频。');
  assert.equal(capture.captureBlocked({ ...ready, recordable: false, kindCode: 'EO_VIDEO' }), '当前浏览器不支持录像，可以先截图取证。');
  assert.equal(capture.captureBlocked({ ...ready, recordable: false, kindCode: 'EO_STILL' }), '');

  const links = kinds => kinds.map(subject_kind => ({ subject_kind }));
  assert.equal(capture.captureSavedText({ evidence_no: 'EV-1', links: links(['TARGET', 'DEVICE', 'EVENT']) }, 'EO_STILL'),
    '截图已存为证据 EV-1，已关联目标和告警。');
  assert.equal(capture.captureSavedText({ evidence_no: 'EV-2', links: links(['TARGET', 'DEVICE']) }, 'EO_VIDEO', true),
    '录像已存为证据 EV-2，已关联目标（测试视频画面，非现场）。');

  const replay = capture.captureFailure({ status: 409, code: 'IDEMPOTENCY_REPLAY', message: '重复请求' }, true);
  assert.equal(replay.retry, false);
  assert.match(replay.text, /之前已经保存成功/);
  const timeout = capture.captureFailure({ status: 408, code: 'TIMEOUT', message: '系统响应超时。' }, true);
  assert.equal(timeout.retry, true);
  assert.match(timeout.text, /保存结果未确认：系统响应超时。.*不会重复入库/);
  assert.equal(capture.captureBackgroundText('EO_VIDEO', timeout), '录像取证的保存结果未确认，请到证据台账查看是否已保存。');
  assert.deepEqual({ ...capture.captureFailure({ status: 403, message: 'Forbidden' }, false) },
    { text: '当前账号没有截图、录像取证的权限。', retry: false });
  const notTracking = capture.captureFailure({ status: 422, code: 'EO_CAPTURE_NOT_TRACKING', message: '当前没有进行中的光电跟踪，不能截图或录像。' }, false);
  assert.deepEqual({ ...notTracking }, { text: '当前没有进行中的光电跟踪，不能截图或录像。', retry: false });
  assert.equal(capture.captureBackgroundText('EO_STILL', notTracking), notTracking.text);
});

test('取证上传带幂等键，只报取证距今毫秒数，不带客户端钟点', () => {
  const source = readFileSync(path.join(__dirname, '../src/services/deviceApi.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const calls = [];
  const context = vm.createContext({
    FormData, URLSearchParams, crypto: globalThis.crypto, apiRequest() {},
    apiRequestTimed: (...args) => { calls.push(args); return Promise.resolve({}); }
  });
  vm.runInContext(source, context);
  const deviceApi = vm.runInContext('deviceApi', context);
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'eo-still-20261006-090507.jpg', { type: 'image/jpeg' });
  deviceApi.captureTargetVideo('t/1', { file, kindCode: 'EO_STILL', streamId: 's1', eventId: 'e1', captureAgeMs: 1234.6 }, 'eo-capture-key');
  const [url, options, timeout] = calls[0];
  assert.equal(url, '/targets/t%2F1/video/captures');
  assert.equal(options.method, 'POST');
  assert.equal(options.mutation, true);
  assert.equal(options.idempotencyKey, 'eo-capture-key');
  assert.equal(timeout, 60_000);
  assert.deepEqual([...options.body.keys()], ['file', 'kind_code', 'stream_id', 'event_id', 'capture_age_ms']);
  assert.equal(options.body.get('file').name, 'eo-still-20261006-090507.jpg');
  assert.equal(options.body.get('kind_code'), 'EO_STILL');
  assert.equal(options.body.get('stream_id'), 's1');
  assert.equal(options.body.get('event_id'), 'e1');
  assert.equal(options.body.get('capture_age_ms'), '1235');
  deviceApi.captureTargetVideo('t1', { file, kindCode: 'EO_VIDEO', streamId: 's1', eventId: '', captureAgeMs: -5 });
  assert.equal(calls[1][1].body.has('event_id'), false, '没有关联告警时不带事件');
  assert.equal(calls[1][1].body.get('capture_age_ms'), '0');
  assert.match(calls[1][1].idempotencyKey, /^eo-capture-/);
});
