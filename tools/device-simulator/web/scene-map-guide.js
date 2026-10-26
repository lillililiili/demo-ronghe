(function (root) {
  'use strict';
  // Scene-authored, read-only route annotations. These never infer risk or alter a route.
  const roles = new Set(['start', 'turn', 'entry', 'end']);
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  const text = value => typeof value === 'string' ? value.trim().slice(0, 120) : '';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const markers = (Array.isArray(value.markers) ? value.markers : []).filter(row =>
      row && roles.has(row.role) && text(row.id) && text(row.label) && point(row.point)
    ).slice(0, 8).map(row => ({id: text(row.id), role: row.role, label: text(row.label), point: [...row.point]}));
    const directions = (Array.isArray(value.directions) ? value.directions : []).filter(row =>
      row && point(row.from) && point(row.to) && (row.from[0] !== row.to[0] || row.from[1] !== row.to[1])
    ).slice(0, 8).map(row => ({from: [...row.from], to: [...row.to]}));
    return markers.length || directions.length ? {
      title: text(value.title) || '场景路线导读', compactPaths: value.compactPaths === true, markers, directions
    } : null;
  }
  function projected(value, project) {
    try { const result = project(value); return point(result) ? [...result] : null; } catch { return null; }
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const characterWidth = char => /[^\x00-\xff]/.test(char) ? 13 : 7;
  function labelText(value, maxWidth) {
    let result = '', width = 0;
    for (const char of value) {
      const next = characterWidth(char);
      if (width + next > maxWidth) return {text: result + '…', width: width + 13};
      result += char; width += next;
    }
    return {text: result, width};
  }
  function layout(value, project, viewport = {}) {
    const guide = normalize(value);
    if (!guide || typeof project !== 'function') return {markers: [], directions: []};
    const width = Number.isFinite(viewport.width) && viewport.width >= 80 ? viewport.width : 1000;
    const height = Number.isFinite(viewport.height) && viewport.height >= 60 ? viewport.height : 650;
    const markers = guide.markers.map(row => ({...row, anchor: projected(row.point, project)})).filter(row =>
      row.anchor && row.anchor[0] >= -12 && row.anchor[0] <= width + 12 && row.anchor[1] >= -12 && row.anchor[1] <= height + 12);
    const occupied = (Array.isArray(viewport.obstacles) ? viewport.obstacles : []).filter(box =>
      box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) && box.width > 0 && box.height > 0
    ).map(box => ({...box}));
    occupied.push(...markers.map(row => ({x: row.anchor[0] - 10, y: row.anchor[1] - 10, width: 20, height: 20})));
    markers.forEach(row => {
      const label = labelText(row.label, Math.max(20, Math.min(240, width - 48)));
      const boxWidth = Math.min(width - 12, Math.max(74, label.width + 24)), boxHeight = 28;
      const [x, y] = row.anchor;
      const candidates = [
        [x - boxWidth / 2, y - 46], [x - boxWidth / 2, y + 18],
        [x + 20, y - 14], [x - boxWidth - 20, y - 14],
        [x - boxWidth / 2, y - 82], [x - boxWidth / 2, y + 54],
        [x + 20, y - 66], [x - boxWidth - 20, y - 66],
        [x + 20, y + 38], [x - boxWidth - 20, y + 38]
      ].map(([left, top]) => ({x: Math.max(6, Math.min(width - boxWidth - 6, left)),
        y: Math.max(6, Math.min(height - boxHeight - 6, top)), width: boxWidth, height: boxHeight}));
      let best = candidates[0], bestScore = Infinity;
      candidates.forEach((box, index) => {
        const score = occupied.reduce((total, other) => total + overlap(box, other), 0) * 1000 + index;
        if (score < bestScore) { best = box; bestScore = score; }
      });
      row.box = best; row.text = label.text;
      row.leader = [Math.max(best.x + 6, Math.min(best.x + best.width - 6, x)),
        Math.max(best.y, Math.min(best.y + best.height, y))];
      occupied.push({x: best.x - 4, y: best.y - 4, width: best.width + 8, height: best.height + 8});
    });
    const directions = guide.directions.map(row => ({from: projected(row.from, project), to: projected(row.to, project)}))
      .filter(row => row.from && row.to && Math.hypot(row.to[0] - row.from[0], row.to[1] - row.from[1]) >= 18)
      .map(row => ({x: (row.from[0] + row.to[0]) / 2, y: (row.from[1] + row.to[1]) / 2,
        angle: Math.atan2(row.to[1] - row.from[1], row.to[0] - row.from[0]) * 180 / Math.PI}));
    return {title: guide.title, markers, directions};
  }
  function render(value, project, viewport) {
    const guide = layout(value, project, viewport);
    if (!guide.markers.length && !guide.directions.length) return '';
    const arrows = guide.directions.map(row => `<g class="scene-guide-direction" transform="translate(${row.x},${row.y}) rotate(${row.angle})" aria-hidden="true"><path class="scene-guide-arrow-halo" d="M-15 0H15M8-6L15 0 8 6"/><path d="M-15 0H15M8-6L15 0 8 6"/></g>`).join('');
    const markers = guide.markers.map(row => {
      const [x, y] = row.anchor, box = row.box;
      return `<g class="scene-guide-marker scene-guide-${row.role}" role="img" aria-label="${escape(row.label)}（场景预设）"><title>${escape(row.label)}（场景预设）</title><path class="scene-guide-leader" d="M${x} ${y}L${row.leader.join(' ')}"/><circle class="scene-guide-point" cx="${x}" cy="${y}" r="5.5"/><rect class="scene-guide-label" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="5"/><text x="${box.x + box.width / 2}" y="${box.y + 19}" text-anchor="middle">${escape(row.text)}</text></g>`;
    }).join('');
    return `<g class="scene-map-guide" pointer-events="none" aria-label="${escape(guide.title)}（场景预设）">${arrows}${markers}</g>`;
  }
  const api = {normalize, layout, render};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SceneMapGuide = api;
})(typeof window !== 'undefined' ? window : globalThis);
