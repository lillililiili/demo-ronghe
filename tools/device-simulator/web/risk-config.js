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
      return {kind: 'plan', label: '飞行计划'};
    }
    // 无匹配计划是模拟器的诊断输入，不绑定某个业务目标或计划。
    return {kind: 'none', label: ''};
  }

  function associationNotice(risk = {}) {
    if (DEVICE_RISK_TYPES.has(risk.type)) return '';
    const reference = referenceFor(risk);
    const suffix = reference.label ? `，当前依据为${reference.label}` : '';
    return `关联目标由设备观测与平台规则自动判定${suffix}。此处不手工选择目标。`;
  }

  const api = {referenceFor, associationNotice, DEVICE_RISK_TYPES};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SimulatorRiskConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
