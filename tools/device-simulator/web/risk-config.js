'use strict';
(function (root) {
  const DEVICE_RISK_TYPES = new Set(['offline', 'fault']);

  function referenceFor(risk = {}) {
    if (DEVICE_RISK_TYPES.has(risk.type)) return {kind: 'device', label: '设备'};
    if (risk.type === 'zone' || risk.type === 'height' && risk.basis !== 'plan') {
      return {kind: 'zone', label: '空域'};
    }
    if (['deviation', 'time', 'bird', 'balloon'].includes(risk.type)
        || risk.type === 'height' && risk.basis === 'plan') {
      return {kind: 'plan', label: '飞行任务'};
    }
    // 无匹配计划是模拟器的诊断输入，不绑定某个业务目标或计划。
    return {kind: 'none', label: ''};
  }

  function associationNotice(risk = {}) {
    if (DEVICE_RISK_TYPES.has(risk.type)) return '';
    const reference = referenceFor(risk);
    const subject = risk.type === 'bird' ? '鸟群' : risk.type === 'balloon' ? '气球' : '目标';
    const basis = reference.kind === 'plan' ? '飞行任务/航线'
      : reference.kind === 'zone' ? '空域边界' : '当前观测条件';
    return `此处只配置${basis}作为判定依据；模拟器只发送${subject}观测，风险由平台根据目标位置、航线、空域和时间规则自动判定，不发送风险结论。`;
  }

  const api = {referenceFor, associationNotice, DEVICE_RISK_TYPES};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SimulatorRiskConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
