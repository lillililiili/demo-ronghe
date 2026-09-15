// 只呈现引擎已保存的走廊不匹配事实；PARTIAL 可能只是身份缺失，不能当作偏航。
export function hasRouteDeviation(match) {
  return match?.availability === 'AVAILABLE' && (match.hit_details_c01 || []).some(hit => hit.facts?.dimensions?.corridor === 'MISMATCH');
}
