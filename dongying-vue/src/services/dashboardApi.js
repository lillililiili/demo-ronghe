import { apiRequestTimed } from '@/services/apiClient.js';

export function getDashboardSnapshot() {
  return apiRequestTimed('/dashboard/snapshot');
}
