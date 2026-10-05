/* 处罚案件只读：列表、详情、事件、处罚规则和决定书正文。
   立案、指派、线索、裁量、复核、出具文书、作废、结案和撤案不再由前台发起。 */
import { apiRequestTimed, buildQuery, readSessionToken } from './apiClient.js';

const cases = '/punishment-cases';
const one = id => `${cases}/${encodeURIComponent(id)}`;

export const punishmentApi = {
  penaltyRules: () => apiRequestTimed('/penalty-rules'),

  listCases: params => apiRequestTimed(`${cases}${buildQuery(params)}`),
  getCase: id => apiRequestTimed(one(id)),
  caseEvents: id => apiRequestTimed(`${one(id)}/events`),
  listDocuments: id => apiRequestTimed(`${one(id)}/decision-documents`)
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
