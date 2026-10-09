import { ApiError, apiDownload, apiRequestTimed, readSessionToken } from './apiClient.js';
import { authUser } from './auth.js';
import { serverNow } from './serverClock.js';

// 只保留最近一次成功查询，短暂跨路由复用；不写本地存储、不跨登录或权限变化。
const CACHE_MS = 60_000;
let lastReport = null;
let accessVersion = 0;
let requestSequence = 0;
const accessKey = () => `${readSessionToken()}\u0000${JSON.stringify(authUser.value)}`;
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(serverNow());
let knownAccess = accessKey();
function clearReport() { lastReport = null; accessVersion += 1; }
function checkAccess() {
  const current = accessKey();
  if (current !== knownAccess) { clearReport(); knownAccess = current; }
}
window.addEventListener('auth-access-change', checkAccess);
window.addEventListener('api:unauthorized', clearReport);
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('auth-access-change', checkAccess);
  window.removeEventListener('api:unauthorized', clearReport);
});

function cachedOperations(params) {
  checkAccess();
  const cached = lastReport;
  if (!cached || !cached.token || cached.token !== readSessionToken() || cached.day !== today() || Date.now() - cached.at >= CACHE_MS) {
    lastReport = null;
    return null;
  }
  if (params && (params.from !== cached.data.from || params.to !== cached.data.to
    || (params.owner_org_id || '') !== cached.org)) return null;
  return cached.data;
}

async function operations(params) {
  checkAccess();
  const token = readSessionToken(), version = accessVersion, sequence = ++requestSequence;
  try {
    const data = mapOperations(await apiRequestTimed(`/stats/operations${query({ ...params, include_observations: false })}`, {}, 20_000));
    if (version !== accessVersion || token !== readSessionToken())
      throw new ApiError('登录或权限已变化，请重新读取统计。', 'SESSION_CHANGED', 409);
    if (sequence === requestSequence) lastReport = { token, at: Date.now(), day: today(), org: params?.owner_org_id || '', data };
    return data;
  } catch (error) {
    if (sequence === requestSequence && [401, 403].includes(error?.status)) clearReport();
    throw error;
  }
}

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
    observationMetrics: data.observation_metrics ?? null,
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
  operations,
  cachedOperations,
  accessVersion: () => accessVersion,
  exportCsv: params => apiDownload(`/stats/operations/export.csv${query(params)}`)
};
