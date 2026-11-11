import { airspaceApi } from '@/services/airspaceApi.js';

export async function readMapRegionContext(pointer) {
  if (!pointer) {
    const response = await fetch('/map-data/control/map-config.json', { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('当前地图运行配置读取失败，请刷新重试。');
    pointer = await response.json();
  }
  if (!pointer?.package_id || !Number.isSafeInteger(pointer.revision)) throw new Error('当前地图尚未发布区域配置，可查看全部授权空域。');
  const context = await airspaceApi.mapContext({ package_id: pointer.package_id, revision: pointer.revision });
  if (context.runtime?.package_id !== pointer.package_id || context.runtime?.revision !== pointer.revision) {
    throw new Error('地图版本已变化，请刷新读取当前区县资料。');
  }
  return { ...context, runtime_pointer: pointer };
}

export function regionQuery(context, district = '') {
  if (!context?.runtime || !context.business_available) throw new Error('当前地图的业务数据不可用。');
  return { map_package_id: context.runtime.package_id, map_revision: context.runtime.revision,
    ...(district ? { map_district_code: district } : {}) };
}

export function coveredDistrictOptions(context) {
  if (context?.state !== 'READY') return [];
  return [{ value: '', label: '全部覆盖区县' }, ...(context.districts || [])
    .filter(row => ['FULL', 'PARTIAL'].includes(row.coverage))
    .map(row => ({ value: row.district_code, label: `${row.name}${row.coverage === 'PARTIAL' ? '（部分覆盖）' : ''}` }))];
}

export function boundsPoints(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    ? [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] : [];
}

// 仅用于视口定位及提示。业务空间筛选由服务端完成，不以此函数作权限/归属判断。
export function visibleExtent(points, bounds) {
  if (!points.length || !boundsPoints(bounds).length) return null;
  const extent = points.reduce((out, [x, y]) => [Math.min(out[0], x), Math.min(out[1], y), Math.max(out[2], x), Math.max(out[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const clipped = [Math.max(extent[0], bounds[0]), Math.max(extent[1], bounds[1]), Math.min(extent[2], bounds[2]), Math.min(extent[3], bounds[3])];
  return clipped[0] <= clipped[2] && clipped[1] <= clipped[3] ? clipped : null;
}
