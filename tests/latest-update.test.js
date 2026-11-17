import test from 'node:test';
import assert from 'node:assert/strict';
import { latestFacilityUpdate } from '../latest-update.js';
const record = {id:'A',operationalStatus:'unknown',incidents:[{date:'2026-07-23',description:'A fire was reported.'}]};
test('latest incident and later reopening claim share one chronological tile',()=>{
  const r={...record,statusClaims:[{asOf:'2026-07-28',status:'reopened',summary:'Operator said work resumed.',origin:'russia'}]};
  assert.equal(latestFacilityUpdate(r).title,'Reopening claimed');
  const newer={...r,incidents:[...r.incidents,{date:'2026-08-01',description:'New incident.'}]};
  assert.equal(latestFacilityUpdate(newer).summary,'New incident.');
  assert.equal(r.incidents.length,1);
});
test('dated source correction can supersede an event without moving its event date',()=>{
  const reports=[{facility_id:'A',updates:[{kind:'correction',posted_at:'2026-07-25T10:00:00+03:00',summary:'Identity corrected.',source_url:'https://example.com/post'}]},{facility_id:'B',updates:[{posted_at:'2026-08-01',summary:'Different site.'}]}];
  const latest=latestFacilityUpdate(record,reports);
  assert.equal(latest.kind,'source');assert.equal(latest.title,'Source correction');
  assert.equal(latest.source.url,'https://example.com/post');assert.equal(record.incidents[0].date,'2026-07-23');
});
test('operating updates and undated records stay distinct',()=>{
  assert.equal(latestFacilityUpdate({...record,operationalStatus:'reopened',statusAsOf:'2026-07-30'}).kind,'operation');
  assert.equal(latestFacilityUpdate({id:'A',incidents:[],statusClaim:{status:'reopened'}}),null);
});
