import { h } from 'vue';
import {
  EVIDENCE_COVERAGE_LABEL, EVIDENCE_KIND_LABEL, EVIDENCE_RECORD_TYPE_LABEL, EVIDENCE_STATUS_LABEL, labelOf
} from '@/ui/labels.js';
import { escEvidence, fmtEvidenceTime, openEvidenceFileModal, sizeText } from '@/ui/evidenceFileDetail.js';
import { openModal } from '@/ui/modal.js';
import { evidenceDisplayType } from '@/services/evidenceTrackData.js';
import EvidenceTrackModal from '@/components/evidence/EvidenceTrackModal.vue';

const TYPE_ICON = { TRACK: 'trend', VIDEO: 'video', IMAGE: 'camera' };
const COVERAGE_TAG = { PRESENT: 't-green', ABSENT: 't-orange', FORBIDDEN: 't-gray' };
const ABSENT_HINT = {
  TRACK: '没有已关联的实测轨迹',
  VIDEO: '没有已关联的录像文件',
  IMAGE: '没有已关联的图像文件'
};
/* 接口仍返回八类；页面只展示轨迹/视频/图像。告警、判定、授权、处置、操作是办理记录，不上证据区。 */
const EVIDENCE_MATERIAL_TYPES = ['TRACK', 'VIDEO', 'IMAGE'];

export function isFileRecord(record) {
  const summary = record && record.summary;
  return !!(summary && (summary.kind_code || summary.evidence_no || summary.sha256));
}

export function coverageTagClass(status) {
  return COVERAGE_TAG[status] || 't-gray';
}

export function recordCaption(record) {
  const summary = record.summary || {};
  if (summary.kind_code) return labelOf(EVIDENCE_KIND_LABEL, summary.kind_code, summary.kind_code);
  return labelOf(EVIDENCE_RECORD_TYPE_LABEL, record.record_type, record.record_type);
}

export function recordHint(record) {
  const summary = record.summary || {};
  if (summary.original_name) return summary.original_name;
  if (summary.evidence_no) return summary.evidence_no;
  if (summary.layer) return summary.point_count != null ? `${summary.layer} · ${summary.point_count} 点` : summary.layer;
  return record.record_id;
}

export function chainTypeCards(chain) {
  const records = Array.isArray(chain?.records) ? chain.records : [];
  const coverage = chain?.coverage || {};
  return EVIDENCE_MATERIAL_TYPES.map(type => {
    const item = coverage[type] || {};
    const ofType = records.filter(row => evidenceDisplayType(row) === type);
    const restricted = item.status === 'FORBIDDEN';
    const status = ofType.length ? 'PRESENT' : restricted ? 'FORBIDDEN' : 'ABSENT';
    const broken = ofType.filter(row => row.availability === 'UNAVAILABLE').length;
    const count = ofType.length;
    const truncated = !!item.truncated || (type === 'TRACK' && !!coverage.IMAGE?.truncated);
    const newest = ofType.length ? ofType[ofType.length - 1] : null;
    const statusText = status === 'PRESENT'
      ? (broken ? `已收录 ${count} · 异常 ${broken}` : `已收录 ${count}`)
      : status === 'ABSENT' && truncated ? '本次未返回' : labelOf(EVIDENCE_COVERAGE_LABEL, status, status);
    const preview = status === 'FORBIDDEN'
      ? '当前账号没有查看权限'
      : (newest ? recordHint(newest) : truncated ? '仅返回部分记录，完整材料状态待确认' : ABSENT_HINT[type]);
    const label = labelOf(EVIDENCE_RECORD_TYPE_LABEL, type, type);
    return {
      type, label, icon: TYPE_ICON[type] || 'folder', status, count, broken, restricted,
      truncated, records: ofType, statusText, preview,
      tagClass: broken ? 't-red' : coverageTagClass(status),
      cardClass: broken ? 'is-broken' : (status === 'PRESENT' ? 'is-present' : status === 'FORBIDDEN' ? 'is-forbidden' : 'is-absent'),
      ariaLabel: `${label}，${statusText}，${ofType.some(isFileRecord) ? '点击直接预览' : '点击查看记录'}`
    };
  });
}

export function openEvidenceChainTypeModal({ chain, type }) {
  const card = chainTypeCards(chain).find(item => item.type === type);
  if (!card) return;
  if (type === 'TRACK' && card.records.length) {
    const handle = openModal({ title: '轨迹证据', width: '1180px', footer: false,
      render: () => h(EvidenceTrackModal, { records: card.records, truncated: card.truncated,
        restricted: card.restricted, onReturn: () => handle.close() }) });
    return handle;
  }
  const files = card.records.filter(isFileRecord).map(record => ({
    ...record.summary, evidence_id: record.record_id
  }));
  if (files.length) {
    return openEvidenceFileModal(files[0].evidence_id, { files, returnLabel: '返回事项详情' });
  }
  openModal({
    title: `${card.label}证据`,
    width: '560px',
    body: renderTypeDetailHtml(card),
    on: {
      file: (_root, btn) => { if (btn.dataset.evFile) openEvidenceFileModal(btn.dataset.evFile); }
    }
  });
}

export function renderEvidenceChainHtml(chain, state = {}) {
  const U = window.UI;
  const esc = escEvidence;
  if (state.loading) return U.sect('证据链', '<div class="empty">正在读取证据链</div>', { icon: 'folder' });
  if (state.error) {
    return U.sect('证据链', `<div class="empty">${esc(state.error)}
      <button class="btn" type="button" data-al="chain-retry" style="margin-top:8px">重试</button></div>`, { icon: 'folder' });
  }
  if (state.unavailable) {
    return U.sect('证据链', `<div style="color:var(--txt-3);font-size:12px;line-height:1.7">${esc(state.unavailable)}</div>`, { icon: 'folder' });
  }
  if (!chain) return '';
  const cards = chainTypeCards(chain);
  const total = cards.reduce((sum, item) => sum + item.count, 0);
  const broken = cards.reduce((sum, item) => sum + item.broken, 0);
  const title = `证据链（${total} 项${broken ? ` · ${broken} 份校验异常` : ''}）`;
  const grid = `<div class="ev-chain-grid">${cards.map(card => `
    <button type="button" class="ev-chain-card ${card.cardClass}" data-ev-chain-type="${esc(card.type)}"
      title="${esc(card.preview)}" aria-label="${esc(card.ariaLabel)}">
      <span class="ev-chain-card-head">
        <span class="ev-chain-card-icon">${U.icon(card.icon)}</span>
        <b>${esc(card.label)}</b>
        <span class="tag ${card.tagClass}">${esc(card.statusText)}</span>
      </span>
      <span class="ev-chain-card-preview">${esc(card.preview)}</span>
    </button>`).join('')}</div>`;
  const integrity = chain.integrity
    ? `<div class="ev-chain-integrity" title="${esc(chain.integrity.checksum || '')}">
        链校验 ${esc(chain.integrity.algorithm)}　${esc(fmtEvidenceTime(chain.integrity.computed_at))}
      </div>` : '';
  return U.sect(title, `${grid}${integrity}`, { icon: 'folder' });
}

function renderTypeDetailHtml(card) {
  const U = window.UI;
  const esc = escEvidence;
  if (card.status === 'FORBIDDEN') {
    return `<div class="empty">当前账号没有查看${esc(card.label)}证据的权限。</div>`;
  }
  if (!card.records.length) {
    const message = card.truncated
      ? '本次返回中没有对应材料。接口仅返回部分材料，不能据此确认没有其他证据。'
      : ABSENT_HINT[card.type] || '当前事项尚无可预览的对应材料';
    return `<div class="empty">${esc(message)}</div>`;
  }
  const note = card.truncated ? `<div class="ev-chain-note">该类超过 100 条，弹窗只展示返回的 ${card.records.length} 条。</div>` : '';
  const items = card.records.map(record => {
    const file = isFileRecord(record);
    const bad = record.availability === 'UNAVAILABLE';
    const rows = recordRows(record);
    const action = file
      ? `<button class="btn" type="button" data-act="file" data-ev-file="${esc(record.record_id)}">查看文件</button>`
      : '';
    return `<article class="ev-chain-item${bad ? ' is-broken' : ''}">
      <header class="ev-chain-item-head">
        <b>${esc(recordCaption(record))}</b>
        <span class="tag ${bad ? 't-red' : 't-gray'}">${bad ? '校验异常' : esc(fmtEvidenceTime(record.occurred_at))}</span>
      </header>
      ${U.kv(rows, { surface: true, density: 'compact' })}
      ${action}
    </article>`;
  }).join('');
  return `${note}<div class="ev-chain-list">${items}</div>`;
}

function recordRows(record) {
  const s = record.summary || {};
  const rows = [];
  const add = (label, value) => { if (value != null && value !== '') rows.push([label, value]); };
  const esc = escEvidence;
  if (isFileRecord(record)) {
    add('文件名', esc(s.original_name || '—'));
    add('证据编号', esc(s.evidence_no || '—'));
    add('文件类型', esc(labelOf(EVIDENCE_KIND_LABEL, s.kind_code, s.kind_code)));
    add('文件状态', esc(labelOf(EVIDENCE_STATUS_LABEL, s.status, s.status)));
    add('大小', esc(sizeText(s.size_bytes)));
    if (s.sha256) add('SHA-256', `<span class="mono" style="word-break:break-all">${esc(s.sha256)}</span>`);
    return rows;
  }
  add('分层', esc(s.layer || '—'));
  add('点数', s.point_count == null ? '—' : `${Number(s.point_count)} 点`);
  add('开始', fmtEvidenceTime(s.started_at));
  add('结束', fmtEvidenceTime(s.ended_at));
  return rows;
}
