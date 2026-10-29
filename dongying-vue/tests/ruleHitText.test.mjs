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

test('高度基准写成离地高度/海拔，长度单位统一为米', () => {
  assert.equal(ruleHitText('目标高度 180.11 m（AMSL）超出任务高度带 20–150 m'), '目标高度 180.11 米（海拔）超出任务高度带 20–150 米');
  assert.equal(ruleHitText('目标缺少 AMSL 基准高度，AGL 与 AMSL 不互比'), '目标缺少海拔高度，离地高度与海拔不能直接比较');
  assert.equal(ruleHitText('目标缺少 AGL 基准高度，AGL 与 AMSL 不互比'), '目标缺少离地高度，离地高度与海拔不能直接比较');
  assert.equal(ruleHitText('空域高度带与目标高度基准不一致或缺失，AGL 与 AMSL 不互比'), '空域高度带与目标高度基准不一致或缺失，离地高度与海拔不能直接比较');
  assert.equal(ruleHitText('目标距飞手 320 m，在视距阈值内'), '目标距飞手 320 米，在视距阈值内');
});

test('查不到空域名称时不留空隙；任务内部编号换成任务编号，查不到就去掉', () => {
  assert.equal(ruleHitText(`目标高度超过空域 ${id} 的限高 300 m（AMSL）`), '目标高度超过空域的限高 300 米（海拔）');
  assert.equal(ruleHitText('时间窗、走廊与身份均匹配任务 seed-fp-261014-3'), '时间窗、走廊与身份均匹配任务');
  assert.equal(ruleHitText(`时间窗与走廊匹配任务 ${id}，身份线索缺失`, { plans: { [id]: 'JH-001' } }), '时间窗与走廊匹配任务 JH-001，身份线索缺失');
});
