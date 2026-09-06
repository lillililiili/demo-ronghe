import { apiDownload, apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value != null) search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

function named(list) {
  return (list || []).map(item => ({ name: item.name, value: item.value || 0 }));
}

export function mapOperations(data) {
  const summary = data.summary || {};
  const devices = data.devices;
  return {
    from: data.from,
    to: data.to,
    sourceMode: data.source_mode,
    simulated: !!data.simulated,
    total: summary.total || 0,
    illegal: summary.illegal || 0,
    punish: summary.punish || 0,
    highRisk: summary.high_risk || 0,
    altTotal: data.alt_total || 0,
    days: (data.days || []).map(day => ({
      date: day.date, md: day.md, total: day.total || 0, illegal: day.illegal || 0,
      punish: day.punish || 0, highRisk: day.high_risk || 0
    })),
    regions: (data.regions || []).map(row => ({
      name: row.name, total: row.total || 0, illegal: row.illegal || 0,
      punish: row.punish || 0, highRisk: row.high_risk || 0
    })),
    byRisk: named(data.by_risk),
    byType: named(data.by_type),
    byDuration: named(data.by_duration),
    byTrack: named(data.by_track),
    altBands: named(data.alt_bands),
    byPenalty: named(data.by_penalty),
    partners: (data.partners || []).map(row => ({
      name: row.name, n: row.case_count || 0, fine: row.fine || 0
    })),
    devices: devices
      ? { total: devices.total || 0, online: devices.online || 0, onlineRate: devices.online_rate }
      : null
  };
}

export const statsApi = {
  operations: params => apiRequest(`/stats/operations${query(params)}`).then(mapOperations),
  exportCsv: params => apiDownload(`/stats/operations/export.csv${query(params)}`)
};
