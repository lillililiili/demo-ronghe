// 旧人工观察仅用于历史材料展示，不参与当前进度或动作资格。
export const ADVISORY_KIND = {
  SMS_SIMULATED: '模拟短信劝离', VOICE_SIMULATED: '模拟电话录音通知', CONTACT_RECORDED: '人工联系记录', OBSERVATION: '历史现场观察记录'
};
export const OBSERVATION_OUTCOME = {
  DEPARTED: '已确认飞离', STILL_INSIDE: '仍在违规区域', UNKNOWN: '无法确认 / 目标失联'
};
export const OBSERVATION_DANGER = { HIGH: '高', MEDIUM: '中', LOW: '低', UNKNOWN: '待核查' };
export function orderedRecords(records = []) {
  return [...records].sort((a, b) => Number(a.created_at) - Number(b.created_at));
}
