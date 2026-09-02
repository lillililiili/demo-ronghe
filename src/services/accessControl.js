/* 外壳与业务页共用的权限映射。业务名称仍来自 mock.js 的 ROUTE_MODULES，
   此处只处理 Vue 路由别名和面向界面的阻断文案，不复制权限矩阵。 */
const M = window.MOCK;

export function routeModule(routeKey) {
  return M.ROUTE_MODULES[routeKey] || null;
}

export function canAccessRoute(routeKey) {
  if (routeKey === '__ui-lab') return import.meta.env.DEV;
  return M.canMenu(routeKey);
}

export function canRouteAction(routeKey, action = 'read') {
  const moduleName = routeModule(routeKey);
  return !!(moduleName && canAccessRoute(routeKey) && M.can(moduleName, action));
}

export function accessBlocker(routeKey, action = 'read') {
  const moduleName = routeModule(routeKey);
  if (!moduleName) return '当前页面未配置访问权限';
  const label = action === 'auth' ? '授权' : action === 'op' ? '操作' : '查看';
  return `需要「${moduleName}」${label}权限`;
}
