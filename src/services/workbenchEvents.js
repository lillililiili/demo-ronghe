/* “我的工作台”统一事件适配层。
 * 这里只统一入口、分类和待办提示，不改写三类业务各自的状态机。 */
const M = window.MOCK;
const EVT = window.EVT;

const DEVICE_STAGES = ['待处理', '处理中', '待验证', '已恢复'];
const deviceIncidents = new Map();

const LEVEL_RANK = { '超高风险': 5, '高风险': 4, '高': 4, '中风险': 3, '中': 3, '低风险': 2, '低': 2 };
const KIND_RANK = { uav: 3, risk: 2, device: 1 };
const BUCKET_RANK = { pending: 3, processing: 2, completed: 1 };
const MODULE_OF = { uav: '异常告警中心', risk: '空间安全风险', device: '设备实时监测' };
const kindLabel = { uav: '无人机告警', risk: '飞行计划风险', device: '设备告警' };
const RISK_OWNER = '飞行活动管理 · 全部风险事件';
const PLAN_STATUS_RANK = { '执行中': 4, '待执行': 3, '已完成': 2, '已终止': 1, '已取消': 0 };

function canRead(kind) { return M.can(MODULE_OF[kind], 'read'); }
function occurredTs(v) {
  if (Number.isFinite(v)) return v;
  const n = new Date(v || 0).getTime();
  return Number.isFinite(n) ? n : 0;
}
function deviceLevel(d) {
  if (d.status === '离线' || d.status === '异常' || (d.loss != null && d.loss > 15)) return '高';
  if (d.alarm || d.temp > 70 || d.latency > 100) return '中';
  return '低';
}
function deviceKind(d) {
  if (d.status === '离线') return '设备离线';
  if (d.status === '异常') return '设备异常';
  if (d.loss != null && d.loss > 15) return '接口异常';
  if (d.temp > 70) return '温度过高';
  if (d.latency > 100) return '网络抖动';
  return '设备告警';
}
function ensureDeviceIncidents() {
  M.devices.filter(d => d.status !== '在线' || d.alarm).forEach(d => {
    if (!deviceIncidents.has(d.id)) {
      deviceIncidents.set(d.id, {
        id: d.id, stage: '待处理', createdAt: d.hb || M.nowStr(),
        reason: deviceKind(d), updatedAt: d.hb || M.nowStr()
      });
    }
  });
  return deviceIncidents;
}
function deviceBucket(stage) {
  return stage === '已恢复' ? 'completed' : stage === '待处理' ? 'pending' : 'processing';
}
function uavSummary(id) {
  const ctx = EVT.of(id);
  if (!ctx || !ctx.alarm) return null;
  const td = EVT.todo(ctx);
  return {
    key: `uav:${id}`, kind: 'uav', kindLabel: kindLabel.uav, sourceId: id,
    title: ctx.alarm.type || ctx.target.violation || '无人机异常告警',
    level: ctx.alarm.level || (ctx.target.risk || '').replace('风险', ''),
    district: ctx.alarm.district || ctx.target.district,
    occurredAt: ctx.alarm.time || ctx.target.time, occurredTs: ctx.alarm.ts || ctx.target.ts,
    sourceStatus: EVT.phase(ctx),
    statusBucket: ctx.stage >= EVT.FLOW.length ? 'completed' : ctx.stage <= 2 ? 'pending' : 'processing',
    todo: td ? {
      action: td.btn, label: td.label, module: td.module || td.owner,
      permission: td.permission, allowed: td.allowed, blocker: td.blocker || ctx.blocked,
      hint: td.hint
    } : null
  };
}
function riskContext(r) {
  const route = r.nearestRouteId && M.routeById ? M.routeById(r.nearestRouteId) : null;
  const plans = route && M.plansOf ? M.plansOf(route.id).slice() : [];
  plans.sort((a, b) => (PLAN_STATUS_RANK[b.status] || 0) - (PLAN_STATUS_RANK[a.status] || 0)
    || Math.abs(new Date(a.start).getTime() - r.ts) - Math.abs(new Date(b.start).getTime() - r.ts));
  return { route, plans, plan: plans[0] || null };
}

function riskSteps(r) {
  if (r.status === '已排除') return [
    { n: '风险发现', done: true },
    { n: '人工核验', done: true },
    { n: '已排除', done: true, t: '误检或非管控目标' }
  ];
  const order = ['待核验', '待通知', '已通知'];
  const idx = Math.max(0, order.indexOf(r.status));
  const names = ['风险发现', '人工核验', '通知上级'];
  return names.map((n, i) => ({
    n,
    done: i === 0 || i <= idx,
    act: i === idx + 1 && r.status !== '已通知',
    t: i === 0 ? (r.time || '系统自动识别') : null
  }));
}

function riskTodoHint(r, action) {
  if (r.status === '待核验') return '核对目标类型、航线距离、高度重叠和计划时段，选择“核验通过”或“排除”。';
  if (r.status === '待通知') return '按飞行计划页“本航线风险”的同一入口生成通报与待回执记录。';
  if (r.status === '已通知') return '通报已发出，飞行计划风险事件已完成平台内闭环。';
  return action ? r.advice : '风险事件已闭环。';
}

function riskSummary(r) {
  const next = M.riskNext(r.status);
  const action = next[0] || null;
  const completed = ['已通知', '已排除'].includes(r.status);
  const pending = r.status === '待核验';
  const allowed = M.can('空间安全风险', 'op');
  const { route } = riskContext(r);
  const primaryAction = r.status === '待核验' ? '人工核验' : action && action.act;
  return {
    key: `risk:${r.id}`, kind: 'risk', kindLabel: kindLabel.risk, sourceId: r.id,
    title: `${route ? route.name : '未关联航线'} · ${r.subtype || r.type}风险`, level: r.level,
    district: r.district, occurredAt: r.time || r.date, occurredTs: r.ts,
    sourceStatus: r.status, statusBucket: completed ? 'completed' : pending ? 'pending' : 'processing',
    todo: action ? {
      action: primaryAction, label: primaryAction, to: action.to, module: RISK_OWNER,
      permission: 'op', allowed, blocker: allowed ? null : '需要「空间安全风险」操作权限',
      hint: riskTodoHint(r, action)
    } : null
  };
}
function deviceSummary(d, incident) {
  const allowed = M.can('设备实时监测', 'op');
  const verify = incident.stage === '待验证';
  return {
    key: `device:${d.id}`, kind: 'device', kindLabel: kindLabel.device, sourceId: d.id,
    title: incident.reason || deviceKind(d), level: deviceLevel(d), district: d.region,
    occurredAt: incident.createdAt, occurredTs: occurredTs(incident.createdAt),
    sourceStatus: incident.stage, statusBucket: deviceBucket(incident.stage),
    todo: incident.stage === '已恢复' ? null : {
      action: verify ? '恢复校验' : incident.stage === '处理中' ? '等待指令回执' : '远程重启',
      label: verify ? '确认恢复并关闭' : incident.stage === '处理中' ? '等待指令回执' : '远程重启',
      module: '设备实时监测', permission: 'op', allowed: allowed && incident.stage !== '处理中',
      blocker: !allowed ? '需要「设备实时监测」操作权限' : incident.stage === '处理中' ? '重启指令执行中，等待设备回执' : null,
      hint: verify ? '校验在线、心跳与健康状态后关闭事件' : '填写原因并二次确认后下发控制指令'
    }
  };
}

export function listWorkbenchEvents() {
  const out = [];
  if (canRead('uav')) {
    const seen = new Set();
    M.todayAlarms.slice().sort((a, b) => b.ts - a.ts).forEach(a => {
      if (seen.has(a.targetId)) return;
      seen.add(a.targetId);
      const e = uavSummary(a.targetId);
      if (e) out.push(e);
    });
  }
  if (canRead('risk')) M.riskEvents.forEach(r => out.push(riskSummary(r)));
  if (canRead('device')) {
    ensureDeviceIncidents().forEach((incident, id) => {
      const d = M.devices.find(x => x.id === id);
      if (d) out.push(deviceSummary(d, incident));
    });
  }
  return out.sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0)
    || (BUCKET_RANK[b.statusBucket] || 0) - (BUCKET_RANK[a.statusBucket] || 0)
    || (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0)
    || b.occurredTs - a.occurredTs);
}

export function workbenchStats(events = listWorkbenchEvents()) {
  return {
    pending: events.filter(e => e.statusBucket === 'pending').length,
    processing: events.filter(e => e.statusBucket === 'processing').length,
    completed: events.filter(e => e.statusBucket === 'completed').length,
    high: events.filter(e => ['超高风险', '高风险', '高'].includes(e.level)).length
  };
}

export function getWorkbenchDetail(key) {
  if (!key) return null;
  const [kind, id] = key.split(':');
  if (kind === 'uav') {
    const ctx = EVT.of(id);
    return ctx ? { kind, ctx, summary: uavSummary(id), steps: EVT.steps(ctx), timeline: timelineFor([id, ctx.alarm && ctx.alarm.id, ctx.kase && ctx.kase.id]) } : null;
  }
  if (kind === 'risk') {
    const risk = M.riskEvents.find(r => r.id === id);
    if (!risk) return null;
    const context = riskContext(risk);
    return {
      kind, risk, route: context.route, plans: context.plans, plan: context.plan,
      steps: riskSteps(risk), summary: riskSummary(risk), notices: M.noticesOf(id),
      disposals: risk.disposals || [], timeline: timelineFor([id, risk.targetId])
    };
  }
  const device = M.devices.find(d => d.id === id);
  const incident = ensureDeviceIncidents().get(id);
  return device && incident ? { kind, device, incident, summary: deviceSummary(device, incident), timeline: timelineFor([id]) } : null;
}

function timelineFor(ids) {
  const set = new Set(ids.filter(Boolean));
  return M.auditLogs.filter(a => set.has(a.target)).slice().sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 8);
}

export function advanceUav(key, note) {
  const id = key.replace(/^uav:/, '');
  const ctx = EVT.of(id);
  if (!ctx) return { ok: false, msg: '事件不存在' };
  return ctx.stage === 2 ? EVT.startLinkedCounter(ctx, { note }) : EVT.advance(ctx, note);
}

export function verifyUav(key, real, note) {
  const id = key.replace(/^uav:/, '');
  const ctx = EVT.of(id);
  return ctx ? EVT.verify(ctx, { real, note }) : { ok: false, msg: '事件不存在' };
}

export function actRisk(key, to, repaint) {
  const id = key.replace(/^risk:/, '');
  const risk = M.riskEvents.find(r => r.id === id);
  return risk && window.RISK_IMPL ? window.RISK_IMPL.act(risk, to, repaint) : false;
}

export function openDeviceReboot(key, hooks) {
  const id = key.replace(/^device:/, '');
  const d = M.devices.find(x => x.id === id);
  const incident = ensureDeviceIncidents().get(id);
  if (!d || !incident || !window.DEVICE_ACTIONS) return false;
  return window.DEVICE_ACTIONS.openReboot(d, {
    onStart(dev, log) {
      incident.stage = '处理中'; incident.updatedAt = log.at;
      if (hooks && hooks.onChange) hooks.onChange();
    },
    onAck(dev) {
      incident.stage = '待验证'; incident.updatedAt = M.nowStr();
      if (hooks && hooks.onChange) hooks.onChange();
    }
  });
}

export function verifyDeviceRecovery(key) {
  const id = key.replace(/^device:/, '');
  const d = M.devices.find(x => x.id === id);
  const incident = ensureDeviceIncidents().get(id);
  if (!d || !incident) return { ok: false, msg: '设备事件不存在' };
  if (!M.can('设备实时监测', 'op')) {
    M.pushAudit('设备实时监测', '恢复校验被拒绝：无操作权限', id, '失败');
    return { ok: false, msg: '需要「设备实时监测」操作权限' };
  }
  if (!window.DEVICE_ACTIONS.canVerify(d)) {
    M.pushAudit('设备实时监测', '恢复校验失败：在线、心跳或健康条件不满足', id, '失败');
    return { ok: false, msg: '恢复条件不满足：需设备在线、无告警、健康良好且心跳不超过 2 分钟' };
  }
  incident.stage = '已恢复'; incident.updatedAt = M.nowStr();
  M.pushAudit('设备实时监测', '恢复校验通过，设备事件关闭', id);
  window.dispatchEvent(new CustomEvent('device:changed', { detail: { id, phase: 'completed' } }));
  return { ok: true, msg: '恢复校验通过，设备事件已关闭' };
}

export { DEVICE_STAGES, kindLabel, riskSteps };
