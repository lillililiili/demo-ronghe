// 只按后端气象原因码选择图形；未知类型保留通用标识。
const paths = {
  WEATHER_STRONG_WIND: 'M3 7h10a3 3 0 1 0-3-3M2 12h17a3 3 0 1 0-3-3M4 17h9a3 3 0 1 1-3 3',
  WEATHER_THUNDERSTORM: 'M7 14H6a4 4 0 0 1-.6-8A6 6 0 0 1 17 5a4.5 4.5 0 0 1 1 9h-1M12 11l-3 6h4l-2 5 6-8h-4l2-3M5 17l-1 3M20 17l-1 3',
  WEATHER_LOW_VISIBILITY: 'M5 10a3 3 0 0 1 .4-6 5 5 0 0 1 9.4 1A3 3 0 0 1 19 10M3 14h12m3 0h3M2 18h5m3 0h10M5 22h13'
};
const unknown = 'M6 16a4 4 0 0 1-.6-8A6 6 0 0 1 17 7a4.5 4.5 0 0 1 1 9M10 13a2 2 0 1 1 3 1.7c-1 .5-1 1-1 2M12 20h.01';

export function weatherRiskIcon(risk) {
  const reason = risk?.reason_code || risk?.reasonCode;
  const path = Object.hasOwn(paths, reason) ? paths[reason] : unknown;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}
