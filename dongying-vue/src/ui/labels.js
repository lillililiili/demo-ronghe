/* 业务代码 → 中文文案字典（全站共用）。
   规则：页面只展示名称与业务编号，内部 ID 只能进 title 提示；未收录的代码原样返回，不猜测含义。 */
export const SOURCE_MODE_LABEL = { mock: '模拟', replay: '回放', live: '实时' };
export const ALARM_TYPE_LABEL = { UAV_INTRUSION: '无人机入侵', UAV: '无人机告警' };
export const RISK_TYPE_LABEL = { FLIGHT_OPERATION: '飞行作业风险', AIRSPACE: '空域风险', FOREIGN_OBJECT: '空中异物风险' };
export const REASON_CODE_LABEL = {
  ROUTE_DEVIATION: '偏离报备航线', AIRSPACE_CONFLICT: '空域冲突', ALTITUDE_UNKNOWN: '高度信息缺失', SOURCE_MISMATCH: '来源不一致',
  PROHIBITED_AIRSPACE_OVERLAP: '穿越禁飞空域', ALTITUDE_DATUM_OR_RANGE_UNKNOWN: '高度基准或范围未知', CORRIDOR_WIDTH_UNKNOWN: '航线走廊宽度未知',
  TIME_UNTRUSTED: '时间不可信', LOCATION_UNTRUSTED: '位置不可信'
};
export const PLAN_STATUS_LABEL = { PENDING: '待执行', APPROVED: '已批准', EXECUTING: '执行中', COMPLETED: '已完成', CANCELLED: '已取消' };
export const HANDOFF_TYPE_LABEL = { RISK_NOTICE: '风险通报', UAV_PUNISHMENT: '处罚交接' };
export const HANDOFF_KIND_LABEL = { RISK: '飞行风险', UAV_EVENT: '无人机事件', DEVICE_INCIDENT: '设备异常' };
export const OBJECT_TYPE_LABEL = { UAV: '无人机', BIRD: '鸟类', UNKNOWN: '未分类' };
/* 气球、风筝、孔明灯只能是算法推断的 subtype，不是设备可上报的目标类型（V1.1 任务书 A4）。 */
export const INFERRED_SUBTYPE_LABEL = { BALLOON: '气球', KITE: '风筝', LANTERN: '孔明灯' }; // subtype 推断
export const SUBTYPE_LABEL = {
  ...INFERRED_SUBTYPE_LABEL,
  QUADCOPTER: '多旋翼无人机', FIXED_WING: '固定翼无人机', VTOL: '垂直起降固定翼', HELICOPTER: '直升机型无人机',
  MIGRATORY_BIRD: '候鸟', BIRD_FLOCK: '鸟群', RAPTOR: '猛禽'
};
export const CONCLUSION_LABEL = { CONFIRMED: '核实属实', EXCLUDED: '已排除', FALSE_POSITIVE: '误报', EVIDENCE_REQUIRED: '证据待补充' };
export const RULE_RESULT_LABEL = { PASS: '通过', FAIL: '不通过', UNDETERMINED: '不可判定' };
export const LEGALITY_LABEL = { LEGAL: '合法', ILLEGAL: '非法', UNDETERMINED: '待确认' };

/** 取中文文案；代码为空返回 fallback，未收录返回代码本身。 */
export const labelOf = (map, code, fallback = '—') => (code == null || code === '' ? fallback : (map[code] || String(code)));
/** 目标类型文案：优先细分类型，其次大类。 */
export const targetTypeLabel = (subtype, objectType, fallback = '—') =>
  subtype ? labelOf(SUBTYPE_LABEL, subtype) : labelOf(OBJECT_TYPE_LABEL, objectType, fallback);
