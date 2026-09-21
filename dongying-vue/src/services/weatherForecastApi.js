import { apiRequestTimed } from './apiClient.js';

export const weatherForecastApi = {
  forPlan: planId => apiRequestTimed(`/flight-plans/${encodeURIComponent(planId)}/weather-forecast`)
};
