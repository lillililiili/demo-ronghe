/* 业务代码 → 中文文案字典（全站共用）。
   规则：页面只展示名称与业务编号，内部 ID 只能进 title 提示；未收录的代码原样返回，不猜测含义。 */
export const SOURCE_MODE_LABEL = { mock: '模拟', replay: '回放', live: '实时' };
export const ALARM_TYPE_LABEL = { UAV_INTRUSION: '无人机入侵', UAV: '无人机告警' };
// SPACE_OBJECT 是阶段 9 C04 评估写入的风险类型；FOREIGN_OBJECT 是同一业务概念的早期写法，两者中文一致。
export const RISK_TYPE_LABEL = { FLIGHT_OPERATION: '飞行作业风险', AIRSPACE: '空域风险', SPACE_OBJECT: '空中异物风险', FOREIGN_OBJECT: '空中异物风险' };
export const REASON_CODE_LABEL = {
  ROUTE_DEVIATION: '偏离报备航线', AIRSPACE_CONFLICT: '空域冲突', ALTITUDE_UNKNOWN: '高度信息缺失', SOURCE_MISMATCH: '来源不一致',
  PROHIBITED_AIRSPACE_OVERLAP: '穿越禁飞空域', ALTITUDE_DATUM_OR_RANGE_UNKNOWN: '高度基准或范围未知', CORRIDOR_WIDTH_UNKNOWN: '航线走廊宽度未知',
  TIME_UNTRUSTED: '时间不可信', LOCATION_UNTRUSTED: '位置不可信'
};
export const PLAN_STATUS_LABEL = { PENDING: '待执行', APPROVED: '已批准', EXECUTING: '执行中', COMPLETED: '已完成', CANCELLED: '已取消' };
export const HANDOFF_TYPE_LABEL = { RISK_NOTICE: '风险通报', UAV_PUNISHMENT: '处罚交接' };
export const HANDOFF_KIND_LABEL = { RISK: '飞行风险', UAV_EVENT: '无人机事件', DEVICE_INCIDENT: '设备异常' };
/* PERSON/VEHICLE/SHIP/REMOTE_CONTROLLER 来自凌云协议 A 的 objectType（阶段 8.5 直连切片）。 */
export const OBJECT_TYPE_LABEL = {
  UAV: '无人机', BIRD: '鸟类', UNKNOWN: '未分类',
  PERSON: '人员', VEHICLE: '车辆', SHIP: '船只', REMOTE_CONTROLLER: '遥控器'
};
/* 来源类型中文取自 source_type_catalog.display_name（迁移 050 与 070），同一个码全站只有一个说法。 */
export const SOURCE_TYPE_LABEL = {
  RADAR: '雷达', EO: '光电', TDOA: 'TDOA', FIVE_G_A: '5G-A 基站', FUSION_BOX: '融合感知箱',
  AOA: '无线电测向（AOA）', DCD: '协议破解', RID: 'RemoteID'
};
/* 来源接入状态：DEMO 表示字段有协议出处但尚未与真实设备联调，页面必须说清楚，不能让人当成已核实的能力。 */
export const SCHEMA_STATUS_LABEL = { CONFIRMED: '已联调确认', DEMO: '按凌云协议 v8.6 建模，待联调' };
/* 处置授权（阶段 13）：动作、状态、执行通道。同一个码全站只有一个说法，页面一律经 labelOf 取词。 */
export const DISPOSAL_ACTION_LABEL = { COUNTERMEASURE: '联动反制', JAMMING: '信号干扰', DISPERSAL: '驱离', DECOY: '诱骗' };
/* 状态回答“现在在哪一步”，与执行结果（成功/失败）分开说，不要混成一句。 */
export const DISPOSAL_STATUS_LABEL = {
  REQUESTED: '待审批', APPROVED: '已批准', REJECTED: '已驳回', EXECUTING: '执行中',
  COMPLETED: '已完成', FAILED: '执行失败', STOPPED: '已停止', EXPIRED: '已过期', CANCELLED: '已撤销'
};
export const DISPOSAL_CHANNEL_LABEL = { LINGYUN_B: '凌云协议 B 设备', COUNTERMEASURE_4CH: '四通道反制设备', MANUAL: '人工执行' };
export const DISPOSAL_RESULT_LABEL = { SUCCEEDED: '执行成功', FAILED: '执行失败' };
/* 决策 13-10/13-11：STOPPED 不能只说“已停止”——撤销授权与设备是否真的急停是两件事，必须带限定语。 */
export const DISPOSAL_STOP_RESULT_LABEL = {
  EXECUTED: '授权已撤销；设备急停已受理',
  UNAVAILABLE: '授权已撤销；设备急停未执行（协议未提供）',
  NOT_ATTEMPTED: '授权已撤销；未尝试设备急停',
  NOT_BOUND: '授权已撤销；设备未登记凌云连接，请运维补配置后重试'
};
/* 授权事件流的动作名：事件流直接上屏，枚举必须翻成中文（技能 writing-user-readable-ui-text）。 */
export const DISPOSAL_EVENT_KIND_LABEL = {
  REQUEST: '发起申请', APPROVE: '批准', REJECT: '驳回', EXECUTE: '下发执行', RECEIPT: '设备回执',
  STOP: '停止', COMPLETE: '完成', FAIL: '失败', EXPIRE: '超时失效', CANCEL: '撤销',
  MANUAL_RESULT: '登记人工结果', DEVICE_STOP_UNAVAILABLE: '设备急停不可用', DEVICE_CONTROL_UNAVAILABLE: '设备控制不可用'
};
/* 决策 13-12/13-14：执行被阻的四种原因，三种可补救、一种要等厂家；页面不得把它显示成失败或成功。 */
export const DISPOSAL_BLOCK_REASON_LABEL = {
  DEVICE_CAPABILITY: '该设备不支持自动执行，可登记人工结果',
  PROTOCOL_NOT_OPENED: '该类指令码尚未开放（等厂家确认设备类型），可登记人工结果',
  NOT_BOUND: '设备未登记凌云连接，请运维补登记后重试',
  DEVICE_OFFLINE: '设备当前离线或未启用，请恢复后重试'
};

/* 目标类别是哪一路给的：观测的 class_source（阶段 8.5）。 */
export const CLASS_SOURCE_LABEL = { SENSE_DATA: '感知数据', EO_TRACKING: '光电跟踪', RADAR: '雷达分类', MANUAL: '人工修订' };
/* 气球、风筝、孔明灯只能是算法推断的 subtype，不是设备可上报的目标类型（V1.1 任务书 A4）。 */
export const INFERRED_SUBTYPE_LABEL = { BALLOON: '气球', KITE: '风筝', LANTERN: '孔明灯' }; // subtype 推断
export const SUBTYPE_LABEL = {
  ...INFERRED_SUBTYPE_LABEL,
  QUADCOPTER: '多旋翼无人机', FIXED_WING: '固定翼无人机', VTOL: '垂直起降固定翼', HELICOPTER: '直升机型无人机',
  MIGRATORY_BIRD: '候鸟', BIRD_FLOCK: '鸟群', RAPTOR: '猛禽'
};
export const CONCLUSION_LABEL = { CONFIRMED: '核实属实', EXCLUDED: '已排除', FALSE_POSITIVE: '误报', EVIDENCE_REQUIRED: '证据待补充' };
/* 飞行风险核验的结论用词与无人机事件不同（核验通过 → 转待通知），与 FlightsPage、riskVerificationModal 保持一致。 */
export const RISK_CONCLUSION_LABEL = { CONFIRMED: '核验通过', EXCLUDED: '已排除' };
export const DELIVERY_STATUS_LABEL = { PENDING_DELIVERY: '待投递', SUBMITTED: '已发送', DELIVERED: '已送达', FAILED: '发送失败' };
export const RECEIPT_STATUS_LABEL = { NOT_EXPECTED: '不需回执', PENDING: '等待回执', ACKNOWLEDGED: '已回执', TIMEOUT: '回执超时' };
/* HANDOFF_MATERIALS_NOT_DEFINED（决策 13-25）：反制/干扰完成事实已经有了，卡住的是处罚交接的材料包定义，
   与“通知渠道未接通”不是一回事，两句必须分开说。 */
export const HANDOFF_BLOCKED_LABEL = {
  CHANNEL_NOT_CONNECTED: '通知渠道未接通',
  HANDOFF_MATERIALS_NOT_DEFINED: '处罚交接的材料包尚未定义，暂不能提交'
};
export const SEVERITY_LABEL = { CRITICAL: '紧急', HIGH: '高', MEDIUM: '中', LOW: '低' };
export const SEVERITY_TAG = { CRITICAL: 't-red', HIGH: 't-red', MEDIUM: 't-amber', LOW: 't-blue' };
export const RISK_STATE_LABEL = { PENDING_VERIFICATION: '待核验', PENDING_NOTIFICATION: '待通知', NOTIFIED: '已通知', EXCLUDED: '已排除' };
/** 版本号翻译成次数：version 0 表示尚未核实，返回空串由调用方整段不渲染。 */
/* 阶段 9 空间安全风险：异物细类、高度带与走廊关系。
   气球/风筝/孔明灯只在细类语境出现，与 INFERRED_SUBTYPE_LABEL 同义但键不同（服务端字典码）。 */
export const SPACE_OBJECT_SUBTYPE_LABEL = {
  BIRD_FLOCK: '鸟群', BALLOON: '气球', KITE: '风筝', SKY_LANTERN: '孔明灯', OTHER_OBJECT: '其他异物' // subtype 字典
};
export const ALTITUDE_BAND_LABEL = { CLIMB: '起降爬升段', APPROACH: '进近段', CRUISE: '巡航段', UNKNOWN: '高度未知' };
export const CORRIDOR_RELATION_LABEL = { INSIDE: '航线走廊内', NEAR: '邻近航线', OUTSIDE: '走廊外', UNKNOWN: '距离未知' };
export const OBJECT_TREND_LABEL = { RISING: '数量上升', FLAT: '数量平稳', FALLING: '数量下降', UNKNOWN: '趋势未知' };
export const verificationOrdinal = (version, prefix = '') => (version == null || Number(version) <= 0 ? '' : `${prefix}第${Number(version)}次核实`);
export const RULE_RESULT_LABEL = { PASS: '通过', FAIL: '不通过', UNDETERMINED: '不可判定' };
// UNDETERMINED 是引擎判不了，不是等人来确认：与 LegalityPage、复核弹窗保持同一个说法。
export const LEGALITY_LABEL = { LEGAL: '合法', ABNORMAL: '异常', ILLEGAL: '非法', UNDETERMINED: '不可判定', NOT_APPLICABLE: '不适用' };
// 阶段 9 计划与实际对照：段可用性、计划匹配、高度关系与外部授权登记。
export const SECTION_AVAILABILITY_LABEL = { FORBIDDEN: '无权限查看', NO_EVALUATION: '尚无引擎研判', UNAVAILABLE: '暂不可用' };
export const PLAN_MATCH_LABEL = { FULL: '完全匹配', PARTIAL: '部分匹配', NONE: '无匹配计划', UNDETERMINED: '不可判定', NOT_APPLICABLE: '不适用' };
export const ALTITUDE_RELATION_LABEL = {
  ABOVE: '高于计划高度带', WITHIN: '在计划高度带内', BELOW: '低于计划高度带', UNDETERMINED: '不可判定'
};
export const AUTHORIZATION_SOURCE_LABEL = { MANUAL: '人工登记', IMPORT: '批量导入' };
export const EVIDENCE_KIND_LABEL = {
  EO_VIDEO: '光电录像', EO_STILL: '光电抓拍图', TRACK_SNAPSHOT: '雷达轨迹快照',
  NOTICE_RECEIPT: '通报单回执', COMMISSION_REPORT: '调测报告', COMMAND_LOG: '指令报文与回执',
  SCENE_PHOTO: '现场照片', PENALTY_DOCUMENT: '处罚文书'
};
export const EVIDENCE_STATUS_LABEL = {
  PENDING: '入库中', AVAILABLE: '在库', MISSING: '文件缺失', CORRUPT: '哈希不符', DESTROYED: '已销毁'
};
export const EVIDENCE_CUSTODY_LABEL = {
  KEPT: '保管中', NEARING: '临近到期', DUE: '已到期', HELD: '冻结保管'
};
export const EVIDENCE_CUSTODY_TAG = {
  KEPT: 't-green', NEARING: 't-amber', DUE: 't-orange', HELD: 't-purple'
};
export const EVIDENCE_SUBJECT_LABEL = {
  EVENT: '无人机事件', DEVICE: '设备', TARGET: '感知目标', PLAN: '飞行计划',
  COMMAND: '指令', COMMISSION: '调测任务'
};
export const EVIDENCE_RECORD_TYPE_LABEL = {
  TRACK: '轨迹', VIDEO: '视频', IMAGE: '图像', ALARM: '告警',
  JUDGMENT: '判定', AUTHORIZATION: '授权', DISPOSAL: '处置', OPERATION: '操作'
};
export const EVIDENCE_COVERAGE_LABEL = { PRESENT: '已收录', ABSENT: '缺失', FORBIDDEN: '无权限' };

/* 阶段 9 空域种类：页面的图层配色与筛选都以这个字典为准，历史写法（HEIGHT_LIMIT/TEMPORARY）一并收录，
   便于旧数据在页面上仍有中文，不影响写接口只接受规范值。 */
export const AIRSPACE_KIND_LABEL = {
  PROHIBITED: '禁飞区', RESTRICTED: '限制区', ALTITUDE_LIMIT: '限高区', PERMITTED: '适飞区', TEMPORARY_CONTROL: '临时管制区',
  HEIGHT_LIMIT: '限高区', TEMPORARY: '临时管制区'
};
/** 空域图层配色：禁飞与限制用红系，限高用橙系，适飞用蓝系，临时管制用紫系。 */
export const AIRSPACE_KIND_TAG = {
  PROHIBITED: 't-red', RESTRICTED: 't-red', ALTITUDE_LIMIT: 't-amber', PERMITTED: 't-blue', TEMPORARY_CONTROL: 't-gray',
  HEIGHT_LIMIT: 't-amber', TEMPORARY: 't-gray'
};
export const AIRSPACE_KIND_COLOR = {
  PROHIBITED: '#ff4d5e', RESTRICTED: '#ff7a45', ALTITUDE_LIMIT: '#ffb020', PERMITTED: '#3d8bff', TEMPORARY_CONTROL: '#a97bff',
  HEIGHT_LIMIT: '#ffb020', TEMPORARY: '#a97bff'
};
export const ALTITUDE_DATUM_LABEL = { AGL: '离地高度', AMSL: '海拔高度' };
export const AIRSPACE_VALIDITY_LABEL = { ACTIVE: '生效中', SUPERSEDED: '已被接替', SCHEDULED: '未生效', EXPIRED: '已失效' };
/** 版本来源：谁把这一版放进来的。 */
export const AIRSPACE_ORIGIN_LABEL = { MANUAL: '人工新建', GEOJSON_IMPORT: '文件导入', SEED: '演示数据' };
export const IMPORT_STATUS_LABEL = { STAGED: '待确认', CONFIRMED: '已确认', DISCARDED: '已放弃' };
/** 导入被拒绝的原因：每条都要能让操作者知道该改文件的哪一处。 */
export const IMPORT_ISSUE_LABEL = {
  GEOMETRY_MISSING: '缺少边界几何', GEOMETRY_INVALID: '边界几何无效', GEOMETRY_NOT_SUPPORTED: '边界只支持面或多面',
  RING_NOT_CLOSED: '边界闭合环未闭合', RING_TOO_SHORT: '边界至少需要三个顶点', COORDINATE_INVALID: '坐标不是数字',
  COORDINATE_OUT_OF_RANGE: '坐标超出经纬度范围', KIND_MISSING: '缺少空域种类', KIND_NOT_SUPPORTED: '空域种类不在字典内',
  ALTITUDE_INCOMPLETE: '高度带缺少上下限或基准', ALTITUDE_DATUM_NOT_SUPPORTED: '高度基准只支持离地或海拔',
  ALTITUDE_RANGE_INVERTED: '高度下限高于上限', VALID_FROM_MISSING: '缺少生效时间', TIME_INVALID: '时间格式无法识别',
  INVALID_VALIDITY: '失效时间早于生效时间'
};
/** 差异面板的字段名；未收录的字段原样显示代码，不猜含义。 */
export const AIRSPACE_DIFF_FIELD_LABEL = {
  kind_code: '空域种类', min_altitude_m: '高度下限', max_altitude_m: '高度上限', altitude_datum: '高度基准',
  valid_from: '生效时间', valid_to: '失效时间', change_reason: '变更原因'
};
/** 版本号翻译成次数：第 N 版，供空域版本时间线使用。 */
export const airspaceVersionOrdinal = versionNo => (versionNo == null || Number(versionNo) <= 0 ? '' : `第${Number(versionNo)}版`);

/** 取中文文案；代码为空返回 fallback，未收录返回代码本身。 */
export const labelOf = (map, code, fallback = '—') => (code == null || code === '' ? fallback : (map[code] || String(code)));
/** 目标类型文案：优先细分类型，其次大类。 */
/**
 * 授权状态的上屏文案。STOPPED 必须带“设备急停到底做没做”的限定语（决策 13-10/13-11）：
 * 撤销授权是平台的事，设备急停是设备的事，混成一句“已停止”会让人以为设备真的停了。
 * 结果字段缺失时明说“未知”，不挑一个好听的说法顶上。
 */
export const disposalStatusText = auth => {
  const status = auth?.status;
  if (status !== 'STOPPED') return labelOf(DISPOSAL_STATUS_LABEL, status);
  const result = auth?.device_stop_result;
  return DISPOSAL_STOP_RESULT_LABEL[result] || '授权已撤销；设备急停结果未知';
};

export const targetTypeLabel = (subtype, objectType, fallback = '—') =>
  subtype ? labelOf(SUBTYPE_LABEL, subtype) : labelOf(OBJECT_TYPE_LABEL, objectType, fallback);
