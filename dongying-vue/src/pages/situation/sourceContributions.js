const STATUS = { CURRENT: '当前有效', EXPIRED: '观测过期', HISTORICAL: '历史关联', UNAVAILABLE: '当前不可用', UNKNOWN: '融合状态未知' };
const ATTRIBUTES = { position: '位置', class: '识别', identity: '身份', motion: '运动' };
const TYPES = { RADAR: '雷达', TDOA: 'TDOA', EO: '光电', FIVE_G_A: '5G-A', AOA: 'AOA' };
export function sourceContributionCards(target, devices = []) {
  const links = Array.isArray(target?.sourceLinks) ? target.sourceLinks
    : (target?.sourceDeviceIds || []).map(id => ({ link_id: `legacy:${id}`, device_id: id }));
  // Older detail has relationships only; an online device is never proof of contribution.
  return links.map(link => {
    const device = devices.find(item => (item.fusionDeviceId || item.deviceId) === link.device_id);
    const status = STATUS[link.fusion_status] ? link.fusion_status : 'UNKNOWN';
    const attrs = status === 'CURRENT' && Array.isArray(link.contribution_attributes)
      ? link.contribution_attributes.map(value => ATTRIBUTES[value]).filter(Boolean) : [];
    return { key: link.link_id, device, name: TYPES[link.source_type] || device?.type || link.source_name || '来源',
      status: attrs.length ? `${attrs.join('／')}有效` : STATUS[status],
      current: status === 'CURRENT', observedAt: link.observation_at ?? null,
      reason: link.fusion_reason || '', color: device?.color || 'var(--cyan)' };
  });
}
