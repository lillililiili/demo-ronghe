/* 表格工具条和下拉选项共用：菜单按文案撑开，避免「待执行」被挤成「待…」。 */
export function selectMenuMinWidth(options) {
  const longest = Math.max(4, ...(options || []).map(item => {
    const text = item && typeof item === 'object' ? (item.label ?? item.t ?? item.value ?? '') : item;
    return String(text ?? '').length;
  }));
  return Math.min(320, Math.max(136, longest * 14 + 52));
}

export function selectMenuProps(options) {
  return { class: 'u-select-menu', style: { minWidth: selectMenuMinWidth(options) + 'px' } };
}

export const SELECT_DROPDOWN = {
  consistentMenuWidth: false
};
