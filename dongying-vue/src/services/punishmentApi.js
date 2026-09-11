/* 处罚案件（阶段 14 契约 v1.0）：立案 → 指派 → 线索 → 裁量 → 复核 → 决定书 → 结案。
   只经 apiRequestTimed；写方法带 Idempotency-Key 与 expected_version。
   处罚是有法律后果的行政行为：案件号、承办人、裁量金额、文书编号一律来自服务端，页面不伪造，
   也不把"结果未知"说成成功。 */
import { apiRequestTimed, buildQuery, readSessionToken } from './apiClient.js';

export const PUNISHMENT_UNAVAILABLE_TEXT = '处罚案件功能暂不可用';

export function newPunishmentIdempotencyKey(action = 'case') {
  return `punishment-${action}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/* 14.1 落地前后端没有这些路径：404/501 一律按“服务尚未接入”处理，页面据此显示说明而不是造数据。 */
export function isPunishmentUnavailable(error) {
  return !!error && (error.status === 404 || error.status === 501);
}

const cases = '/punishment-cases';
const one = id => `${cases}/${encodeURIComponent(id)}`;
const write = (path, body, idempotencyKey) => apiRequestTimed(path, { method: 'POST', body, mutation: true, idempotencyKey });

export const punishmentApi = {
  penaltyRules: () => apiRequestTimed('/penalty-rules'),

  listCases: params => apiRequestTimed(`${cases}${buildQuery(params)}`),
  getCase: id => apiRequestTimed(one(id)),
  caseEvents: id => apiRequestTimed(`${one(id)}/events`),

  fileCase: (body, key) => write(cases, body, key),
  assign: (id, body, key) => write(`${one(id)}/assign`, body, key),
  addLead: (id, body, key) => write(`${one(id)}/leads`, body, key),
  resolveLead: (id, leadId, body, key) => write(`${one(id)}/leads/${encodeURIComponent(leadId)}/resolve`, body, key),

  draftDiscretion: (id, body, key) => write(`${one(id)}/discretions`, body, key),
  confirmDiscretion: (id, discretionId, body, key) => write(`${one(id)}/discretions/${encodeURIComponent(discretionId)}/confirm`, body, key),

  review: (id, body, key) => write(`${one(id)}/reviews`, body, key),

  issueDocument: (id, body, key) => write(`${one(id)}/decision-documents`, body, key),
  listDocuments: id => apiRequestTimed(`${one(id)}/decision-documents`),
  revokeDocument: (documentId, body, key) => write(`/decision-documents/${encodeURIComponent(documentId)}/revoke`, body, key),

  closeCase: (id, body, key) => write(`${one(id)}/close`, body, key),
  withdrawCase: (id, body, key) => write(`${one(id)}/withdraw`, body, key)
};

/**
 * 决定书正文。契约给的是 text/plain + Content-Disposition: attachment，
 * 但浏览器沙箱里 <a download> 是死的（点了什么也不会发生），所以这里取回文本交给页面预览与复制，
 * 页面必须明说“平台内预览与复制，不提供下载”，不能摆一个点不动的下载按钮。
 */
export async function fetchDocumentContent(documentId) {
  const response = await fetch(`/api/v1/decision-documents/${encodeURIComponent(documentId)}/content`, {
    headers: { Authorization: `Bearer ${readSessionToken()}` }
  });
  if (!response.ok) {
    const error = new Error(`文书正文读取失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}
