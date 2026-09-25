/** The four display categories do not rewrite historical file kinds. */
export const EVIDENCE_CATEGORY_LABEL = { VIDEO: '录像', TRACK: '轨迹', IMAGE: '图片', COMMAND: '指令' };
export const COMMAND_STATE_LABEL = { QUEUED: '排队中', SENT: '已下发', ACCEPTED: '设备已受理', SUCCEEDED: '执行完成', FAILED: '执行失败', TIMED_OUT: '回执超时', CANCELLED: '已取消' };
export const COMMAND_TYPE_LABEL = { EO_BEGIN_TRACK: '开始光电跟踪', EO_END_TRACK: '结束光电跟踪', EO_TRACK_BEGIN: '开始光电跟踪', EO_TRACK_END: '结束光电跟踪', LINGYUN_CONTROL: '设备控制', COUNTERMEASURE_4CH: '四通道控制', EMERGENCY_STOP: '设备急停' };
export const entryKey = row => row ? `${row.source_kind}:${row.source_id}` : '';
export const evidenceRecordQuery = (row, context = {}) => ({ ...context, [row.source_kind === 'FILE' ? 'file' : row.source_kind === 'TRACK' ? 'track' : 'command']: row.source_id });
export function evidenceSubjectLocation(kind, id) {
  if (!id) return null;
  if (kind === 'EVENT') return { path: '/alarms', query: { event: id } };
  if (kind === 'TARGET') return { path: '/situation', query: { target: id } };
  if (kind === 'PLAN') return { path: '/flights', query: { plan: id } };
  if (kind === 'AUTHORIZATION') return { path: '/alarms', query: { tab: 'authorizations', authorization: id } };
  return null;
}
