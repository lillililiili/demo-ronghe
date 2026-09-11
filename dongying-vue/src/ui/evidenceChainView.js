import {
  ALARM_TYPE_LABEL, CONCLUSION_LABEL, DISPOSAL_ACTION_LABEL, EVIDENCE_COVERAGE_LABEL, EVIDENCE_KIND_LABEL,
  EVIDENCE_RECORD_TYPE_LABEL, EVIDENCE_STATUS_LABEL, HANDOFF_TYPE_LABEL, labelOf
} from '@/ui/labels.js';
import { escEvidence, fmtEvidenceTime, openEvidenceFileModal, sizeText } from '@/ui/evidenceFileDetail.js';
import { openModal } from '@/ui/modal.js';

const TYPE_ICON = {
  TRACK: 'trend', VIDEO: 'video', IMAGE: 'camera', ALARM: 'alert',
  JUDGMENT: 'check', AUTHORIZATION: 'shield', DISPOSAL: 'gavel', OPERATION: 'file'
};
const COVERAGE_TAG = { PRESENT: 't-green', ABSENT: 't-orange', FORBIDDEN: 't-gray' };
export const EVIDENCE_CHAIN_TYPES = ['TRACK', 'VIDEO', 'IMAGE', 'ALARM', 'JUDGMENT', 'AUTHORIZATION', 'DISPOSAL', 'OPERATION'];
const TYPES = EVIDENCE_CHAIN_TYPES;

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

/* 卡片副标题：能翻的码一律走共享字典（labelOf 翻不出来时原样返回该码），这里不另造新词。
   结论码只在事件链上翻：CONFIRMED 在无人机事件里是"核实属实"、在飞行风险里是"核验通过"，
   记录本身不带这个区分，翻错比不翻更糟，所以拿不准来源时保持原码。 */
export function recordHint(record, chain) {
  const summary = record.summary || {};
  if (summary.original_name) return summary.original_name;
  if (summary.evidence_no) return summary.evidence_no;
  if (summary.command_no) return summary.command_no;
  const conclusion = summary.conclusion_code || summary.conclusion;
  if (conclusion) return chain && chain.subject_kind === 'EVENT' ? labelOf(CONCLUSION_LABEL, conclusion) : conclusion;
  if (summary.alarm_type) return labelOf(ALARM_TYPE_LABEL, summary.alarm_type);
  if (summary.action) return labelOf(DISPOSAL_ACTION_LABEL, summary.action);
  if (summary.layer) return summary.layer;   // 融合分层没有共享字典，原码照旧
  if (summary.handoff_type) return labelOf(HANDOFF_TYPE_LABEL, summary.handoff_type);
  return record.record_id;
}

/** 告警详情用的转义 HTML；服务端字段全部 esc。 */
export function renderEvidenceChainHtml(chain, state = {}) {
  const U = window.UI;
  const esc = escEvidence;
  if (state.loading) return U.sect('证据链', '<div class="empty">正在读取证据链…</div>', { icon: 'folder' });
  if (state.error) {
    return U.sect('证据链', `<div class="empty">${esc(state.error)}
      <button class="btn" type="button" data-al="chain-retry" style="margin-top:8px">重试</button></div>`, { icon: 'folder' });
  }
  if (state.unavailable) {
    return U.sect('证据链', `<div style="color:var(--txt-3);font-size:12px;line-height:1.7">${esc(state.unavailable)}</div>`, { icon: 'folder' });
  }
  if (!chain) return '';
  const coverage = chain.coverage || {};
  const records = Array.isArray(chain.records) ? chain.records : [];
  const broken = records.filter(r => r.availability === 'UNAVAILABLE').length;
  const title = `证据链（${records.length} 项${broken ? ` · ${broken} 份校验异常` : ''}）`;
  const cov = TYPES.map(type => {
    const item = coverage[type] || {};
    const status = item.status || 'ABSENT';
    const label = labelOf(EVIDENCE_RECORD_TYPE_LABEL, type, type);
    return `<button type="button" data-ev-chain-type="${esc(type)}"
      style="display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid var(--line);border-radius:4px;font-size:11px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left"
      title="${esc(label)}" aria-label="${esc(label)}">
      <span>${esc(label)}</span>
      <span class="tag ${coverageTagClass(status)}">${esc(labelOf(EVIDENCE_COVERAGE_LABEL, status, status))}${item.count ? ` ${item.count}` : ''}</span>
    </button>`;
  }).join('');
  const cards = !records.length
    ? '<div style="color:var(--txt-3);font-size:12px;line-height:1.7">当前事件/目标没有已关联的八类记录。缺项已在上方标为缺失，不编造材料。</div>'
    : `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
        ${records.slice(0, 8).map(record => {
          const file = isFileRecord(record);
          const bad = record.availability === 'UNAVAILABLE';
          const cap = esc(recordCaption(record));
          const hint = esc(recordHint(record, chain));
          const tag = file && record.summary && record.summary.status
            ? esc(labelOf(EVIDENCE_STATUS_LABEL, record.summary.status, record.summary.status)) : '';
          const inner = `<span style="font-size:14px">${U.icon(TYPE_ICON[record.record_type] || 'folder')}</span>
            <span style="font-size:10px;color:var(--txt-2)">${cap}</span>
            ${bad ? `<span style="font-size:9px;color:#ff8b95">${tag || '校验异常'}</span>` : ''}`;
          return file
            ? `<button type="button" class="punish-evidence-card" data-ev-file="${esc(record.record_id)}"
                style="height:54px;border:1px solid ${bad ? 'rgba(255,77,94,.5)' : 'var(--line)'};
                border-radius:4px;background:linear-gradient(135deg,rgba(61,139,255,.22),rgba(4,12,32,.9));
                display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:pointer;color:inherit;font:inherit"
                title="${hint}" aria-label="查看证据详情：${cap}">${inner}</button>`
            : `<div style="height:54px;border:1px solid var(--line);border-radius:4px;
                background:linear-gradient(135deg,rgba(61,139,255,.12),rgba(4,12,32,.9));
                display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px"
                title="${hint}">${inner}</div>`;
        }).join('')}
      </div>
      ${records.length > 8 ? `<div style="font-size:11px;color:var(--txt-3);margin-top:6px">另有 ${records.length - 8} 项，可在「证据管理」查看文件台账</div>` : ''}`;
  const integrity = chain.integrity
    ? `<div style="font-size:11px;color:var(--txt-3);line-height:1.7;margin-top:8px">
        <span title="${esc(chain.integrity.algorithm)} ${esc(chain.integrity.checksum || '')}">链校验已生成（悬停查看摘要）</span>
        　${Number(chain.integrity.member_count) || 0} 项　${esc(fmtEvidenceTime(chain.integrity.computed_at))}
      </div>` : '';
  const lineage = lineageHtml(chain.lineage, chain.current_target_id, chain.historical_target_ids);
  return U.sect(title, `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">${cov}</div>${cards}${integrity}${lineage}`, { icon: 'folder' });
}

function lineageHtml(lineage, currentId, historical) {
  const U = window.UI;
  const esc = escEvidence;
  if (!lineage || lineage.availability === 'FORBIDDEN') {
    return '<div style="font-size:11px;color:var(--txt-3);margin-top:8px">目标 ID 变更回溯需要 fusion:read。</div>';
  }
  const ops = Array.isArray(lineage.ops) ? lineage.ops : [];
  const judgments = Array.isArray(lineage.pre_merge_judgments) ? lineage.pre_merge_judgments : [];
  if (!ops.length && !judgments.length && !(historical && historical.length)) return '';
  const hist = Array.isArray(historical) && historical.length
    ? historical.map(id => `<span class="mono">${esc(id)}</span>`).join('、') : '无';
  const rows = judgments.slice(0, 8).map(item => {
    const status = item.judgment_availability === 'PRESENT'
      ? `${esc(item.conclusion_code || '')}　${esc(fmtEvidenceTime(item.assessed_at))}`
      : '合并前无研判记录';
    return `<div style="font-size:11.5px;line-height:1.6;padding:4px 0;border-bottom:1px solid rgba(64,158,255,.08)">
      <span class="mono">${esc(item.member_target_id)}</span>
      <span class="tag ${item.judgment_availability === 'PRESENT' ? 't-green' : 't-orange'}">${item.judgment_availability === 'PRESENT' ? '有判定' : '缺失'}</span>
      ${esc(status)}
    </div>`;
  }).join('');
  return U.sect('目标 ID 变更回溯', `
    <div class="warnbox" style="margin-bottom:8px;padding:7px 9px;font-size:11.5px;line-height:1.6">
      当前归属目标 <span class="mono">${esc(currentId || '—')}</span>。ID 变更不得导致证据链断裂；下方为合并前判定（来自研判历史记录，不虚构合法性字段）。
    </div>
    ${U.kv([
      ['历史目标', hist],
      ['谱系操作', String(ops.length)]
    ])}
    ${rows || '<div style="color:var(--txt-3);font-size:12px">没有 MERGE/SPLIT 判定快照。</div>'}`);
}

export function chainTypeCards(chain) {
  const records = Array.isArray(chain?.records) ? chain.records : [];
  const coverage = chain?.coverage || {};
  return TYPES.map(type => {
    const item = coverage[type] || {};
    const status = item.status || 'ABSENT';
    const ofType = records.filter(row => row.record_type === type);
    const broken = ofType.filter(row => row.availability === 'UNAVAILABLE').length
      || Number(item.broken_count) || 0;
    const count = Number(item.count) || ofType.length;
    const newest = ofType.length ? ofType[ofType.length - 1] : null;
    const statusText = status === 'PRESENT'
      ? (broken ? `已收录 ${count} · 异常 ${broken}` : `已收录 ${count}`)
      : labelOf(EVIDENCE_COVERAGE_LABEL, status, status);
    const preview = status === 'FORBIDDEN'
      ? '当前账号没有查看权限'
      : (newest ? recordHint(newest, chain) : `没有已关联的${labelOf(EVIDENCE_RECORD_TYPE_LABEL, type, type)}`);
    const label = labelOf(EVIDENCE_RECORD_TYPE_LABEL, type, type);
    return {
      type, label, icon: TYPE_ICON[type] || 'folder', status, count, broken,
      truncated: !!item.truncated, records: ofType, statusText, preview,
      tagClass: broken ? 't-red' : coverageTagClass(status)
    };
  });
}

export function openEvidenceChainTypeModal({ chain, type }) {
  const card = chainTypeCards(chain).find(item => item.type === type);
  if (!card) return;
  openModal({
    title: `${card.label}证据`,
    width: '560px',
    body: renderTypeDetailHtml(card),
    on: {
      file: (_root, btn) => { if (btn.dataset.evFile) openEvidenceFileModal(btn.dataset.evFile); }
    }
  });
}

function renderTypeDetailHtml(card) {
  const U = window.UI;
  const esc = escEvidence;
  if (card.status === 'FORBIDDEN') {
    return `<div class="empty">当前账号没有查看${esc(card.label)}证据的权限。</div>`;
  }
  if (!card.records.length) {
    return `<div class="empty">${esc(card.preview)}。缺失不是故障，系统不编造材料。</div>`;
  }
  const note = card.truncated ? `<div style="font-size:11px;color:var(--txt-3);margin-bottom:8px">该类超过返回上限，弹窗只展示 ${card.records.length} 条。</div>` : '';
  const items = card.records.map(record => {
    const file = isFileRecord(record);
    const bad = record.availability === 'UNAVAILABLE';
    const action = file
      ? `<button class="btn" type="button" data-act="file" data-ev-file="${esc(record.record_id)}">查看文件</button>`
      : '';
    return `<article style="margin-bottom:10px;padding:8px;border:1px solid var(--line);border-radius:6px">
      <header style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px">
        <b>${esc(recordCaption(record))}</b>
        <span class="tag ${bad ? 't-red' : 't-gray'}">${bad ? '校验异常' : esc(fmtEvidenceTime(record.occurred_at))}</span>
      </header>
      ${U.kv(recordRows(record), { surface: true, density: 'compact' })}
      ${action}
    </article>`;
  }).join('');
  return `${note}${items}`;
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
  add('摘要', esc(recordHint(record)));
  return rows;
}
