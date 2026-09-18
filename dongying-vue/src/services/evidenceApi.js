import { apiBinary, apiDownload, apiRequestTimed, buildQuery } from '@/services/apiClient.js';
import { createPreviewRequestQueue } from '@/services/evidencePreviewQueue.js';

const thumbnailQueue = createPreviewRequestQueue(3);

export function listEvidenceFiles(values) {
  return apiRequestTimed(`/evidence-files${buildQuery(values)}`);
}

export function getEvidenceFile(id) {
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}`);
}

export function getEvidenceChain(subjectKind, subjectId) {
  return apiRequestTimed(`/evidence-chains/${encodeURIComponent(subjectKind)}/${encodeURIComponent(subjectId)}`);
}

/** 精确读取证据关联的轨迹；离开该记录后停止后续分页，不切到目标最新轨迹。 */
export async function getEvidenceTrackPoints(trackId, { isCurrent = () => true } = {}) {
  const items = [];
  let total = 0;
  for (let page = 1; isCurrent(); page += 1) {
    const result = await apiRequestTimed(`/tracks/${encodeURIComponent(trackId)}/points${buildQuery({ page, size: 100 })}`);
    if (!isCurrent()) return null;
    const batch = Array.isArray(result?.items) ? result.items : [];
    total = Number(result?.total) || 0;
    items.push(...batch);
    if (!batch.length || items.length >= total) break;
  }
  return { items, total };
}

export function listEvidenceAccessLogs(id, values) {
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}/access-logs${buildQuery(values)}`);
}

export function verifyEvidenceFile(id, idempotencyKey) {
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}/verify`, {
    method: 'POST', mutation: true, idempotencyKey
  });
}

export function holdEvidenceFile(id, reason, idempotencyKey) {
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}/holds`, {
    method: 'POST', body: { reason }, mutation: true, idempotencyKey
  });
}

export function releaseEvidenceHold(id, holdId, idempotencyKey) {
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}/holds/${encodeURIComponent(holdId)}/release`, {
    method: 'POST', mutation: true, idempotencyKey
  });
}

export function destroyEvidenceFile(id, reason, approvalNo, idempotencyKey) {
  const body = { reason };
  if (approvalNo) body.approval_no = approvalNo;
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}/destroy`, {
    method: 'POST', body, mutation: true, idempotencyKey
  });
}

export function linkEvidenceFile(id, subjectKind, subjectId, idempotencyKey) {
  return apiRequestTimed(`/evidence-files/${encodeURIComponent(id)}/links`, {
    method: 'POST', body: { subject_kind: subjectKind, subject_id: subjectId }, mutation: true, idempotencyKey
  });
}

export function exportEvidenceCsv(values) {
  return apiDownload(`/evidence-files/export.csv${buildQuery(values)}`);
}

export function downloadEvidenceContent(id) {
  return apiBinary(`/evidence-files/${encodeURIComponent(id)}/content`);
}

export function previewEvidenceContent(id, { signal, thumbnail = false } = {}) {
  const request = () => apiBinary(`/evidence-files/${encodeURIComponent(id)}/${thumbnail ? 'thumbnail' : 'preview'}`, {
    signal, maxBytes: 32 * 1024 * 1024
  });
  return thumbnail ? thumbnailQueue(request, signal) : request();
}

export async function ingestEvidenceFile({ file, kindCode, ownerOrgId, districtId, capturedAt, subjectKind, subjectId, sourceDeviceId, captureLongitude, captureLatitude, idempotencyKey }) {
  const body = new FormData();
  body.append('file', file);
  body.append('kind_code', kindCode);
  if (ownerOrgId) body.append('owner_org_id', ownerOrgId);
  if (districtId) body.append('district_id', districtId);
  if (capturedAt != null) body.append('captured_at', String(capturedAt));
  if (subjectKind) body.append('subject_kind', subjectKind);
  if (subjectId) body.append('subject_id', subjectId);
  if (sourceDeviceId) body.append('source_device_id', sourceDeviceId);
  if (captureLongitude != null) body.append('capture_longitude', String(captureLongitude));
  if (captureLatitude != null) body.append('capture_latitude', String(captureLatitude));
  return apiRequestTimed('/evidence-files', { method: 'POST', body, mutation: true, idempotencyKey }, 60_000);
}
