/* 处置授权（阶段 13 契约 v1.0）：反制 / 信号干扰 / 驱离 / 诱骗的申请—审批—执行—停止全链。
   只经 apiRequestTimed 访问服务端：超时统一抛 TIMEOUT/408，写请求按“结果未知”回读当前授权，
   绝不在前端伪造授权编号或成功结果——这类动作有法律后果，页面上的每个状态都必须来自服务端。 */
import { apiRequestTimed, buildQuery } from './apiClient.js';

export function newDisposalIdempotencyKey(action = 'request') {
  return `disposal-${action}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

const base = '/disposal-authorizations';
const one = id => `${base}/${encodeURIComponent(id)}`;
const write = (path, body, idempotencyKey) => apiRequestTimed(path, { method: 'POST', body, mutation: true, idempotencyKey });

export const disposalApi = {
  list: params => apiRequestTimed(`${base}${buildQuery(params)}`),
  detail: id => apiRequestTimed(one(id)),
  events: (id, params) => apiRequestTimed(`${one(id)}/events${buildQuery(params)}`),
  policies: () => apiRequestTimed('/disposal-policies'),

  /* body: { action_type, subject_kind, subject_id, device_id?, channel, reason } */
  create: (body, idempotencyKey) => write(base, body, idempotencyKey),
  /* 以下写操作都带 expected_version：并发下由服务端判 409，前端不猜。 */
  approve: (id, body, idempotencyKey) => write(`${one(id)}/approve`, body, idempotencyKey),
  reject: (id, body, idempotencyKey) => write(`${one(id)}/reject`, body, idempotencyKey),
  execute: (id, body, idempotencyKey) => write(`${one(id)}/execute`, body, idempotencyKey),
  manualResult: (id, body, idempotencyKey) => write(`${one(id)}/manual-result`, body, idempotencyKey),
  stop: (id, body, idempotencyKey) => write(`${one(id)}/stop`, body, idempotencyKey),
  cancel: (id, body, idempotencyKey) => write(`${one(id)}/cancel`, body, idempotencyKey)
};

/* 13.1 落地前后端还没有这些路径：404/501 一律按“服务尚未接入”处理，页面据此显示说明而不是造数据。 */
export function isDisposalUnavailable(error) {
  return !!error && (error.status === 404 || error.status === 501);
}
