const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceRoot = path.resolve(__dirname, '../src');
const load = file => import(pathToFileURL(path.join(sourceRoot, file)).href);

test('one source below the threshold says so with the numbers the evaluation carries', async () => {
  const { lowConfidenceReason } = await load('ui/legalityConfidence.js');
  const single = { unknown_reasons: ['LOW_CONFIDENCE', 'PILOT_POSITION_UNAVAILABLE'], confidence: 0.65, confidence_threshold: 0.75, source_count: 1 };
  assert.equal(lowConfidenceReason(single), '只有一路来源（可信度 65%），达不到 75%，不自动出告警，请人工复核');
  assert.equal(lowConfidenceReason({ ...single, confidence: 0.7, confidence_threshold: 0.9, source_count: 2 }),
    '2 路来源（可信度 70%），达不到 90%，不自动出告警，请人工复核');
  // 来源数不知道（没有降级行）或为 0（失联帧）时只写可信度和要求。
  assert.equal(lowConfidenceReason({ ...single, source_count: undefined }), '可信度 65%，达不到 75%，不自动出告警，请人工复核');
  assert.equal(lowConfidenceReason({ ...single, source_count: 0 }), '可信度 65%，达不到 75%，不自动出告警，请人工复核');
});

test('without low confidence or without the stored numbers the page keeps its old wording', async () => {
  const { lowConfidenceReason } = await load('ui/legalityConfidence.js');
  assert.equal(lowConfidenceReason({ unknown_reasons: ['TRACK_DEGRADED'], confidence: 0.65, confidence_threshold: 0.75, source_count: 1 }), '');
  // 早先的研判只带回可信度，没有下限。
  assert.equal(lowConfidenceReason({ unknown_reasons: ['LOW_CONFIDENCE'], confidence: 0.65 }), '');
  assert.equal(lowConfidenceReason({ unknown_reasons: ['LOW_CONFIDENCE'], confidence_threshold: 0.75, source_count: 1 }), '');
  assert.equal(lowConfidenceReason(null), '');
});
