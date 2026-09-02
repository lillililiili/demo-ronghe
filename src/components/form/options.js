/* 下拉/单选/多选选项归一：字符串、{v,t}、{value,label} 都能用。 */
export function optionsOf(list) {
  return (list || []).map(item => {
    if (item == null) return { label: '', value: '' };
    if (typeof item === 'string' || typeof item === 'number') return { label: String(item), value: item };
    if (item.t != null && item.v != null) return { label: item.t, value: item.v, disabled: !!item.disabled, html: item.html };
    return { label: item.label, value: item.value, disabled: !!item.disabled, html: item.html };
  });
}
