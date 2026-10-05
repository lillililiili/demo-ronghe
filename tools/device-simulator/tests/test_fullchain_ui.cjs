const {test}=require('node:test');
const assert=require('node:assert/strict');
test('accepted without platform readback is explicitly unverified',()=>{
 const {coverageText}=require('../web/fullchain.js');
 assert.match(coverageText({submitted:10,accepted:10,processed:null}),/待回读/);
 assert.match(coverageText({submitted:10,accepted:10,processed:8}),/8/);
});
test('filter defaults cover all input families',()=>{
 const {categories}=require('../web/fullchain.js');
 for(const key of ['uav','bird','unknown','identifying','balloon','weather','airspaces','device_faults'])assert.ok(categories[key]);
});
