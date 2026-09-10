export const MODULE_LABELS = {
  authentication: '认证登录',
  users: '用户管理',
  roles: '角色管理',
  audit: '审计日志',
  devices: '设备管理',
  alarms: '告警事件',
  statistics: '运行统计',
  risk: '飞行风险', handoff: '业务交接', workbench: '工作台', assessment: '合法性研判', rules: '规则引擎', flights: '飞行计划',
  airspace: '空域规则', fusion: '融合感知', disposal: '处置授权', punishment: '处罚案件', evidence: '证据管理', airport: '机场基础数据',
  mqtt: '设备接入',
  system: '系统'
};

export const ACTION_LABELS = {
  login_success: '登录成功',
  login_fail: '登录失败',
  logout: '退出登录',
  password_changed: '修改密码',
  user_created: '创建用户',
  user_deleted: '删除用户',
  user_profile_updated: '更新用户资料',
  user_status_changed: '变更用户状态',
  user_password_reset: '重置用户密码',
  user_access_updated: '调整用户角色',
  user_creation_requested: '申请创建用户',
  user_access_requested: '申请调整用户权限',
  organization_created: '创建组织',
  organization_updated: '更新组织',
  organization_status_changed: '变更组织状态',
  organization_deleted: '删除组织',
  district_created: '创建区域',
  district_updated: '更新区域',
  district_status_changed: '变更区域状态',
  role_created: '创建角色',
  role_description_updated: '更新角色说明',
  role_permissions_updated: '更新角色权限',
  role_deleted: '删除角色',
  role_access_requested: '申请调整角色权限',
  role_deletion_requested: '申请删除角色',
  access_change_approved: '批准权限变更',
  access_change_rejected: '驳回权限变更',
  audit_export_requested: '导出审计日志',
  stats_export_requested: '导出运行统计',
  super_admin_recovered: '恢复超级管理员',
  uav_event_verified: '核实无人机事件', risk_verified: '核验飞行风险', handoff_created: '提交业务交接',
  legality_evaluation_revised: '复核合法性研判', legality_evaluation_recomputed: '重新研判', legality_evaluation_escalated: '研判转告警', legality_evaluation_triggered: '手动触发研判',
  rule_set_activated: '激活规则集版本', rule_set_rolled_back: '回滚规则集版本', rule_set_shadow_changed: '调整规则集阴影版本',
  target_class_revised: '修订目标类别', targets_merged: '合并目标', target_split: '分裂目标', fusion_config_activated: '激活融合参数版本',
  evidence_ingested: '入库证据文件', evidence_linked: '关联证据对象', evidence_hold_placed: '冻结证据', evidence_hold_released: '解除证据冻结', evidence_verified: '校验证据文件', evidence_downloaded: '下载证据文件', evidence_exported: '导出证据台账', evidence_destroyed: '销毁证据文件',
  alarms_exported: '导出告警列表', risks_exported: '导出风险列表',
  disposal_requested: '申请处置授权', disposal_approved: '批准处置授权', disposal_rejected: '驳回处置授权', disposal_executed: '执行处置', disposal_stopped: '停止处置', disposal_cancelled: '撤回处置申请', disposal_manual_result: '登记人工处置结果',
  punishment_case_filed: '立案', punishment_case_assigned: '指派承办人', punishment_lead_added: '登记待补充线索', punishment_lead_resolved: '线索已补充', punishment_discretion_drafted: '拟定裁量', punishment_discretion_confirmed: '确认裁量', punishment_reviewed: '复核定性依据', punishment_decision_issued: '出具处罚决定书', punishment_decision_revoked: '作废处罚决定书', punishment_case_closed: '结案', punishment_case_withdrawn: '撤案',
  airspace_created: '新建空域', airspace_version_created: '新增空域版本', airspace_import_staged: '暂存空域导入', airspace_import_confirmed: '确认空域导入', airspace_import_discarded: '放弃空域导入',
  airport_created: '新建机场', airport_runway_created: '新增跑道', airport_procedure_route_created: '新增进离场航线', airport_protected_target_created: '新增保护目标', airport_notification_target_created: '新增通报对象',
  rule_evaluation_triggered: '手动触发空间风险评估', eo_track_requested: '下发光电跟踪', eo_track_ended: '停止光电跟踪',
  mqtt_broker_create: '登记消息接入连接', mqtt_broker_enable: '启用消息接入连接', mqtt_broker_disable: '停用消息接入连接', mqtt_broker_update: '修改消息接入连接', mqtt_device_register: '登记接入设备', mqtt_device_bind: '绑定接入设备',
  device_created: '登记设备', device_updated: '修改设备', device_enabled: '启用设备', device_disabled: '停用设备', device_command_issued: '下发设备指令', device_incident_rebooted: '远程重启设备', device_incident_recovered: '确认设备恢复',
  countermeasure_command_issued: '下发反制指令', commission_task_created: '创建调测任务', commission_task_cancelled: '取消调测任务',
  device_incident_recovery_checked: '检查设备恢复', device_incident_rebooted: '远程重启设备'
};

const METHOD_LABELS = { GET: '查询', POST: '提交', PUT: '更新', PATCH: '更新', DELETE: '删除' };
const PATH_LABELS = [
  ['/organizations', '组织'],
  ['/districts', '区域'],
  ['/users', '用户'],
  ['/roles', '角色'],
  ['/permissions', '权限'],
  ['/audit-logs', '审计日志'],
  ['/auth', '认证'],
  ['/devices', '设备'],
  ['/commission', '设备调测'],
  ['/alarms', '告警'],
  ['/stats', '运行统计']
];

export const moduleOptions = Object.entries(MODULE_LABELS).map(([value, label]) => ({ value, label }));
export const actionOptions = Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }));

export function moduleText(code) {
  return MODULE_LABELS[code] || code || '—';
}

export function actionText(action) {
  if (!action) return '—';
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i.exec(action);
  if (!match) return action;
  const method = METHOD_LABELS[match[1].toUpperCase()] || match[1];
  const resource = PATH_LABELS.find(([prefix]) => match[2].includes(prefix));
  return resource ? `${method}${resource[1]}` : `${method}接口`;
}

export function roleText(code, names = {}) {
  if (!code) return '—';
  if (names[code]) return names[code];
  if (code === 'ROLE-ADMIN') return '超级管理员';
  return '自定义角色';
}
