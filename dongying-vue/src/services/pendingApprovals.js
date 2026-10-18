/* 顶栏“待我审批”（2026-10-18 rose 确认，流程 5）：审批员登录后不用自己找“告警事件 → 反制办理 → 待我处理”。
   只读现有授权列表接口（GET /disposal-authorizations?status=REQUESTED），按服务端给每条记录的 allowed_actions
   数出当前账号能审批、且不是自己申请的条数；数据范围、权限都由服务端裁剪，这里不扩大任何权限，也不推进状态。 */
import { primaryCode } from '../pages/alarms/authorizationQueueView.js';

export const PENDING_APPROVAL_PAGE_SIZE = 100;
export const PENDING_APPROVAL_MAX_PAGES = 5;

/** 顶栏只对能审批、能查看授权、能进告警事件页的账号显示。 */
export function canSeePendingApprovals(can, canRoute) {
  return can('disposal:approve') && can('disposal:read') && canRoute('alarms');
}

/**
 * @param {(params:object)=>Promise<{items:Array,total:number}>} list disposalApi.list
 * @param {string} userId 当前账号
 * @param {() => boolean} [isCurrent]
 * @returns {Promise<{ count:number, more:boolean }|null>} more 表示待审批太多、没有全部数完（显示为“N+”）；页面已失效返回 null
 */
export async function countPendingApprovals(list, userId, isCurrent = () => true) {
  let count = 0, seen = 0, total = null;
  for (let page = 1; page <= PENDING_APPROVAL_MAX_PAGES; page++) {
    const data = await list({ status: 'REQUESTED', page, size: PENDING_APPROVAL_PAGE_SIZE });
    if (!isCurrent()) return null;
    if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('待审批数据不完整');
    total = data.total;
    count += data.items.filter(row => primaryCode(row, userId) === 'APPROVE').length;
    seen += data.items.length;
    if (seen >= total || !data.items.length) return { count, more: false };
  }
  return { count, more: seen < total };
}

/** 顶栏上的数字：没有待审批时不显示。 */
export function pendingApprovalText(result) {
  if (!result || !(result.count > 0)) return '';
  return `待我审批 ${result.count}${result.more ? '+' : ''}`;
}
