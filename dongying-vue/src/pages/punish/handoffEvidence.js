import { listEvidenceLedger } from '@/services/evidenceApi.js';
import { evidenceDisplayType } from '@/services/evidenceTrackData.js';

const isFusedTrack = record => evidenceDisplayType(record) === 'TRACK'
  && record.summary?.source_kind === 'TRACK' && record.summary.layer === 'FUSED';
const trackTime = record => record.summary?.started_at ?? record.occurred_at ?? -Infinity;

/** 交接详情只展示最新融合轨迹；原始材料和冻结移送材料保持原样。 */
export async function handoffEvidenceChain(chain, isCurrent = () => true) {
  const records = Array.isArray(chain?.records) ? chain.records : [];
  let fused = records.filter(isFusedTrack).sort((a, b) => trackTime(b) - trackTime(a)
    || String(a.record_id).localeCompare(String(b.record_id)))[0];
  const coverage = chain?.coverage?.TRACK || {};
  // 材料摘要每类有返回上限；不能因前一页全是原始轨迹就断言没有融合轨迹。
  if (!fused && coverage.truncated && coverage.status !== 'FORBIDDEN') {
    let page = 1;
    let total = Infinity;
    while (isCurrent() && (page - 1) * 100 < total) {
      const data = await listEvidenceLedger({ subject_kind: chain.subject_kind,
        subject_id: chain.subject_id, category: 'TRACK', page, size: 100 });
      if (!isCurrent()) return null;
      const items = data.items || [];
      const row = items.find(item => item.source_kind === 'TRACK' && item.layer === 'FUSED');
      if (row) {
        fused = { record_type: 'TRACK', record_id: row.source_id,
          occurred_at: row.captured_at ?? row.stored_at,
          availability: row.status === 'NO_POINTS' ? 'UNAVAILABLE' : 'AVAILABLE', summary: row };
        break;
      }
      total = Number(data.total);
      if (!Number.isFinite(total) || (!items.length && (page - 1) * 100 < total)) {
        throw new Error('融合轨迹资料未完整读取，请重试');
      }
      page += 1;
    }
  }
  return { ...chain,
    records: [...records.filter(record => evidenceDisplayType(record) !== 'TRACK'), ...(fused ? [fused] : [])],
    coverage: { ...chain.coverage, TRACK: { status: fused ? 'PRESENT' : coverage.status === 'FORBIDDEN' ? 'FORBIDDEN' : 'ABSENT',
      count: fused ? 1 : 0, broken_count: fused?.availability === 'UNAVAILABLE' ? 1 : 0, truncated: false } }
  };
}
