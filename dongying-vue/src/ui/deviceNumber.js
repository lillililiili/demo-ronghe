const SIMULATOR_KINDS = {
  '5ga': '5G-A',
  tdoa: 'TDOA',
  radar: 'RADAR',
  eo: 'EO',
  weather: 'WX',
  countermeasure: 'CM'
};

function compactSimulatorId(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36).slice(-5).toUpperCase();
}

function compactGeneratedNumber(value, prefix) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= 20) return text;
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(36).slice(-7).toUpperCase()}`;
}

/**
 * Keep the simulator's technical identity out of narrow device lists while
 * retaining the complete value in the API object for search and operations.
 */
export function displayDeviceNo(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  const legacy = /^sim-\d{10}-([0-9a-f]{4})-(\d+)$/i.exec(text);
  if (legacy) return `SIM-${legacy[1]}-${legacy[2]}`;
  const match = /^map-sim-([a-z0-9]+)-(.+)$/i.exec(text);
  if (!match) return text;
  const kind = SIMULATOR_KINDS[match[1].toLowerCase()] || match[1].toUpperCase();
  const rawId = match[2];
  const compactId = rawId.match(/^d-[^-]+-([a-z0-9]+)$/i)?.[1]
    || (rawId.length <= 8 ? rawId : compactSimulatorId(rawId));
  return `${kind}-${compactId}`;
}

export const displayPlanNo = value => compactGeneratedNumber(value, 'PLN');
export const displayRouteNo = value => compactGeneratedNumber(value, 'RTE');
export const displayAirspaceNo = value => compactGeneratedNumber(value, 'ASP');
