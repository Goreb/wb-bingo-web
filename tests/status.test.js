import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyStatusClaims, explicitOriginFlag, statusPresentation } from '../status.js?v=status-v3-20261020';
import { normalizeRecords, selectRecords } from '../data.js?v=status-v3-20261020';

const [catalog, reviewed, statusClaimOverlay] = await Promise.all([
  readFile(new URL('../data/catalog.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../data/reviewed-facilities.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../data/status-claims.json', import.meta.url), 'utf8').then(JSON.parse)
]);
const dataset = catalog.datasets.find(item => item.id === 'reviewed-facilities');
const normalized = normalizeRecords(reviewed, dataset, catalog.categories);
const byId = id => normalized.find(record => record.id === id);
const present = record => statusPresentation(record);

test('a recorded incident is amber with unknown operation; no reviewed incident history stays gray', () => {
  const selectel = byId('RU-DC-018');
  const vk = byId('RU-DC-VK-PETERSBURG-001');
  assert.equal(selectel.hasIncident, false);
  assert.equal(vk.hasIncident, true);
  assert.equal(selectel.incidentReview, 'not_reviewed');
  assert.equal(present(selectel).tone, 'unknown');
  assert.equal(present(vk).tone, 'incident');
  assert.equal(present(vk).label, 'Incident reported · operation unknown');
  assert.equal(vk.operationalStatus, 'unknown');
});

test('dated closures remain red and dated reopenings green without implying they are current', () => {
  const closed = present(byId('WB-049'));
  const reopened = present(byId('WB-050'));
  assert.equal(closed.tone, 'closed');
  assert.equal(closed.label, 'Reported temporarily closed');
  assert.equal(closed.asOf, '2026-07-23');
  assert.equal(reopened.tone, 'operating');
  assert.equal(reopened.asOf, '2026-10-18');
  assert.equal(statusPresentation({ operationalStatus: 'partially_reopened', statusAsOf: '2026-10-18' }).tone, 'restricted');
});

test('an exact-date Russian operator claim suppresses only its matching green status', () => {
  const supported = byId('WB-046');
  const claimBased = byId('WB-050');
  assert.equal(present(supported).tone, 'operating');
  assert.equal(claimBased.operationalStatus, 'reopened');
  assert.equal(claimBased.statusAsOf, '2026-10-18');
  const actualClaim = statusClaimOverlay.claims.find(claim => claim.facility_id === 'WB-050');
  assert.ok(actualClaim?.canonical_status_is_claim);
  applyStatusClaims([claimBased], { schema_version: 1, claims: [actualClaim] });
  assert.equal(claimBased.operationalStatus, 'reopened');
  assert.equal(claimBased.statusAsOf, '2026-10-18');
  assert.equal(present(claimBased).tone, 'unverified');
  assert.equal(present(claimBased).label, 'Operation claimed · not confirmed');
  assert.equal(present(claimBased).claim.origin, 'russia');

  claimBased.operationalStatus = 'operating';
  claimBased.statusAsOf = '2026-10-19';
  assert.equal(present(claimBased).tone, 'operating');
});

test('status filters separate current operator claims from confirmed status and unknown condition', () => {
  const records = normalizeRecords(reviewed, dataset, catalog.categories);
  applyStatusClaims(records, statusClaimOverlay);
  const claimBased = records.find(record => record.id === 'WB-050');
  const closed = records.find(record => record.id === 'WB-049');
  assert.equal(present(claimBased).tone, 'unverified');
  assert.ok(selectRecords(records, { status: 'operator_claim' }).some(record => record.id === 'WB-050'));
  assert.ok(!selectRecords(records, { status: 'reopened' }).some(record => record.id === 'WB-050'));
  assert.ok(selectRecords(records, { status: 'unknown' }).some(record => record.id === 'WB-050'));
  assert.ok(selectRecords(records, { missing: 'status' }).some(record => record.id === 'WB-050'));
  assert.equal(present(closed).tone, 'closed');
  assert.ok(selectRecords(records, { status: 'temporarily_closed' }).some(record => record.id === 'WB-049'));
  assert.ok(!selectRecords(records, { status: 'operator_claim' }).some(record => record.id === 'WB-049'));

  claimBased.operationalStatus = 'operating';
  claimBased.statusAsOf = '2026-10-19';
  assert.ok(!selectRecords(records, { status: 'operator_claim' }).some(record => record.id === 'WB-050'));
  assert.ok(selectRecords(records, { status: 'operating' }).some(record => record.id === 'WB-050'));
  assert.ok(!selectRecords(records, { status: 'unknown' }).some(record => record.id === 'WB-050'));
  assert.ok(!selectRecords(records, { missing: 'status' }).some(record => record.id === 'WB-050'));
});

test('explicit unverified reopening claim keeps the supported closure and exposes its source separately', () => {
  const record = { id: 'WB-049', operationalStatus: 'temporarily_closed', statusAsOf: '2026-07-23' };
  applyStatusClaims([record], { schema_version: 1, claims: [
    { facility_id: 'WB-049', status: 'reopened', origin: 'russia', as_of: '2026-07-28', source: { name: 'TV Gubernia', url: 'https://example.test/story' }, verified: false },
    { facility_id: 'UNKNOWN', status: 'reopened', origin: 'russia', verified: false },
    { facility_id: 'WB-049', status: 'reopened', origin: 'russia', verified: true }
  ] });
  assert.equal(record.operationalStatus, 'temporarily_closed');
  assert.equal(record.statusAsOf, '2026-07-23');
  assert.equal(record.statusClaims.length, 1);
  assert.equal(record.statusClaim.asOf, '2026-07-28');
  assert.equal(statusPresentation(record).tone, 'closed');
  assert.equal(statusPresentation(record).claim.status, 'reopened');
  assert.equal(explicitOriginFlag(record.statusClaim.origin), '🇷🇺');
  assert.equal(explicitOriginFlag('not-attributed'), null);
});

test('multiple dated claims show the newest on cards while retaining the claim history', () => {
  const record = { id: 'WB-049', operationalStatus: 'temporarily_closed', statusAsOf: '2026-07-23' };
  applyStatusClaims([record], { schema_version: 1, claims: [
    { facility_id: 'WB-049', status: 'reopened', origin: 'russia', as_of: '2026-07-28', verified: false },
    { facility_id: 'WB-049', status: 'reopened', origin: 'russia', as_of: '2026-07-30', verified: false }
  ] });
  assert.equal(record.statusClaims.length, 2);
  assert.equal(statusPresentation(record).claim.asOf, '2026-07-30');
});
