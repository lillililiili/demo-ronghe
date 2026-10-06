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

function rectFromAnchor(anchor, padding = 18) {
  if (!anchor?.every(Number.isFinite)) return null;
  return { left: anchor[0] - padding, right: anchor[0] + padding,
    top: anchor[1] - padding, bottom: anchor[1] + padding };
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function clampRect(rect, layout, height) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  return {
    left: clamp(rect.left, layout.left, layout.right - layout.width),
    top: clamp(rect.top, layout.top, layout.bottom - height)
  };
}

// 信息紧邻真实投影点，拖动/缩放时跟随；空间不足时翻转，并避开被选中的点或航线范围。
export function selectionPopupPosition(layout, anchor, height, avoidRect = null) {
  if (!anchor?.every(Number.isFinite)) return { left: layout.left, top: layout.top };
  const [x, y] = anchor;
  const gap = 36;
  const obstacle = avoidRect && [avoidRect.left, avoidRect.right, avoidRect.top, avoidRect.bottom]
    .every(Number.isFinite) ? avoidRect : rectFromAnchor(anchor);
  const centerY = (obstacle.top + obstacle.bottom) / 2;
  const centerX = (obstacle.left + obstacle.right) / 2;
  const candidates = [
    { left: obstacle.right + gap, top: centerY - height / 2 },
    { left: obstacle.left - gap - layout.width, top: centerY - height / 2 },
    { left: centerX - layout.width / 2, top: obstacle.bottom + gap },
    { left: centerX - layout.width / 2, top: obstacle.top - gap - height },
    { left: x + gap, top: y - height / 2 },
    { left: x - gap - layout.width, top: y - height / 2 },
    { left: x - layout.width / 2, top: y - gap - height },
    { left: x - layout.width / 2, top: y + gap }
  ];
  const fits = candidate => candidate.left >= layout.left && candidate.left + layout.width <= layout.right
    && candidate.top >= layout.top && candidate.top + height <= layout.bottom;
  const positioned = candidates.map(candidate => ({
    raw: candidate, rect: { left: candidate.left, right: candidate.left + layout.width,
      top: candidate.top, bottom: candidate.top + height }
  }));
  const clear = positioned.find(candidate => fits(candidate.raw) && !overlaps(candidate.rect, obstacle));
  if (clear) return clear.raw;
  // 地图很窄时四周可能都放不下，选择遮挡面积最小的位置，再限制在可见区域内。
  const scored = positioned.map(candidate => {
    const clipped = clampRect(candidate.raw, layout, height);
    const rect = { left: clipped.left, right: clipped.left + layout.width,
      top: clipped.top, bottom: clipped.top + height };
    const overlapWidth = Math.max(0, Math.min(rect.right, obstacle.right) - Math.max(rect.left, obstacle.left));
    const overlapHeight = Math.max(0, Math.min(rect.bottom, obstacle.bottom) - Math.max(rect.top, obstacle.top));
    return { position: clipped, score: overlapWidth * overlapHeight };
  }).sort((left, right) => left.score - right.score);
  return scored[0]?.position || { left: layout.left, top: layout.top };
}
