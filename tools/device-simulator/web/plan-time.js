(function (root) {
  'use strict';
  /* 任务时段一律按北京时间说，口径和服务端 start_check.py、fullchain.plan_window 相同：
     开始晚于结束的任务算跨夜，结束落在次日；现在还在昨晚开始的那一段里，就算在时段内。 */
  const pad = value => String(value).padStart(2, '0');
  const minutesOf = text => {
    const match = /^(\d{2}):(\d{2})$/.exec(String(text ?? ''));
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const hhmm = total => `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
  function beijingMinutes(ms) {
    const at = new Date(ms + 8 * 3600000);
    return at.getUTCHours() * 60 + at.getUTCMinutes() + at.getUTCSeconds() / 60;
  }
  /* 新任务的默认时段：从现在起一小时，可能跨过午夜。 */
  function nowWindow(ms = Date.now(), minutes = 60) {
    const start = Math.floor(beijingMinutes(ms));
    return {start: hhmm(start), end: hhmm((start + minutes) % 1440)};
  }
  /* 现在是否在时段内；开始、结束没填全或相同时不下结论（返回 null）。 */
  function windowContains(start, end, ms = Date.now()) {
    const from = minutesOf(start), to = minutesOf(end);
    if (from === null || to === null || from === to) return null;
    const now = beijingMinutes(ms);
    return to > from ? from <= now && now < to : now >= from || now < to;
  }
  function windowText(start, end, ms = Date.now()) {
    const from = minutesOf(start), to = minutesOf(end);
    if (from === null || to === null || from === to) return '';
    if (to > from) return `今天 ${start}–${end}（北京时间）`;
    return beijingMinutes(ms) < to ? `昨天 ${start} 到 今天 ${end}（北京时间）` : `今天 ${start} 到 明天 ${end}（北京时间）`;
  }
  /* 有目标挂着、或有判定条件在用的任务；故意设成“超出任务时段”的目标不算。 */
  function usedPlanIds(scene) {
    const risks = (scene?.risks || []).filter(risk => risk && risk.enabled);
    const late = new Set(risks.filter(risk => risk.type === 'time').map(risk => `${risk.targetId}|${risk.planId}`));
    const used = new Set();
    for (const target of scene?.targets || []) if (target && target.planId && !late.has(`${target.id}|${target.planId}`)) used.add(target.planId);
    for (const risk of risks) if (risk.type !== 'time' && risk.planId) used.add(risk.planId);
    return used;
  }
  /* 在用的任务里，今天的时段不包含现在的：平台会把挂在它下面的无人机判成“超出任务时段”。 */
  function outsidePlans(scene, ms = Date.now()) {
    const used = usedPlanIds(scene);
    return (scene?.plans || [])
      .filter(plan => plan && used.has(plan.id) && plan.timeMode !== 'past' && windowContains(plan.start, plan.end, ms) === false)
      .map(plan => ({id: plan.id, name: plan.name || plan.id, window: windowText(plan.start, plan.end, ms)}));
  }
  const api = {nowWindow, windowContains, windowText, usedPlanIds, outsidePlans, minutesOf};
  root.PlanTime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
