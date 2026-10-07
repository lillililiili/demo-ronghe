import { weatherAnchor, weatherPolygon } from '../../services/weatherRiskGeometry.js';

// 位置只取本条风险的事实；不以航线、其他目标或当前状态推算事件坐标。
export function planRiskLocation(risk) {
  if (risk?.risk_type === 'WEATHER') {
    const polygon = weatherPolygon(risk.weather_fact);
    const anchor = weatherAnchor(risk.weather_fact);
    return anchor && polygon ? { anchor, polygon, label: '气象影响范围' } : null;
  }
  if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk?.risk_type)) return null;
  const values = [risk.space_fact?.longitude, risk.space_fact?.latitude];
  if (values.some(value => value == null || typeof value === 'boolean' || String(value).trim() === '')) return null;
  const [lon, lat] = values.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 85.051129) return null;
  return { anchor: [lon, lat], polygon: null, label: '事件位置' };
}

export function planRiskLocationNote(risk) {
  if (planRiskLocation(risk)) return risk.risk_type === 'WEATHER' ? '气象影响范围' : '事件位置，非实时位置';
  if (risk?.risk_type === 'WEATHER') {
    if (risk.weather_loading) return '正在读取气象范围';
    if (risk.weather_error) return '气象范围读取失败，无法定位';
    return '气象范围未知，无法定位';
  }
  return '事件位置未知，无法定位';
}
