import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIncidentReports } from '../incident-groups.js';
import { displayDate, displayTimestamp, displayValue } from '../display.js';

const report = (id, facility, incident, day, kind='report') => ({id, facility_id:facility,
  approval_status:incident?'approved':'unapproved', event_date:day,
  approval:incident?{incident_id:incident,evidence_urls:[`https://example.com/${id}`]}:undefined,
  updates:[{post_id:Number(id),posted_at:`${day}T23:30:00+01:00`,kind,media_kind:'photo',summary:id}]});

test('explicit incident links join reports, preserve every source and correction without mutation', () => {
  const raw=[report('1','A','event','2025-02-02'),report('2','A','event','2025-02-03','correction')];
  const before=JSON.stringify(raw), groups=groupIncidentReports(raw);
  assert.equal(groups.length,1);
  assert.equal(groups[0].updates.length,2);
  assert.equal(groups[0].updates[1].kind,'correction');
  assert.equal(groups[0].approval.evidence_urls.length,2);
  assert.equal(groups[0].source_reports.length,2);
  assert.equal(JSON.stringify(raw),before);
});
test('same-day distinct incidents, other facilities, and unbound reports remain separate', () => {
  const raw=[report('1','A','one','2025-02-03'),report('2','A','two','2025-02-03'),
    report('3','B','one','2025-02-03'),report('4','A',null,'2025-02-03'),report('5','A',null,'2025-02-03')];
  assert.equal(groupIncidentReports(raw).length,5);
});
test('European dates retain the original calendar day and explicit source timezone', () => {
  assert.equal(displayDate('2025-02-02T23:30:00-03:00'),'02.02.2025');
  assert.equal(displayTimestamp('2025-02-02T23:30:00-03:00'),'02.02.2025 · 23:30 UTC-03:00');
  assert.equal(displayDate(null),'?');
  assert.equal(displayValue('Not established'),'?');
});
