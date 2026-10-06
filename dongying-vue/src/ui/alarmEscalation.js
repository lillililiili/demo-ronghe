/* 告警升级（2026-10-06，BUG-11 偏航告警不升级、BUG-16 同一架无人机两条告警）：
   同一架无人机再次违规时，服务端升级它原有的那条告警，不再另起一条要重新核实的告警。
   这里只把服务端字段说成值班员看得懂的话——现在是什么等级、因为什么、谁在什么时候升级的；
   纯函数，不读 window，等级与原因词典由调用方传入，node 可直接测试。 */

export const ESCALATION_TRIGGER_TEXT = { ENGINE: '系统研判', MANUAL: '人工转告警' };

const codes = value => [...new Set((Array.isArray(value) ? value : [])
  .filter(code => typeof code === 'string' && code.trim()).map(code => code.trim()))];
const textOf = (translate, code, fallback) => (code ? (translate && translate(code)) || String(code) : fallback);

/** 违规原因代码 → “夜间飞行、偏航（偏离报备航线）”；没有原因时为空串，由页面决定不显示。 */
export function reasonListText(reasons, reasonText) {
  return codes(reasons).map(code => textOf(reasonText, code, '')).join('、');
}

/** 告警的升级摘要；没升级过返回 null。等级没变也算升级（带来了新的违规原因）。 */
export function escalationBrief(alarm, severityText) {
  const count = Number(alarm?.escalation_count) || 0;
  if (count <= 0) return null;
  const now = alarm.severity, before = alarm.original_severity || now;
  const raised = !!before && !!now && before !== now;
  return {
    count,
    raised,
    level: raised
      ? `${textOf(severityText, before, '未知')} → ${textOf(severityText, now, '未知')}`
      : `等级未变（${textOf(severityText, now, '未知')}）`,
    at: alarm.escalated_at ?? null
  };
}

/** 升级记录 → 页面上的一行行文字；只做翻译，转义与拼装由页面负责。 */
export function escalationRecords(items, { severityText, reasonText, fmt } = {}) {
  return (Array.isArray(items) ? items : []).map(item => {
    const before = item?.severity_before, after = item?.severity_after;
    const raised = !!before && !!after && before !== after;
    const added = reasonListText(item?.reasons_added, reasonText);
    const manual = item?.trigger_kind === 'MANUAL';
    return {
      key: item?.escalation_id || String(item?.seq ?? ''),
      title: `第 ${item?.seq ?? '?'} 次 · ${ESCALATION_TRIGGER_TEXT[item?.trigger_kind] || '来源未说明'}`,
      raised,
      level: raised
        ? `${textOf(severityText, before, '未知')} → ${textOf(severityText, after, '未知')}`
        : `等级未变（${textOf(severityText, after, '未知')}）`,
      added: added ? `新增原因：${added}` : '没有新增原因',
      actor: manual ? (item?.actor_name || item?.actor_id || '操作人未记录') : '系统自动',
      note: typeof item?.note === 'string' ? item.note.trim() : '',
      time: fmt ? fmt(item?.created_at) || '时间未知' : String(item?.created_at ?? '')
    };
  });
}
