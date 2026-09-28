// 详情和选中点共用同一可见区域，预留图标、状态角标及底部工具栏空间。
export function selectionLayout(stage, options = {}) {
  const leftDock = stage.querySelector('.sit-device-dock');
  const rightDock = stage.querySelector('.sit-alert-dock');
  const left = (leftDock ? leftDock.offsetLeft + leftDock.offsetWidth : 0) + 12;
  const right = (rightDock ? rightDock.offsetLeft : stage.clientWidth) - 12;
  const top = 64;
  const bottom = stage.clientHeight - 84;
  const width = Math.max(1, right - left);
  const group = stage.querySelector('.sit-selection-group');
  const videoOpen = options.videoOpen ?? (group?.dataset.videoOpen === 'true');
  const videoExpanded = options.videoExpanded ?? (group?.dataset.videoExpanded === 'true');
  const stacked = videoOpen && !videoExpanded && width < 652;
  const popupWidth = Math.min(videoOpen && !stacked ? (videoExpanded ? 820 : 732) : 360, width);
  const sideBySide = width >= popupWidth + 160;
  const maxHeight = Math.max(100, bottom - top - (sideBySide ? 0 : 132));
  return {
    left, right, top, bottom, width: popupWidth, maxHeight: videoExpanded ? bottom - top : maxHeight, stacked,
    point: sideBySide
      ? [(left + popupWidth + right) / 2, (top + bottom) / 2]
      : [(left + right) / 2, bottom - 56]
  };
}

// 信息紧邻真实投影点，拖动/缩放时跟随；空间不足时翻转，保持在两侧列表之间。
export function selectionPopupPosition(layout, anchor, height) {
  if (!anchor?.every(Number.isFinite)) return { left: layout.left, top: layout.top };
  const [x, y] = anchor;
  const gap = 36;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let left, top;
  if (x + gap + layout.width <= layout.right) {
    left = x + gap;
    top = y - height / 2;
  } else if (x - gap - layout.width >= layout.left) {
    left = x - gap - layout.width;
    top = y - height / 2;
  } else {
    left = x - layout.width / 2;
    top = y - gap - height >= layout.top ? y - gap - height : y + 60;
  }
  return {
    left: clamp(left, layout.left, layout.right - layout.width),
    top: clamp(top, layout.top, layout.bottom - height)
  };
}
