const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

// Business timestamps share the same timezone as reporting and plan windows.
export function businessDateTime(value, fallback = '') {
  if (value == null || value === '') return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : formatter.format(date);
}

export function businessClock(value, fallback = '') {
  const text = businessDateTime(value);
  return text ? text.slice(11) : fallback;
}
