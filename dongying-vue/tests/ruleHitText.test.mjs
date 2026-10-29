import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleHitText } from '../src/ui/ruleHitText.js';

const id = '2a97fc03-899a-4934-bf6b-c37980c4a2b9';

test('判定说明上屏不带空域种类代码、内部编号和演示参数提示', () => {
  const message = `目标进入PROHIBITED空域 ${id}；参数为 DEMO 演示值，尚未确认`;
  assert.equal(ruleHitText(message, { names: { [id]: '东营胜利机场禁飞区' } }), '目标进入禁飞区「东营胜利机场禁飞区」');
  assert.equal(ruleHitText(message), '目标进入禁飞区');
  assert.equal(ruleHitText(`目标高度超过空域 ${id} 的限高 300 m（AMSL）`, { names: { [id]: '限高区A' } }), '目标高度超过空域「限高区A」的限高 300 米（海拔）');
});

test('换不干净的说明改用原因中文', () => {
  assert.equal(ruleHitText('目标进入FOO_BAR空域', { fallback: '进入禁飞/限制空域' }), '进入禁飞/限制空域');
  assert.equal(ruleHitText('', { fallback: '无飞行授权' }), '无飞行授权');
  assert.equal(ruleHitText('起飞点与计划不符'), '起飞点与计划不符');
});
