const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

/* E1：通知上级弹窗的预览和其他页面一样，目标编号只显示“20261012-196”这样的完整日期加序号（2026-10-09 用户确认）。
   只改预览的显示，服务端材料和提交内容保持原样。 */
async function loadPreview(response) {
  const { displayNumberReferences, displayTargetNo } = await import('../src/ui/deviceNumber.js');
  const file = readFileSync(path.join(__dirname, '../src/ui/riskNoticePreview.js'), 'utf8');
  const source = file.replace(/import[\s\S]*?from ['"][^'"]+['"];?/g, '').replace(/\bexport (?=(?:async )?(?:function|const)\b)/g, '');
  const deps = { handoffApi: { previewRisk: async () => response }, displayNumberReferences, displayTargetNo };
  return new Function(...Object.keys(deps), `${source}; return riskNoticePreview;`)(...Object.values(deps));
}

test('预览的关联目标和风险事由去掉“目标-”前缀，服务端材料不改', async () => {
  const targetNo = '目标-20261012-196';
  const response = {
    source_version: 3, generated_at: '2026-10-12T06:00:00Z', plan_no: 'PLN-1', target_no: targetNo,
    recipient: { org_name: '上级单位', setting_id: 'S-1', config_version: 2, channel_type: 'HTTP' },
    material: {
      references: { plan_id: 'plan-1', target_id: 'target-internal-1' },
      risk: { reason_text: `${targetNo} 距离航线 80 米，数量未知；目标-20261012-1960 是另一个目标` },
      verifications: [{ note: '已核验' }], evidence_chain: []
    }
  };
  const result = await (await loadPreview(response))('risk-1', 3);
  assert.match(result.introHtml, /<dt>关联目标<\/dt><dd>20261012-196<\/dd>/);
  assert.match(result.introHtml, /<dt>风险<\/dt><dd>20261012-196 距离航线 80 米，数量未知；目标-20261012-1960 是另一个目标<\/dd>/);
  assert.match(result.introHtml, /<details>[\s\S]*风险记录版本 3[\s\S]*<\/details>/, '风险版本保留在详细信息中');
  assert.doesNotMatch(result.introHtml, /目标-20261012-196(?![\w-])/, '只替换完整编号，别的目标编号不动');
  assert.equal(result.target_no, targetNo);
  assert.equal(result.material.risk.reason_text.startsWith(targetNo), true);
});

test('没有目标编号或事由时，预览仍显示原来的缺省文字', async () => {
  const empty = await (await loadPreview({ source_version: 1, material: {} }))('risk-2', 1);
  assert.match(empty.introHtml, /<dt>关联目标<\/dt><dd>本风险未关联目标<\/dd>/);
  assert.match(empty.introHtml, /<dt>风险<\/dt><dd>未提供<\/dd>/);
  const byId = await (await loadPreview({ source_version: 1, material: { references: { target_id: 'target-internal-1' } } }))('risk-3', 1);
  assert.match(byId.introHtml, /<dt>关联目标<\/dt><dd>已关联目标<\/dd>/);
  assert.equal(byId.material.references.target_id, 'target-internal-1', '不把内部编号露在摘要中，也不改服务端材料');
});
