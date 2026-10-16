import { measuredMapPoints } from './trackPoints.js';

/** 展示分组不改写后端记录及其校验指纹；文件名不是证据类型的依据。 */
export function evidenceDisplayType(record) {
  return record?.summary?.kind_code === 'TRACK_SNAPSHOT' ? 'TRACK' : record?.record_type;
}

export function trackSnapshotRows(snapshot) {
  if (Array.isArray(snapshot?.points)) return snapshot.points;
  return Array.isArray(snapshot?.points?.items) ? snapshot.points.items : [];
}

/** 使用已重新授权的记录元数据，不依赖打开弹窗时可能不完整的摘要。 */
export function evidenceTrackSnapshot(trackId, detail, points) {
  const entry = detail?.entry;
  if (entry?.source_kind !== 'TRACK' || entry.source_id !== trackId) throw new Error('返回的轨迹证据与当前记录不一致，请重新读取');
  return { points, layer: entry.layer, source_mode: entry.source_mode };
}

async function completePages(read, key, isCurrent) {
  const items = [], seen = new Set();
  let expected;
  for (let page = 1; isCurrent(); page += 1) {
    const result = await read({ page, size: 100 });
    if (!isCurrent()) return null;
    const batch = result?.items, total = result?.total;
    if (!Array.isArray(batch) || !Number.isSafeInteger(total) || total < 0
      || (expected != null && total !== expected)) throw new Error('轨迹分页不完整或已变化，请重新读取');
    expected = total;
    if (expected > 50000) throw new Error('轨迹超过五万条，暂时无法完整回放');
    for (const item of batch) {
      if (!item?.[key] || seen.has(item[key])) throw new Error('轨迹分页不完整或有重复，请重新读取');
      seen.add(item[key]); items.push(item);
    }
    if (items.length === expected) return items;
    if (!batch.length || items.length > expected) throw new Error('轨迹分页不完整，请重新读取');
  }
  return null;
}

/** 同一目标、同一来源的全部已留存分段，截止所选研判；不把其他设备或后续观测接进来。 */
export async function loadEvidenceTrackHistory(api, {
  targetId, trackId, through, recordedThrough = through, isCurrent = () => true
}) {
  if (!targetId || !trackId || !Number.isFinite(through) || through <= 0 || !Number.isFinite(recordedThrough))
    throw new Error('缺少本次研判的目标或时刻，无法读取完整轨迹');
  const tracks = await completePages(params => api.tracks(targetId,
    { ...params, started_from: 0, started_to: through }), 'track_id', isCurrent);
  if (!tracks) return null;
  const reference = tracks.find(track => track.track_id === trackId && track.target_id === targetId);
  if (!reference) throw new Error('本次引用的轨迹不在该目标的可见时段内，请重新读取');
  const sourceKeys = ['link_id', 'source_id', 'device_id', 'source_mode'];
  if (!['RAW', 'FUSED'].includes(reference.layer)
    || (reference.layer === 'RAW' && sourceKeys.some(key => !reference[key])))
    throw new Error('轨迹来源关联不完整，无法合并历史分段；请查看本次引用片段');
  const selected = tracks.filter(track => track.target_id === targetId && track.layer === reference.layer
    && (track.started_at == null || track.started_at <= through)
    && (reference.layer === 'FUSED' || sourceKeys.every(key => track[key] === reference[key])));
  const items = [];
  let segmentCount = 0;
  for (const track of selected) {
    const rows = await completePages(params => api.points(track.track_id,
      { ...params, time_from: 0, time_to: through }), 'point_id', isCurrent);
    if (!rows) return null;
    let interrupted = true, previous = null, included = false;
    for (const row of rows) {
      if (row.track_id !== track.track_id) throw new Error('轨迹观测点与所选记录不一致，请重新读取');
      if (!Number.isFinite(row.observed_at) || row.observed_at > through
        || (Number.isFinite(row.received_at) && row.received_at > recordedThrough)) {
        interrupted = true; continue;
      }
      items.push({ ...row, break_before: interrupted || row.break_before === true
        || (previous != null && row.observed_at < previous.observed_at) });
      interrupted = false; previous = row; included = true;
      if (items.length > 50000) throw new Error('历史轨迹超过五万点，暂时无法完整回放');
    }
    if (included) segmentCount += 1;
  }
  if (!isCurrent()) return null;
  items.sort((a, b) => a.observed_at - b.observed_at || String(a.track_id).localeCompare(String(b.track_id)) || a.point_seq - b.point_seq);
  return { points: { items, total: items.length }, layer: reference.layer, source_mode: reference.source_mode,
    segment_count: segmentCount, through };
}

/** 只消费标准观测字段；旧版坐标数组缺少坐标系和时序时不猜测。 */
export function prepareEvidenceTrack(rows = [], { layer } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const sources = new Map();
  const normalized = input.map((row, index) => {
    if (!row || Array.isArray(row)) return {};
    // 临时索引仅用于取回同一行的附加字段，输出恢复原始 point_id。
    const point = { ...row, point_id: index,
      observed_at: Number.isFinite(row.observed_at) ? row.observed_at : null, sort_time: null,
      location: row.location || (row.coordinate_system === 'WGS84' ? row : {}) };
    sources.set(point.point_id, row);
    return point;
  });
  const points = measuredMapPoints(normalized).map((point, index, all) => {
    const source = sources.get(point.point_id) || {};
    const previous = all[index - 1];
    // RAW 序号由来源适配器定义，可用毫秒时间或稀疏设备序号；不能据差值推断丢点。
    // FUSED 保持平台连续序号约束；层级缺失的旧文件不猜测为 RAW。
    const sequenceContinues = previous && Number.isFinite(previous.point_seq) && Number.isFinite(point.point_seq)
      && (layer === 'RAW' ? point.point_seq > previous.point_seq : point.point_seq === previous.point_seq + 1);
    const connected = previous && !point.break_before && !!point.track_id && previous.track_id === point.track_id
      && sequenceContinues
      && Number.isFinite(previous.t) && Number.isFinite(point.t) && point.t >= previous.t
      && previous.kind === point.kind;
    // 文件自带的关系字段不等于带计划/走廊依据的后台比对结果。
    return { ...point, point_id: source.point_id, track_layer: layer, break_before: !connected, corridor_relation: 'UNKNOWN',
      alt: Number.isFinite(source.altitude_amsl_m) ? source.altitude_amsl_m : null,
      agl: Number.isFinite(source.height_agl_m) ? source.height_agl_m : null,
      speed: Number.isFinite(source.speed_mps) ? source.speed_mps : null,
      heading: Number.isFinite(source.heading_deg) ? source.heading_deg : null };
  });
  // 多来源融合可在同一观测时刻追加结果；保留序号及全部点，只有倒序才属于异常。
  const timed = points.every((point, i) => Number.isFinite(point.t) && (!i || point.t >= points[i - 1].t));
  return { points, rejected: input.length - points.length,
    breaks: points.slice(1).filter(point => point.break_before).length,
    stationary: points.length > 1 && points.every(point => point.lon === points[0].lon && point.lat === points[0].lat),
    canReplay: points.length > 1 && timed && points.at(-1).t > points[0].t,
    timingIncomplete: points.length > 0 && !timed };
}

/** 证据链里可与轨迹同步播放的光电录像（只取在库的录像文件，采集时刻即录像开始时刻）。 */
export function chainVideos(records = []) {
  return (records || []).filter(record => record?.record_type === 'VIDEO' && record.summary?.kind_code === 'EO_VIDEO'
    && record.availability !== 'UNAVAILABLE' && Number.isFinite(record.occurred_at))
    .map(record => ({ id: record.record_id, no: record.summary.evidence_no, capturedAt: record.occurred_at,
      status: record.summary.status }));
}
