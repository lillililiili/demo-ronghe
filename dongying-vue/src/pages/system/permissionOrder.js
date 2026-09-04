import { pageTitle } from '@/config/navModel.js';

const SYSTEM_TAIL = ['users', 'roles', 'audit'];
const HEADER_MENU_LABEL = { bigscreen: '数据大屏' };

export function menuLabelOf(routeKey) {
  if (!routeKey) return '';
  return HEADER_MENU_LABEL[routeKey] || pageTitle(routeKey);
}

export function withSystemPermissionsLast(items) {
  return items.slice().sort((a, b) => {
    const ia = SYSTEM_TAIL.indexOf(a.permission_code);
    const ib = SYSTEM_TAIL.indexOf(b.permission_code);
    if (ia >= 0 || ib >= 0) {
      if (ia < 0) return -1;
      if (ib < 0) return 1;
      return ia - ib;
    }
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });
}
