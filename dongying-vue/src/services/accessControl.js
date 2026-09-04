import { authUser } from './auth.js';

const ROUTE_ALIAS = { overview: 'situation', risk: 'flights', airspace: 'flights' };
const ROUTE_PERMISSION = {
  situation: 'sensing', flights: 'flights', legality: 'legality', alarms: 'alarms', punish: 'punishment',
  stats: 'statistics', evidence: 'evidence', devices: 'devices', monitor: 'monitoring', commission: 'commissioning',
  apis: 'interfaces', users: 'users', roles: 'roles', archive: 'audit'
};

export function routeModule(routeKey) { return ROUTE_PERMISSION[ROUTE_ALIAS[routeKey] || routeKey] || null; }
export function hasPermission(code) { return !!authUser.value?.permission_codes?.includes(code); }

export function canAccessRoute(routeKey) {
  if (routeKey === '__ui-lab') return import.meta.env.DEV;
  if (routeKey === 'workbench') return true;
  const key = ROUTE_ALIAS[routeKey] || routeKey;
  if (key === 'bigscreen') return authUser.value?.menu_keys?.includes('bigscreen') || false;
  return authUser.value?.menu_keys?.includes(key) || false;
}

export function canRouteAction(routeKey, action = 'read') {
  const module = routeModule(routeKey);
  return !!(module && canAccessRoute(routeKey) && hasPermission(`${module}.${action}`));
}

export function accessBlocker(routeKey, action = 'read') {
  const module = routeModule(routeKey);
  if (!module) return '当前页面未配置访问权限';
  const label = action === 'auth' ? '授权' : action === 'op' ? '操作' : '查看';
  return `需要“${module}”${label}权限`;
}
