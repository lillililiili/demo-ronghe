const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

/* OBS-14：通知上级弹窗曾写"对方回复'已驱离'后流程完成"，但上级接口只回"已回执"，
   处理结果（已驱离/未驱离）是对方愿意补充时才有的附加信息。 */
const PAGES = ['../src/ui/riskNotificationModal.js'];

function warningOf(file) {
  const source = readFileSync(path.join(__dirname, file), 'utf8');
  const warnings = [...source.matchAll(/warning: '([^']+)'/g)].map(m => m[1]).filter(text => text.includes('通知记录'));
  assert.equal(warnings.length, 1, `${file} 应只有一处通知上级弹窗提示`);
  return warnings[0];
}

test('the shared notify dialog says the flow completes on the acknowledgement', () => {
  const texts = PAGES.map(warningOf);
  for (const text of texts) {
    assert.match(text, /已回执/);
    assert.match(text, /完成/);
    // 处理结果可以提，但不能是"流程完成"的条件。
    assert.doesNotMatch(text, /“已驱离”后[^，。；]*完成/);
    assert.doesNotMatch(text, /回复处理结果。/);
  }
});
