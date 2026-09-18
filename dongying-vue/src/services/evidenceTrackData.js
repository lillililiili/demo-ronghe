import { measuredMapPoints } from './trackPoints.js';

/** 展示分组不改写后端记录及其校验指纹；文件名不是证据类型的依据。 */
export function evidenceDisplayType(record) {
  return record?.summary?.kind_code === 'TRACK_SNAPSHOT' ? 'TRACK' : record?.record_type;
}

export function trackSnapshotRows(snapshot) {
  if (Array.isArray(snapshot?.points)) return snapshot.points;
  return Array.isArray(snapshot?.points?.items) ? snapshot.points.items : [];
}

/** 只消费标准观测字段；旧版坐标数组缺少坐标系和时序时不猜测。 */
export function prepareEvidenceTrack(rows = []) {
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
    const connected = previous && !point.break_before && !!point.track_id && previous.track_id === point.track_id
      && Number.isFinite(previous.point_seq) && point.point_seq === previous.point_seq + 1
      && Number.isFinite(previous.t) && Number.isFinite(point.t) && point.t > previous.t
      && previous.kind === point.kind;
    // 文件自带的关系字段不等于带计划/走廊依据的后台比对结果。
    return { ...point, point_id: source.point_id, break_before: !connected, corridor_relation: 'UNKNOWN',
      alt: Number.isFinite(source.altitude_amsl_m) ? source.altitude_amsl_m : null,
      speed: Number.isFinite(source.speed_mps) ? source.speed_mps : null,
      heading: Number.isFinite(source.heading_deg) ? source.heading_deg : null };
  });
  const timed = points.every((point, i) => Number.isFinite(point.t) && (!i || point.t > points[i - 1].t));
  return { points, rejected: input.length - points.length,
    breaks: points.slice(1).filter(point => point.break_before).length,
    canReplay: points.length > 1 && timed,
    timingIncomplete: points.length > 0 && !timed };
}
