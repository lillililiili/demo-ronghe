import { reactive, readonly } from 'vue';

const M = window.MOCK;
const fallback = M.CONF.weather;

const state = reactive({
  city: M.CONF.city,
  text: fallback.text,
  temperature: null,
  tempLo: fallback.tempLo,
  tempHi: fallback.tempHi,
  windDirection: '',
  windPower: '',
  humidity: '',
  reportTime: '',
  source: 'Mock',
  loading: false,
  error: ''
});

let pending = null;

function callWeather(weather, method, city, optional = false) {
  return new Promise((resolve, reject) => {
    weather[method](city, (err, data) => {
      if (err) {
        if (optional) resolve(null);
        else reject(err);
        return;
      }
      resolve(data || null);
    });
  });
}

function normalizePower(value) {
  return String(value ?? '').replace(/级$/, '').trim();
}

export function refreshWeather() {
  if (pending) return pending;
  state.loading = true;
  state.error = '';
  pending = Promise.resolve().then(async () => {
    if (typeof window.AMapReady !== 'function') throw new Error('高德地图服务尚未加载');
    const AMap = await window.AMapReady();
    await new Promise(resolve => AMap.plugin('AMap.Weather', resolve));
    const weather = new AMap.Weather();
    const [live, forecast] = await Promise.all([
      callWeather(weather, 'getLive', '东营市'),
      callWeather(weather, 'getForecast', '东营市', true)
    ]);
    const today = forecast?.forecasts?.[0] || null;
    Object.assign(state, {
      city: (live?.city || M.CONF.city).replace(/市$/, ''),
      text: live?.weather || fallback.text,
      temperature: live?.temperature ?? null,
      tempLo: today?.nightTemp ?? fallback.tempLo,
      tempHi: today?.dayTemp ?? fallback.tempHi,
      windDirection: live?.windDirection || '',
      windPower: normalizePower(live?.windPower),
      humidity: live?.humidity || '',
      reportTime: live?.reportTime || '',
      source: '高德实况',
      error: ''
    });
    return state;
  }).catch(error => {
    state.error = error?.message || '实时天气获取失败';
    state.source = 'Mock';
    console.warn('[Weather] 高德实时天气获取失败，已使用本地降级数据：', error);
    return state;
  }).finally(() => {
    state.loading = false;
    pending = null;
  });
  return pending;
}

export const weatherState = readonly(state);
