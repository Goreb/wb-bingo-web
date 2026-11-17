import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentPresentation, operationPresentation, operationStatusMatches } from '../facility-status.js';
import { statusPresentation } from '../status.js';
import { normalizeRecords } from '../data.js';
const record = incidents => ({incidents,hasIncident:incidents.length>0,operationalStatus:'unknown',inheritedDamage:null});
const event=(id,date,description)=>({id,date,description});
test('attack history never implies shutdown; fire alone is not labelled an attack',()=>{
  const r=record([event('a','2025-01-01','Reuters reports a fire. Cause is unknown.')]);
  assert.equal(incidentPresentation(r).key,'unknown');
  assert.equal(incidentPresentation(r).label,'Fire reported');
  assert.equal(operationPresentation(r,statusPresentation(r)).key,'unknown');
  assert.equal(operationPresentation(record([]),statusPresentation(record([]))).key,'unknown');
});
test('multiple attack dates exclude repeat same-day reports and operational updates',()=>{
  const r=record([event('a','2025-01-01','The refinery was struck by drones.'),event('b','2025-01-01','A drone attack hit the refinery.'),event('HALT-UPDATE','2025-01-02','Reuters says operations halted after the drone attack.')]);
  assert.equal(incidentPresentation(r).key,'attacked');
  r.incidents.push(event('c','2025-02-02','Forces struck the refinery.'));
  assert.equal(incidentPresentation(r).key,'multiple_attacks');
  r.operationalStatus='reopened';
  assert.equal(operationPresentation(r,statusPresentation(r)).key,'resumed');
});
test('historical destruction does not become a permanent operational closure',()=>{
  const r={...record([]),inheritedDamage:5};
  assert.equal(incidentPresentation(r).key,'destroyed');
  assert.equal(operationPresentation(r,statusPresentation(r)).label,'Offline');
  assert.equal(operationStatusMatches(r,'stopped'),true);
  assert.equal(operationStatusMatches(r,'unknown'),false);
  assert.equal(r.operationalStatus,'unknown');
  r.lastIncident='2026-01-01'; r.operationalStatus='reopened'; r.statusAsOf='2026-02-01';
  assert.equal(operationPresentation(r,statusPresentation(r)).key,'resumed');
  r.statusAsOf='2025-12-01';
  assert.equal(operationPresentation(r,statusPresentation(r)).key,'stopped');
});
test('normalization preserves exact incident IDs needed by source grouping',()=>{
  const [r]=normalizeRecords([{id:'A',name:'Example',facility_type:'refinery',incidents:[event('canonical-event','2025-01-01','Report')]}],{id:'test',label:'Test'},[{id:'refinery'}]);
  assert.equal(r.incidents[0].id,'canonical-event');
});

test('descriptive event labels do not promote attack or operation claims',()=>{
  const fire=record([event('fire','2025-01-01','A major warehouse fire was reported.')]);
  assert.equal(incidentPresentation(fire).label,'Major fire reported');
  assert.equal(incidentPresentation(fire).key,'unknown');
  const explosion=record([event('blast','2025-01-01','An explosion occurred; cause unknown.')]);
  assert.equal(incidentPresentation(explosion).label,'Explosion reported');
  assert.equal(operationPresentation(explosion,statusPresentation(explosion)).key,'unknown');
  const denied=record([event('denial','2025-01-01','No fire was reported.')]);
  assert.equal(incidentPresentation(denied).label,'?');
});

test('compact operational labels and filters preserve detailed states',()=>{
  for (const [status,label] of [['operating','Online'],['reopened','Online'],['partially_reopened','Affected'],['temporarily_closed','Offline'],['permanently_closed','Closed'],['disrupted','Affected'],['damaged','Affected']]) {
    const r={...record([]),operationalStatus:status};
    assert.equal(operationPresentation(r,statusPresentation(r)).label,label);
    if (['Online','Offline','Affected','Closed'].includes(label)) assert.equal(operationStatusMatches(r,label.toLowerCase()),true);
    assert.equal(r.operationalStatus,status);
  }
});

test('newer reopening claims use muted claim styling without changing supported status',()=>{
  const r={...record([event('hit','2026-07-23','Warehouse attacked.')]),operationalStatus:'temporarily_closed',statusAsOf:'2026-07-23',statusClaim:{unverified:true,status:'reopened',asOf:'2026-07-28',origin:'russia'}};
  const shown=operationPresentation(r,statusPresentation(r));
  assert.equal(shown.tone,'claimed-reopened');
  assert.equal(shown.label,'Reopening claimed');
  assert.equal(shown.asOf,'2026-07-28');
  assert.equal(r.operationalStatus,'temporarily_closed');
  assert.equal(operationStatusMatches(r,'online'),false);
  r.statusAsOf='2026-08-01';
  assert.equal(operationPresentation(r,statusPresentation(r)).tone,'closed');
});
