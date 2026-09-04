export const MODULE_LABELS = {
  authentication: '认证登录',
  users: '用户管理',
  roles: '角色管理',
  audit: '审计日志',
  devices: '设备管理',
  alarms: '告警事件',
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
  super_admin_recovered: '恢复超级管理员'
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
  ['/alarms', '告警']
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
