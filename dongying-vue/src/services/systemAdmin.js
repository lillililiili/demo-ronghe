import { apiDownload, apiRequest } from './apiClient.js';

function query(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value != null) search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

const mutation = (path, method, body) => apiRequest(path, { method, body, mutation: true });

export const systemApi = {
  users: params => apiRequest(`/users${query(params)}`),
  user: id => apiRequest(`/users/${encodeURIComponent(id)}`),
  updateUser: (id, body) => mutation(`/users/${encodeURIComponent(id)}`, 'PATCH', body),
  setUserStatus: (id, body) => mutation(`/users/${encodeURIComponent(id)}/status`, 'PUT', body),
  resetPassword: (id, body) => mutation(`/users/${encodeURIComponent(id)}/reset-password`, 'POST', body),
  createUser: body => mutation('/users', 'POST', body),
  updateUserAccess: (id, body) => mutation(`/users/${encodeURIComponent(id)}/access`, 'PUT', body),
  deleteUser: (id, expectedVersion, reason) => mutation(
    `/users/${encodeURIComponent(id)}${query({ expected_version: expectedVersion })}`,
    'DELETE', { reason }
  ),

  organizations: () => apiRequest('/organizations'),
  createOrganization: body => mutation('/organizations', 'POST', body),
  updateOrganization: (id, body) => mutation(`/organizations/${encodeURIComponent(id)}`, 'PATCH', body),
  setOrganizationStatus: (id, body) => mutation(`/organizations/${encodeURIComponent(id)}/status`, 'PUT', body),
  districts: () => apiRequest('/districts'),
  createDistrict: body => mutation('/districts', 'POST', body),
  updateDistrict: (id, body) => mutation(`/districts/${encodeURIComponent(id)}`, 'PATCH', body),
  setDistrictStatus: (id, body) => mutation(`/districts/${encodeURIComponent(id)}/status`, 'PUT', body),

  roles: () => apiRequest('/roles'),
  role: code => apiRequest(`/roles/${encodeURIComponent(code)}`),
  permissions: () => apiRequest('/permissions/catalog'),
  createRole: body => mutation('/roles', 'POST', body),
  updateRole: (code, body) => mutation(`/roles/${encodeURIComponent(code)}`, 'PATCH', body),
  updateRolePermissions: (code, body) => mutation(`/roles/${encodeURIComponent(code)}/permissions`, 'PUT', body),
  deleteRole: (code, expectedVersion, reason) => mutation(
    `/roles/${encodeURIComponent(code)}${query({ expected_version: expectedVersion })}`,
    'DELETE', { reason }
  ),

  audits: params => apiRequest(`/audit-logs${query(params)}`),
  audit: id => apiRequest(`/audit-logs/${encodeURIComponent(id)}`),
  auditCsv: params => apiDownload(`/audit-logs/export.csv${query(params)}`)
};
