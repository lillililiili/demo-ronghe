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

// 内网演示只读既有 Mock；保留异步接口，供将来接入已授权的内网天气服务。
export function refreshWeather() {
  if (pending) return pending;
  state.loading = true;
  state.error = '';
  pending = Promise.resolve().then(() => {
    Object.assign(state, {
      city: M.CONF.city,
      text: M.CONF.weather.text,
      temperature: null,
      tempLo: M.CONF.weather.tempLo,
      tempHi: M.CONF.weather.tempHi,
      windDirection: '', windPower: '', humidity: '', reportTime: '',
      source: 'Mock 演示数据',
      error: ''
    });
    return state;
  }).finally(() => {
    state.loading = false;
    pending = null;
  });
  return pending;
}

export const weatherState = readonly(state);
