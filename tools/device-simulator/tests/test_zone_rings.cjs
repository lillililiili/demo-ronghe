const {test} = require('node:test');
const assert = require('node:assert/strict');
const ZoneRings = require('../web/zone-rings.js');

test('map airspace delivery preserves holes and closes open rings without changing the draft', () => {
  const zone = {points: [[0,0],[10,0],[10,10],[0,10]], holes: [[[2,2],[2,4],[4,4],[4,2],[2,2]]]};
  const before = JSON.stringify(zone);
  const result = ZoneRings.boundary(zone, ([x,y]) => [118 + x / 100, 37 + y / 100]);
  assert.equal(result.coordinates.length, 2);
  assert.equal(result.coordinates[0].length, 5);
  assert.equal(result.coordinates[1].length, 5);
  assert.deepEqual(result.coordinates[0][0], result.coordinates[0].at(-1));
  assert.deepEqual(result.coordinates[1][0], [118.02,37.02]);
  assert.equal(JSON.stringify(zone), before);
  assert.equal((ZoneRings.svgPath(zone, p => p).match(/M/g) || []).length, 2);
  assert.equal((ZoneRings.svgPath(zone, p => p).match(/Z/g) || []).length, 2);
});

test('ordinary single-ring zones keep their original boundary', () => {
  const zone = {points: [[1,1],[5,1],[3,4],[1,1]]};
  assert.deepEqual(ZoneRings.boundary(zone, p => [...p]), {type:'Polygon', coordinates:[zone.points]});
  assert.equal(ZoneRings.rings(zone).length, 1);
});
