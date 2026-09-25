// 详情和选中点共用同一可见区域，预留图标、状态角标及底部工具栏空间。
export function selectionLayout(stage) {
  const leftDock = stage.querySelector('.sit-device-dock');
  const rightDock = stage.querySelector('.sit-alert-dock');
  const left = (leftDock ? leftDock.offsetLeft + leftDock.offsetWidth : 0) + 12;
  const right = (rightDock ? rightDock.offsetLeft : stage.clientWidth) - 12;
  const top = 64;
  const bottom = stage.clientHeight - 84;
  const width = Math.max(1, right - left);
  const popupWidth = Math.min(360, width);
  const sideBySide = width >= popupWidth + 160;
  const maxHeight = Math.max(100, bottom - top - (sideBySide ? 0 : 132));
  return {
    left, top, width: popupWidth, maxHeight,
    point: sideBySide
      ? [(left + popupWidth + right) / 2, (top + bottom) / 2]
      : [(left + right) / 2, bottom - 56]
  };
}
