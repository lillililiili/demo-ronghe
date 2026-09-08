import { authUser } from './auth.js';
import { pageTitle } from '@/config/navModel.js';

const ROUTE_ALIAS = { overview: 'situation', risk: 'flights' };
const ROUTE_PERMISSION = {
  situation: 'sensing', flights: 'flights', airspace: 'airspace', risk: 'risk', legality: 'legality', alarms: 'alarms', punish: 'punishment',
  stats: 'statistics', evidence: 'evidence', devices: 'devices', monitor: 'monitoring', commission: 'commissioning',
  users: 'users', roles: 'roles', archive: 'audit'
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

/* 提示语给的是用户看得懂的页面名，不是权限模块编码（决策 12-14）：
   屏幕上出现 "需要"airspace"查看权限" 时，看到的人无从知道那指的是哪一页。 */
export function accessBlocker(routeKey, action = 'read') {
  const module = routeModule(routeKey);
  if (!module) return '当前页面未配置访问权限';
  const label = action === 'auth' ? '授权' : action === 'op' ? '操作' : '查看';
  return `需要“${pageTitle(routeKey)}”的${label}权限`;
}
