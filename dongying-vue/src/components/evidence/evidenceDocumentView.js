// 展示层只翻译已知字段和枚举，不改变原件，也不从送达状态推导处置结果。
const fields = {
  document_type: '材料类型', title: '标题', description: '说明', note: '材料说明', content: '通知内容',
  simulated: '模拟记录', is_simulated: '模拟记录', demo: '演示记录', historical_fixture: '历史补录',
  real_sms_sent: '是否发送真实短信', eligibility_replayed: '是否重新执行发送条件判断',
  original_alarm_received_at: '原告警接收时间', previous_notification_task: '补录前的通知任务',
  notification: '通知情况', records: '通知记录', recipient: '接收人', auto_sms: '自动短信', auto_voice: '自动电话',
  status: '记录状态', delivery_status: '送达状态', receipt_status: '签收回执', reason: '原因说明',
  name: '姓名或名称', actor_name: '操作人', recipient_name: '接收人', contact_hint: '联系方式',
  contact_basis: '联系方式依据', basis: '依据', kind: '记录类型', urgent: '紧急通知',
  sms_mode: '短信通道', source_mode: '来源', channel: '通知渠道', enabled: '是否启用',
  trigger_mode: '触发方式', trigger_source: '触发来源', policy_code: '执行策略',
  created_at: '记录时间', updated_at: '更新时间', evaluated_at: '研判时间', triggered_at: '触发时间',
  data_updated_at: '依据更新时间', sent_at: '发送时间', delivered_at: '送达时间', acknowledged_at: '签收时间',
  occurred_at: '发生时间', imported_at: '补录时间', captured_at: '采集时间', finished_at: '完成时间',
  started_at: '开始时间', ended_at: '结束时间', attempt_count: '尝试次数', event_version: '事件版本',
  event_id: '关联事件记录', alarm_id: '关联告警记录', record_id: '记录编号', evaluation_id: '研判记录',
  delivery_record_id: '发送记录', target_id: '关联目标记录', target_no: '目标编号', event_no: '事件编号',
  alarm_no: '告警编号', case_no: '案件编号', command_id: '指令记录', authorization_id: '授权记录',
  device_id: '设备记录', device_name: '设备名称', report: '报告内容', result: '记录结果',
  action: '操作', command_type: '指令类型', message: '记录说明', summary: '概要', items: '明细记录',
  target: '目标信息', points: '观测记录', longitude: '经度', latitude: '纬度', lon: '经度', lat: '纬度',
  altitude: '高度', alt: '高度', speed: '速度', heading: '航向', timestamp: '观测时间', t: '观测时间',
  can_write: '当时是否可登记', can_request_counter: '当时是否可申请反制', can_handoff: '当时是否可移送',
  can_retry: '当时是否可重试', counter_block_reason: '反制申请限制原因', handoff_block_reason: '移送限制原因',
};
const codes = {
  BLOCKED: '条件不满足，未执行', PENDING: '待处理', WAITING: '等待处理', SENDING: '发送中',
  SENT: '已发送，送达待确认', DELIVERED: '已送达', FAILED: '失败', UNKNOWN: '结果未知',
  SIMULATED_DELIVERED: '模拟送达', SIMULATED_SENT: '模拟发送', SIMULATED_FAILED: '模拟失败',
  SIMULATED_ACKNOWLEDGED: '模拟签收', ACKNOWLEDGED: '已签收', RECEIVED: '已接收',
  TIMEOUT: '超时', RECEIPT_TIMEOUT: '签收回执超时', NOT_SENT: '未发送', DISABLED: '未启用',
  SMS: '短信', VOICE: '电话录音通知', AUTO_SMS: '自动短信通知', SMS_NOTICE: '短信通知',
  SIMULATED: '模拟通道', SMS_SIMULATED: '模拟短信通知',
  PHONE: '电话', EMAIL: '电子邮件', MANUAL: '人工', AUTO: '自动', AUTOMATIC: '自动',
  MOCK: '模拟', mock: '模拟', replay: '回放', REPLAY: '回放', REAL: '真实通道', real: '真实通道',
  live: '实时接入', LIVE: '实时接入', COUNTERMEASURE: '反制', MANUAL_SUCCEEDED: '人工记录处置成功',
  REQUEST: '申请', APPROVE: '批准', REJECT: '驳回', MANUAL_RESULT: '现场结果登记',
  SUCCESS: '成功', SUCCEEDED: '成功', EXECUTING: '执行中', EXECUTED: '已执行',
};
const related = /(?:_id|_no|_version)$|^can_|^policy_code$|block_reason$/;
const isTime = key => /_at$/.test(key) || ['timestamp', 't'].includes(key);
function dateText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}
function valueText(value, key) {
  if (value == null || value === '') return '未记录';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (isTime(key)) return dateText(value);
  // 只在状态/类型字段翻译枚举，正文、接收人等原文保持不变。
  if (/status$|mode$|^channel$|^kind$|^action$|^result$|^command_type$|^trigger_source$/.test(key)) {
    return Object.hasOwn(codes, value) ? codes[value]
      : (/^[A-Z][A-Z0-9_]+$/.test(String(value)) ? `未识别的记录值（${value}）` : String(value));
  }
  return String(value);
}
function rowsFor(value, depth = 0) {
  if (depth > 12) return { rows: [], unmapped: 1 };
  if (value == null || typeof value !== 'object') return { rows: [{ label: '内容', value: valueText(value, '') }], unmapped: 0 };
  let unmapped = 0;
  const rows = [];
  for (const [key, item] of Object.entries(value)) {
    const label = Array.isArray(value) ? `第 ${Number(key) + 1} 条` : Object.hasOwn(fields, key) ? fields[key] : '';
    if (!label) { unmapped += 1; continue; }
    if (item != null && typeof item === 'object') {
      const child = rowsFor(item, depth + 1);
      unmapped += child.unmapped;
      rows.push({ label, children: child.rows, value: child.rows.length ? '' : Object.keys(item).length ? '内容尚未转为中文说明' : '无记录', secondary: related.test(key) });
    } else rows.push({ label, value: valueText(item, key), secondary: related.test(key) });
  }
  return { rows, unmapped };
}
function commandLog(text) {
  const lines = text.trim().split(/\r?\n/);
  const entries = lines.map(line => /^(\d{4}-\d{2}-\d{2}T\S+)\s+(REQUEST|APPROVE|REJECT|MANUAL_RESULT)\s+(.+)$/.exec(line));
  if (!entries.length || entries.some(entry => !entry)) return null;
  return entries.map(([, time, action, detail]) => ({ label: `${dateText(time)} · ${codes[action]}`,
    value: detail.split(/\s+/).map(token => Object.hasOwn(codes, token) ? codes[token] : token).join(' · ') }));
}
export function buildEvidenceDocument(text, mime, kind) {
  const raw = text.trim();
  const looksStructured = mime === 'application/json' || /^[\[{]/.test(raw);
  if (looksStructured) {
    try { return { ...rowsFor(JSON.parse(raw)), format: 'structured' }; }
    catch { return { format: 'unreadable', rows: [], unmapped: 0 }; }
  }
  const log = kind === 'COMMAND_LOG' && raw ? commandLog(raw) : null;
  return log ? { format: 'structured', rows: log, unmapped: 0 }
    : { format: 'text', text: raw, rows: [], unmapped: 0 };
}
