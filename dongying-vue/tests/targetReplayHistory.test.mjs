import test from 'node:test';
import assert from 'node:assert/strict';
import { targetReplayHistory } from '../src/services/targetReplayHistory.js';

test('replays both fusion segments in time order without joining their gap or raw sources', async () => {
  for (const shift of [0, 987654]) {
    const id = `target-${shift}`;
    const api = {
      tracksAll: async target => { assert.equal(target,id); return { items: [
        { track_id:'new',layer:'FUSED' }, { track_id:'raw',layer:'RAW' }, { track_id:'old',layer:'FUSED' }
      ] }; },
      pointsAll: async track => ({ items: (track === 'old' ? [10,20] : [80,90]).map((t,i) => ({ observed_at:t+shift,point_seq:i,point_id:`${track}-${i}` })) })
    };
    const rows = await targetReplayHistory(api,id);
    assert.deepEqual(rows.map(r=>r.observed_at),[10,20,80,90].map(t=>t+shift));
    assert.deepEqual(rows.map(r=>r.break_before),[true,false,true,false]);
    assert.deepEqual(rows.map(r=>r.track_id),['old','old','new','new']);
  }
});
test('failed segment does not become a partial successful history',async()=>{
  const api={tracksAll:async()=>({items:[{track_id:'a',layer:'FUSED'}]}),pointsAll:async()=>{throw new Error('denied');}};
  await assert.rejects(targetReplayHistory(api,'another-target'),/denied/);
});
