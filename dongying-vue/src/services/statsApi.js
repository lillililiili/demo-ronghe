import { apiDownload, apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value != null) search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

const number = value => value == null ? null : Number(value);

function named(list) {
  return (list || []).map(item => ({ name: item.name, value: number(item.value) }));
}

export function mapOperations(data) {
  const summary = data.summary || {};
  const devices = data.devices;
  return {
    from: data.from,
    to: data.to,
    sourceMode: data.source_mode,
    simulated: !!data.simulated,
    generatedAt: data.generated_at ?? null,
    availability: data.availability || {},
    total: number(summary.total),
    illegal: number(summary.illegal),
    punish: number(summary.punish),
    highRisk: number(summary.high_risk),
    altTotal: number(data.alt_total),
    days: (data.days || []).map(day => ({
      date: day.date, md: day.md, total: number(day.total), illegal: number(day.illegal),
      punish: number(day.punish), highRisk: number(day.high_risk)
    })),
    regions: (data.regions || []).map(row => ({
      name: row.name, total: number(row.total), illegal: number(row.illegal),
      punish: number(row.punish), highRisk: number(row.high_risk)
    })),
    byRisk: named(data.by_risk),
    byType: named(data.by_type),
    byDuration: named(data.by_duration),
    byTrack: named(data.by_track),
    altBands: named(data.alt_bands),
    byPenalty: named(data.by_penalty),
    partners: (data.partners || []).map(row => ({
      name: row.name, n: number(row.case_count), fine: number(row.fine)
    })),
    devices: devices
      ? { total: number(devices.total), online: number(devices.online), onlineRate: devices.online_rate }
      : null
  };
}

export const statsApi = {
  operations: params => apiRequest(`/stats/operations${query(params)}`).then(mapOperations),
  exportCsv: params => apiDownload(`/stats/operations/export.csv${query(params)}`)
};
