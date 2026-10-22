(function (root) {
  'use strict';
  const rings = zone => [zone.points, ...(zone.holes || [])];
  function boundary(zone, coordinates) {
    return {type: 'Polygon', coordinates: rings(zone).map(ring => {
      const result = ring.map(point => coordinates(point));
      const first = result[0], last = result.at(-1);
      if (first && (first[0] !== last[0] || first[1] !== last[1])) result.push([...first]);
      return result;
    })};
  }
  function svgPath(zone, project) {
    return rings(zone).map(ring => ring.map((point, index) => `${index ? 'L' : 'M'}${project(point).join(' ')}`).join(' ') + ' Z').join(' ');
  }
  const api = {rings, boundary, svgPath};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoneRings = api;
})(typeof window !== 'undefined' ? window : globalThis);
