/* 工作台只读聚合接口适配：只经 apiRequest 访问服务端，返回解包后的 data。
   工作台没有写接口；核实走 alarmApi/riskApi，通知走 handoffApi（由领导接线）。失败由页面显示，不回退 window.MOCK。 */
import { apiRequestTimed, buildQuery } from '@/services/apiClient.js';

export const WORKBENCH_KINDS = ['UAV_EVENT', 'RISK', 'DEVICE_INCIDENT'];

/** GET /workbench/items；query 只接受契约字段：kind,state,severity,occurred_from,occurred_to,owner_org_id,district_id,source_mode,page,size */
export function listWorkbenchItems(query = {}) {
  return apiRequestTimed(`/workbench/items${buildQuery(query)}`);
}

/** GET /workbench/items/{kind}/{source_id}；返回 { item, timeline, availability } */
export function getWorkbenchItem(kind, sourceId) {
  return apiRequestTimed(`/workbench/items/${encodeURIComponent(kind)}/${encodeURIComponent(sourceId)}`);
}
