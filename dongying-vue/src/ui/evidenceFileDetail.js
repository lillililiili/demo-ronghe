import { h } from 'vue';
import { openModal } from '@/ui/modal.js';
import EvidencePreviewModal from '@/components/evidence/EvidencePreviewModal.vue';
import { hasPermission } from '@/services/accessControl.js';
import { EVIDENCE_CUSTODY_LABEL, EVIDENCE_CUSTODY_TAG, EVIDENCE_KIND_LABEL, EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, SOURCE_MODE_LABEL, labelOf, readableNo } from '@/ui/labels.js';
/* 只有在库文件能下载：其余状态按钮禁用并说明（决策 15-58）。 */
const DOWNLOAD_BLOCKED = { PENDING: '文件还在入库中，暂不能下载', MISSING: '文件缺失，不能下载', CORRUPT: '文件哈希不符，不能下载' };

const SC = {
  PENDING: 't-gray', AVAILABLE: 't-green', MISSING: 't-orange', CORRUPT: 't-red', DESTROYED: 't-gray'
};

export function escEvidence(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

export function fmtEvidenceTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function custodyTag(f) {
  const U = window.UI;
  if (f?.status === 'DESTROYED') return U.tag('已销毁', 't-gray');
  const code = f?.custody || (f?.held ? 'HELD' : '');
  if (!code) return '—';
  return U.tag(labelOf(EVIDENCE_CUSTODY_LABEL, code, code), EVIDENCE_CUSTODY_TAG[code] || 't-gray');
}

function retainUntilText(f) {
  if (f.retain_until == null) return '—';
  const date = fmtEvidenceTime(f.retain_until);
  if (f.status === 'DESTROYED') return date;
  if (f.custody === 'HELD') return `${date}　<span style="color:var(--txt-3);font-size:11px">冻结中，到期亦不清理</span>`;
  if (f.custody === 'DUE') return `${date}　<span style="color:var(--txt-3);font-size:11px">已到期，文件仍保管</span>`;
  if (f.custody === 'NEARING') return `${date}　<span style="color:var(--txt-3);font-size:11px">30 天内到期</span>`;
  return date;
}

export function sizeText(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

export function saveEvidenceBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** 证据文件详情 HTML。page 含冻结/校验；modal 只下载。证据台账右侧与告警/处罚弹窗共用。 */
export function renderEvidenceFileDetail(f, options = {}) {
  const U = window.UI;
  const mode = options.mode || 'page';
  if (!f) return '<div class="empty">请选择证据文件</div>';
  const esc = escEvidence;
  const kind = labelOf(EVIDENCE_KIND_LABEL, f.kind_code, f.kind_code);
  const status = labelOf(EVIDENCE_STATUS_LABEL, f.status, f.status);
  const links = f.links || [];
  const holds = f.holds || [];
  const activeHold = holds.find(h => !h.released_at);
  const ingestSec = f.captured_at != null && f.stored_at != null
    ? Math.max(0, Math.round((f.stored_at - f.captured_at) / 1000)) : null;
  const emptyLinks = mode === 'modal'
    ? '<div style="color:var(--txt-3);font-size:12px">无引用。</div>'
    : '<div style="color:var(--txt-3);font-size:12px">这份证据还没有用于告警、目标或其他事项。</div>';
  const canDestroy = mode === 'page' && f.status !== 'DESTROYED' && !f.held && f.custody === 'DUE';
  const actions = mode === 'preview' ? '' : f.status === 'DESTROYED'
    ? `<div style="font-size:12px;color:var(--txt-3);line-height:1.8">文件内容已销毁，台账编号、哈希和销毁记录保留，不能再下载。</div>`
    : mode === 'modal'
    ? `<button class="btn pri" style="width:100%;justify-content:center" data-act="download">${U.icon('download')} 下载</button>`
    : `${f.status === 'AVAILABLE' && hasPermission('evidence:download')
        ? `<button class="btn pri" style="width:100%;justify-content:center" data-evact="download">${U.icon('download')} 下载</button>`
        : `<button class="btn pri" style="width:100%;justify-content:center" disabled>${U.icon('download')} ${f.status === 'AVAILABLE' ? '未获原件下载权限' : esc(DOWNLOAD_BLOCKED[f.status] || '文件不可下载')}</button>`}
    <div style="display:flex;gap:8px;margin-top:8px">
      ${f.status === 'INGESTING'
        ? `<button class="btn" style="flex:1" disabled title="文件还在入库中，入库完成后才能校验">校验哈希</button>`
        : `<button class="btn" style="flex:1" data-evact="verify">校验哈希</button>`}
      ${f.held
        ? `<button class="btn" style="flex:1" data-evact="release" data-hold="${esc(activeHold?.hold_id || '')}">解除冻结</button>`
        : `<button class="btn" style="flex:1" data-evact="hold">冻结</button>`}
    </div>
    ${canDestroy
      ? `<button class="btn danger" style="width:100%;justify-content:center;margin-top:8px" data-evact="destroy">销毁文件</button>`
      : ''}`;
  const tags = [U.tag(status, SC[f.status] || 't-gray')];
  if (f.custody || f.held) tags.push(custodyTag(f));
  return `${U.detailHero({
    icon: 'file', subtitle: '证据文件', title: f.original_name, id: f.evidence_no,
    tags,
    meta: [['类型', kind], ['大小', sizeText(f.size_bytes)]]
  })}
  ${U.sect('文件信息', U.kv([
    ['取证时刻', fmtEvidenceTime(f.captured_at)],
    ['上传时间', fmtEvidenceTime(f.stored_at)],
    ['来源模式', esc(labelOf(SOURCE_MODE_LABEL, f.source_mode, '—'))]
  ]))}
  <details class="sect"><summary>文件校验信息</summary>${U.kv([
    ['文件格式', esc(f.content_type || '—')],
    ['SHA-256', `<span class="mono" style="overflow-wrap:anywhere">${esc(f.sha256 || '—')}</span>`],
    ...(ingestSec != null ? [['入库间隔', `${ingestSec} 秒`]] : [])
  ])}</details>
  ${U.sect('保管', U.kv([
    ['文件状态', U.tag(status, SC[f.status] || 't-gray')],
    ['法律冻结', f.held ? `<span class="tag t-purple">冻结中</span> ${esc(activeHold?.reason || '')}` : '<span class="tag t-gray">未冻结</span>'],
    ['留存期', `${esc(f.retain_label || '—')}${f.retain_note ? `　<span style="color:var(--txt-3);font-size:11px">${esc(f.retain_note)}</span>` : ''}`],
    ['到期日', retainUntilText(f)],
    ['保管结论', custodyTag(f)],
    ...(f.status === 'DESTROYED' ? [
      ['销毁时间', fmtEvidenceTime(f.destroyed_at)],
      ['销毁人', esc(f.destroyed_by || '—')],
      ['销毁原因', esc(f.destroy_reason || '—')],
      ['审批号', esc(f.destroy_approval || '—')]
    ] : [])
  ]))}
  ${U.sect(`被引用（${links.length} 处）`, links.length
    ? links.map(r => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(64,158,255,.08);font-size:12px">
        <span class="tag t-gray">${esc(labelOf(EVIDENCE_SUBJECT_LABEL, r.subject_kind, r.subject_kind))}</span>
        <span class="${mode === 'page' ? 'lnk' : ''}" title="${esc(r.subject_id)}" ${mode === 'page' ? `data-ev-go="${esc(r.subject_kind)}|${esc(r.subject_id)}"` : ''}>${esc((r.subject_no !== r.subject_id && readableNo(r.subject_no)) || `已关联${labelOf(EVIDENCE_SUBJECT_LABEL, r.subject_kind, '对象')}`)}</span>
      </div>`).join('')
    : emptyLinks)}
  ${actions ? U.sect('操作', `<button class="btn" type="button" style="width:100%;justify-content:center;margin-bottom:8px" data-evact="preview">打开内容预览</button>${actions}`) : ''}`;
}

export function openEvidenceFileModal(evidenceId, options = {}) {
  // 立即打开单层预览，元数据/原件的迟到响应由组件隔离；不能等请求回来覆盖其他弹窗。
  const handle = openModal({
    title: '证据预览', width: '960px', footer: false,
    render: () => h(EvidencePreviewModal, {
      evidenceId, files: options.files || [], returnLabel: options.returnLabel || '返回事项详情',
      onReturn: () => { handle.close(); options.onReturn?.(); }
    })
  });
  return handle;
}
