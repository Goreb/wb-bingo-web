import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReports, selectReports, loadReports, mediaLabel, citationLabel, reportPhotos, facilityPhoto } from '../reports.js';

const update = (extra = {}) => ({post_id: 123, posted_at: '2026-10-19T10:00:00Z', kind: 'report', summary: 'Channel reports a fire.', source_url: 'https://t.me/supernova_plus/123', media_kind: 'photo', media_available: false, duplicate_post_ids: [], ...extra});
const incident = (extra = {}) => ({id: 'REPORT-1', facility_id: 'FAC-1', facility_name: 'Example facility', facility_type: 'refinery', location: 'Example region', country: 'Russia', event_date: null, summary: 'Channel reports a fire.', approval_status: 'unapproved', media_status: 'photo_backed_unverified', updates: [update()], ...extra});
const collection = (incidents = [incident()]) => ({schema_version: 1, source: 'Supernova+', imported_at: '2026-10-19T12:00:00Z', incidents});

test('report validation rejects ambiguous identity, unsafe sources and reused source posts', () => {
  for (const overrides of [{id: ''}, {facility_id: 12}, {approval_status: 'approved'}, {event_date: '2026-02-30'}, {facility_type: 'oil_field'}, {updates: []}, {updates: [update({source_url: 'javascript:alert(1)'})]}, {updates: [update({duplicate_post_ids: [123]})]}, {updates: [update({post_id: '123'})]}]) assert.throws(() => validateReports(collection([incident(overrides)])));
  assert.throws(() => validateReports(collection([incident(), incident({id: 'REPORT-2'})])), /Duplicate source post/);
  assert.throws(() => validateReports(collection([incident({updates: [update({duplicate_post_ids: [124]}), update({post_id: 124, source_url: 'https://t.me/supernova_plus/124'})]})])), /Duplicate source post/);
});

test('one incident preserves dated reports, updates, corrections and unknown event date', () => {
  const updates = [update(), update({post_id: 124, source_url: 'https://t.me/supernova_plus/124', posted_at: '2026-10-20T11:00:00Z', kind: 'update'}), update({post_id: 125, source_url: 'https://t.me/supernova_plus/125', posted_at: '2026-10-21T12:00:00Z', kind: 'correction', summary: 'Channel corrects the location.', duplicate_post_ids: [126]})];
  const data = validateReports(collection([incident({updates})]));
  assert.equal(data.incidents.length, 1); assert.equal(data.incidents[0].event_date, null);
  assert.deepEqual(data.incidents[0].updates.map(item => item.kind), ['report', 'update', 'correction']);
  assert.deepEqual(data.incidents[0].updates[2].duplicate_post_ids, [126]);
});

test('media labels distinguish referenced attachments from available media and reject contradictory data', () => {
  assert.equal(mediaLabel(incident()), 'Photo referenced · unverified');
  assert.equal(mediaLabel(incident({updates: [update({media_available: true})]})), 'Photo-backed · unverified');
  assert.equal(mediaLabel(incident({media_status: 'video_backed_unverified', updates: [update({media_kind: 'video'})]})), 'Video referenced · unverified');
  assert.throws(() => validateReports(collection([incident({media_status: 'text_only'})])), /Inconsistent/);
  assert.throws(() => validateReports(collection([incident({media_status: 'text_only', updates: [update({media_kind: 'none', media_available: true})]})])), /Text-only/);
});

test('reports filter separately without altering approved facility history or status', () => {
  const facility = {id: 'FAC-1', operator: 'Operator', region: 'Example region', hasIncident: false, operationalStatus: 'unknown', verification: {status: 'ai_reviewed'}};
  const before = structuredClone(facility);
  const reports = [incident(), incident({id: 'REPORT-2', facility_id: null, facility_name: 'Unidentified refinery'})];
  assert.equal(selectReports(reports, [facility], {}).length, 2);
  assert.equal(selectReports(reports, [facility], {operator: 'Operator'}).length, 1);
  assert.equal(selectReports(reports, [facility], {query: 'unidentified', type: 'refinery'}).length, 1);
  assert.equal(selectReports(reports, [facility], {approvedOnly: true}).length, 0);
  assert.equal(selectReports(reports, [facility], {incident: 'none'}).length, 0);
  assert.deepEqual(facility, before);
});

test('missing or malformed reports remain a compact independent load failure', async () => {
  for (const fetcher of [async () => ({ok: false, status: 404}), async () => ({ok: true, json: async () => {throw new SyntaxError();}}), async () => ({ok: true, json: async () => collection([incident({id: null})])})]) {
    const result = await loadReports(fetcher);
    assert.deepEqual(result.incidents, []); assert.equal(result.error, 'Unapproved incident reports unavailable.');
  }
  const result = await loadReports(async () => ({ok: true, json: async () => collection([])}));
  assert.equal(result.error, null); assert.deepEqual(result.incidents, []);
});

const photo = (extra = {}) => ({path: 'img/reports/tg-123-abcdef012345.jpg', sha256: 'abcdef012345' + '0'.repeat(52), source_reference: 'photos/photo_123@19-10-2026_10-00-00.jpg', ...extra});
const citation = (extra = {}) => ({name: 'Original reporting', url: 'https://example.com/report', relationship: 'cited_by_post', access: 'linked_not_read', ...extra});

test('citations retain attribution and distinguish cited/unread sources from checked independent sources', () => {
  const original = citation(), independent = citation({relationship: 'independently_found', access: 'read'});
  const result = validateReports(collection([incident({updates: [update({source_attribution: 'Original reporter', citations: [original, independent]})]})]));
  assert.deepEqual(result.incidents[0].updates[0].citations, [original, independent]);
  assert.equal(citationLabel(original), 'Cited source · linked, unread');
  assert.equal(citationLabel(independent), 'Independent source · checked');
  assert.equal(citationLabel(citation({access: 'read'})), 'Cited source · checked');
  assert.equal(citationLabel(citation({relationship: 'independently_found'})), 'Independent source · linked, unread');
  for (const extra of [{url: 'javascript:alert(1)'}, {url: 'https://user:pass@example.com'}, {url: '//example.com'}, {relationship: 'approved'}, {access: 'verified'}]) {
    assert.throws(() => validateReports(collection([incident({updates: [update({citations: [citation(extra)]})]})])), /citation/);
  }
  assert.throws(() => validateReports(collection([incident({updates: [update({source_attribution: 42})]})])), /attribution/);
});

test('photos must match source post/hash and safe local export paths, with compatible media status', () => {
  const good = update({media_available: true, photos: [photo()]});
  assert.equal(validateReports(collection([incident({updates: [good]})])).incidents[0].updates[0].photos.length, 1);
  for (const extra of [{path: 'https://example.com/photo.jpg'}, {path: '../img/reports/tg-123-abcdef012345.jpg'}, {path: 'img/reports/tg-124-abcdef012345.jpg'}, {path: 'img/reports/tg-123-abcdef012345.jpg?track=1'}, {sha256: '1'.repeat(64)}, {source_reference: 'photos/../photo.jpg'}, {source_reference: 'photos/.hidden.jpg'}, {source_reference: 'https://example.com/photo.jpg'}]) {
    assert.throws(() => validateReports(collection([incident({updates: [{...good, photos: [photo(extra)]}]})])), /photo/);
  }
  assert.equal(validateReports(collection([incident({updates: [{...good, photos: [photo(), photo(), photo()]}]})])).incidents[0].updates[0].photos.length, 3);
  for (const extra of [{media_available: false}, {media_kind: 'video'}]) {
    assert.throws(() => validateReports(collection([incident({updates: [{...good, ...extra}]})])), /photo/);
  }
  assert.throws(() => validateReports(collection([incident({media_status: 'video_backed_unverified', updates: [good]})])), /Inconsistent/);
});

test('incident previews preserve all distinct photos without a display cap', () => {
  const second = photo({path: 'img/reports/tg-124-111111111111.jpg', sha256: '1'.repeat(64)});
  const third = photo({path: 'img/reports/tg-125-222222222222.jpg', sha256: '2'.repeat(64)});
  const report = incident({updates: [update({photos: [photo()]}), update({post_id: 124, photos: [photo(), second]}), update({post_id: 125, photos: [third]})]});
  const photos = reportPhotos(report);
  assert.equal(photos.length, 3); assert.deepEqual(photos.map(item => item.sha256), [photo().sha256, second.sha256, third.sha256]);
  assert.equal(photos[0].source_url, 'https://t.me/supernova_plus/123');
});

test('optional dated duplicate provenance preserves timestamps and rejects mismatched IDs or URLs', () => {
  const duplicate = {post_id: 124, posted_at: '2026-10-19T11:00:00Z', source_url: 'https://t.me/supernova_plus/124'};
  const base = update({duplicate_post_ids: [124], duplicate_posts: [duplicate]});
  assert.equal(validateReports(collection([incident({updates: [base]})])).incidents[0].updates[0].duplicate_posts[0].posted_at, duplicate.posted_at);
  for (const extra of [{post_id: 125}, {source_url: 'javascript:alert(1)'}, {posted_at: '2026-02-30T11:00:00Z'}]) {
    assert.throws(() => validateReports(collection([incident({updates: [{...base, duplicate_posts: [{...duplicate, ...extra}]}]})])), /duplicate/);
  }
});

test('unmatched source identities remain filterable by reported operator and unknown-date reports sort by posting date', () => {
  const recent = incident({id:'NEW', facility_id:null, event_date:null, reported_operators:['Ozon'], updates:[update({posted_at:'2026-10-19T12:00:00Z'})]});
  const old = incident({id:'OLD', facility_id:null, event_date:'2026-08-01', updates:[update({post_id:124,source_url:'https://t.me/supernova_plus/124',posted_at:'2026-08-02T10:00:00Z'})]});
  assert.equal(selectReports([old,recent],[],{operator:'Ozon'})[0].id,'NEW');
  assert.equal(selectReports([old,recent],[],{})[0].id,'NEW');
  assert.equal(recent.event_date,null);
});


test('facility banner keeps exact identity and uses source photos regardless of approval or correction history', () => {
  const photo = {path:'img/reports/tg-123-aaaaaaaaaaaa.jpg', sha256:'a'.repeat(64),source_reference:'photos/example.jpg'};
  const linked = incident({updates:[update({media_available:true,photos:[photo]})]});
  const wrongIdentity = incident({facility_id:null,updates:[update({media_available:true,photos:[photo]})]});
  const corrected = incident({updates:[update({kind:'correction',media_available:true,photos:[photo]})]});
  assert.equal(facilityPhoto([wrongIdentity],'FAC-1'),null);
  assert.equal(facilityPhoto([linked],'FAC-1').path,photo.path);
  assert.equal(facilityPhoto([linked],'FAC-1',{approvedOnly:true}).path,photo.path);
  assert.equal(facilityPhoto([corrected],'FAC-1').path,photo.path);
  assert.equal(linked.facility_id,'FAC-1');
});

const { applyReportApprovals, canonicalJSON } = await import('../reports.js');
const { createHash, webcrypto } = await import('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
function approvalFixture() {
  const report = incident({event_date:'2026-10-19'});
  const facility = {id:'FAC-1',version:2,verification:{status:'ai_reviewed'},incidents:[{id:'fire-2026',date:'2026-10-19'}],sources:[{url:'https://example.com/fire',supports:['incidents']}]};
  const review = {schema_version:1,decision:'approved',scope:'incident_date_town',report_id:report.id,report_sha256:hash(report),facility_id:facility.id,facility_version:2,facility_sha256:hash(facility),incident_id:'fire-2026',event_date:'2026-10-19',approved_summary:'A fire was reported in the town on 19 October.',reviewed_by:'Independent reviewer',model:'test-model',reviewed_at:'2026-10-19T13:00:00Z',evidence_urls:['https://example.com/fire']};
  return {report,facility,review,overlay:{schema_version:1,approvals:[review]}};
}

test('exact audited overlay enables approved filter without promoting source photos or raw claims', async () => {
  const {report,facility,overlay} = approvalFixture();
  const [result] = await applyReportApprovals([report],overlay,[facility]);
  assert.equal(result.approval_status,'approved');
  assert.equal(result.summary,report.summary);
  assert.equal(report.approval_status,'unapproved');
  assert.equal(selectReports([result,incident({id:'OTHER'})],[facility],{approvedOnly:true}).length,1);
  assert.equal(facilityPhoto([result],facility.id,{approvedOnly:true}),null);
});

test('tampered reports, stale facility versions and unapproved evidence fail closed', async () => {
  for (const mutate of [f=>{f.report.summary+=' changed';},f=>{f.report.updates[0].summary+=' changed';},f=>{f.facility.version++;},f=>{f.facility.incidents[0].date='2026-10-18';},f=>{f.review.incident_id='missing';},f=>{f.review.evidence_urls=['https://example.org/unreviewed'];},f=>{f.review.scope='photos';},f=>{f.review.model='';},f=>{f.overlay.approvals.push({...f.review});}]) {
    const fixture=approvalFixture(); mutate(fixture);
    const [result]=await applyReportApprovals([fixture.report],fixture.overlay,[fixture.facility]);
    assert.equal(result.approval_status,'unapproved');
  }
});

test('optional overlay failures retain all raw reports and valid overlay loads independently', async () => {
  const {report,facility,overlay}=approvalFixture();
  const fetcher=async url=>({ok:true,json:async()=>url.includes('unapproved-reports')?collection([report]):url.includes('report-approvals')?overlay:[facility]});
  assert.equal((await loadReports(fetcher)).incidents[0].approval_status,'approved');
  const missing=async url=>url.includes('unapproved-reports')?{ok:true,json:async()=>collection([report])}:{ok:false};
  assert.equal((await loadReports(missing)).incidents[0].approval_status,'unapproved');
});

 test('explicit reviewed incident date may fill unknown raw date without mutating raw provenance', async () => {
  const f=approvalFixture(); f.report.event_date=null; f.review.report_sha256=hash(f.report);
  const [result]=await applyReportApprovals([f.report],f.overlay,[f.facility]);
  assert.equal(result.approval_status,'approved'); assert.equal(result.event_date,'2026-10-19'); assert.equal(f.report.event_date,null);
  f.review.event_date='2026-10-18';
  assert.equal((await applyReportApprovals([f.report],f.overlay,[f.facility]))[0].approval_status,'unapproved');
});

test('report dates use event day or earliest post, with inclusive bounds and correction-independent ordering', () => {
  const historical = incident({id: 'HISTORY', event_date: '2026-08-01', updates: [update({posted_at: '2026-10-19T10:00:00Z'})]});
  const unknown = incident({id: 'UNKNOWN', updates: [update({kind: 'correction', posted_at: '2026-10-19T10:00:00Z'}), update({posted_at: '2026-08-03T12:00:00Z'})]});
  const later = incident({id: 'LATER', event_date: '2026-08-04'});
  assert.deepEqual(selectReports([historical, unknown, later], [], {dateFrom: '2026-08-01', dateTo: '2026-08-03'}).map(item => item.id), ['UNKNOWN', 'HISTORY']);
  assert.deepEqual(selectReports([unknown], [], {dateFrom: '2026-10-01'}), []);
  assert.equal(unknown.event_date, null);
});

test('source domains cover source posts, linked citations and approval evidence without substring matches', () => {
  const reports = [incident({updates: [update({citations: [citation({url: 'https://www.reuters.com/world/report'})]})]}), incident({id: 'APPROVED', approval_status: 'approved', approval: {evidence_urls: ['https://apnews.com/article/example']}})];
  assert.equal(selectReports(reports, [], {source: 't.me'}).length, 2);
  assert.deepEqual(selectReports(reports, [], {source: 'reuters.com'}).map(item => item.id), ['REPORT-1']);
  assert.deepEqual(selectReports(reports, [], {source: 'apnews.com', review: 'approved'}).map(item => item.id), ['APPROVED']);
  assert.equal(selectReports(reports, [], {source: 'news.com'}).length, 0);
  assert.equal(selectReports(reports, [], {source: 'reuters.com', review: 'pending'}).length, 1);
  assert.equal(selectReports(reports, [], {review: 'pending', approvedOnly: true}).length, 0);
});

test('favorites and profile filters use exact facility identity and compose with report category', () => {
  const facility = {id: 'FAC-1', operationalStatus: 'unknown', inheritedDamage: 0, operator: 'Not recorded', region: 'Example region', footprint: null};
  const linked = incident();
  const unmatched = incident({id: 'UNMATCHED', facility_id: null});
  const digital = incident({id: 'DIGITAL', facility_id: 'FAC-2', facility_type: 'data_center'});
  assert.deepEqual(selectReports([linked, unmatched, digital], [facility], {favoriteIds: new Set(['FAC-1']), group: 'energy', status: 'unknown', damage: '0', missing: 'footprint'}), [linked]);
  assert.equal(selectReports([linked], [facility], {favoriteIds: new Set()}).length, 0);
  assert.equal(selectReports([unmatched], [facility], {missing: 'footprint'}).length, 0);
  assert.deepEqual(selectReports([linked, unmatched, digital], [facility], {group: 'digital'}), [digital]);
  assert.equal(selectReports([linked], [facility], {status: 'operational'}).length, 0);
});

test('expanded report types validate and do not fall through to logistics grouping', () => {
  const facility = {id:'MIL', facility_type:'military_facility'};
  const report = incident({id:'MIL-REPORT', facility_id:'MIL', facility_type:'military_facility'});
  assert.equal(validateReports(collection([report])).incidents.length, 1);
  assert.deepEqual(selectReports([report], [facility], {group:'defence'}), [report]);
  assert.deepEqual(selectReports([report], [facility], {group:'logistics'}), []);
});

test('media filters distinguish text, exported photos, video references and unavailable attachments', () => {
  const textReport = incident({id: 'TEXT', media_status: 'text_only', updates: [update({media_kind: 'none'})]});
  const photoReport = incident({id: 'PHOTO', updates: [update({media_available: true, photos: [photo()]})]});
  const videoReport = incident({id: 'VIDEO', media_status: 'video_backed_unverified', updates: [update({media_kind: 'video'})]});
  const missingPhoto = incident({id: 'MISSING'});
  const reports = [textReport, photoReport, videoReport, missingPhoto];
  assert.equal(selectReports(reports, [], {}).length, 4);
  assert.deepEqual(selectReports(reports, [], {media: 'text_only'}), [textReport]);
  assert.deepEqual(selectReports(reports, [], {media: 'photos'}), [photoReport]);
  assert.deepEqual(selectReports(reports, [], {media: 'video'}), [videoReport]);
  assert.deepEqual(new Set(selectReports(reports, [], {media: 'missing'}).map(item => item.id)), new Set(['VIDEO', 'MISSING']));
});

test('reviewed identity binding links a raw-null report only after all exact gate checks',async()=>{
 const f=approvalFixture();f.report.facility_id=null;f.review.report_sha256=hash(f.report);
 assert.equal((await applyReportApprovals([f.report],f.overlay,[f.facility]))[0].approval_status,'unapproved');
 f.review.identity_binding={raw_facility_id:null,facility_id:f.facility.id,rationale:'Source captions, operator, town and event sequence identify the same approved incident.',evidence_urls:[...f.review.evidence_urls]};
 const [result]=await applyReportApprovals([f.report],f.overlay,[f.facility]);
 assert.equal(result.approval_status,'approved');assert.equal(result.facility_id,f.facility.id);assert.equal(f.report.facility_id,null);assert.equal(f.report.approval_status,'unapproved');
 f.report.summary+=' correction';
 assert.equal((await applyReportApprovals([f.report],f.overlay,[f.facility]))[0].approval_status,'unapproved');
});
test('identity binding cannot redirect an existing identity or omit actual review evidence',async()=>{
 for(const change of [f=>{f.report.facility_id='OTHER';},f=>{delete f.review.identity_binding.raw_facility_id;},f=>{f.review.identity_binding.facility_id='OTHER';},f=>{f.review.identity_binding.rationale=' ';},f=>{f.review.identity_binding.evidence_urls=[];},f=>{f.review.identity_binding.evidence_urls=['https://example.com/unreviewed'];},f=>{f.facility.version++;}]){
  const f=approvalFixture();f.report.facility_id=null;f.review.identity_binding={raw_facility_id:null,facility_id:f.facility.id,rationale:'Exact source identity reviewed.',evidence_urls:[...f.review.evidence_urls]};change(f);f.review.report_sha256=hash(f.report);
  assert.equal((await applyReportApprovals([f.report],f.overlay,[f.facility]))[0].approval_status,'unapproved');
 }
});
test('Python builder agrees with browser on explicit identity bindings',async()=>{
 const {spawnSync}=await import('node:child_process');
 const f=approvalFixture();f.report.facility_id=null;f.review.report_sha256=hash(f.report);f.review.identity_binding={raw_facility_id:null,facility_id:f.facility.id,rationale:'Reviewed exact caption and source identity.',evidence_urls:[...f.review.evidence_urls]};
 const cases=[structuredClone(f)];f.review.identity_binding.rationale='';cases.push(structuredClone(f));f.review.identity_binding.rationale='Reviewed';f.report.facility_id='OTHER';f.review.report_sha256=hash(f.report);cases.push(f);
 const run=spawnSync('python3',['-c',`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('builder','scripts/build-report-approvals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
result=[]
for f in json.load(sys.stdin):
 try:m.validate(f['review'],{f['report']['id']:f['report']},{f['facility']['id']:f['facility']});result.append(True)
 except (AssertionError,KeyError,TypeError,ValueError):result.append(False)
print(json.dumps(result))`],{input:JSON.stringify(cases),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),[true,false,false]);
 for(let i=0;i<cases.length;i++){const c=cases[i];assert.equal((await applyReportApprovals([c.report],c.overlay,[c.facility]))[0].approval_status==='approved',i===0);}
});

test('reviewed event timezone handles a cross-midnight post without rewriting timestamps',async()=>{
 const f=approvalFixture();f.report.event_date=null;f.report.updates[0].posted_at='2026-10-18T23:48:29+01:00';f.review.report_sha256=hash(f.report);
 assert.equal((await applyReportApprovals([f.report],f.overlay,[f.facility]))[0].approval_status,'unapproved');
 f.review.event_timezone='Europe/Moscow';f.review.timing_rationale='The same overnight incident was reported at 01:48 on the event-local day, with source context reviewed.';
 const [result]=await applyReportApprovals([f.report],f.overlay,[f.facility]);assert.equal(result.approval_status,'approved');assert.equal(result.event_date,'2026-10-19');assert.equal(result.updates[0].posted_at,'2026-10-18T23:48:29+01:00');assert.equal(f.report.event_date,null);
});
test('Python and browser reject invalid timezone reviews and events later than converted posts',async()=>{
 const {spawnSync}=await import('node:child_process');const cases=[];
 for(const change of [()=>{},f=>{delete f.review.timing_rationale;},f=>{f.review.event_timezone='Unknown/Zone';},f=>{f.report.updates[0].posted_at='2026-10-17T23:48:29+01:00';},f=>{delete f.review.event_timezone;},f=>{f.review.event_timezone='+03:00';},f=>{f.review.event_timezone='EST';},f=>{f.review.event_timezone='europe/moscow';}]){
  const f=approvalFixture();f.report.event_date=null;f.report.updates[0].posted_at='2026-10-18T23:48:29+01:00';f.review.event_timezone='Europe/Moscow';f.review.timing_rationale='Same-event source timing reviewed.';change(f);f.review.report_sha256=hash(f.report);cases.push(f);
 }
 const run=spawnSync('python3',['-c',`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('builder','scripts/build-report-approvals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
results=[]
for f in json.load(sys.stdin):
 try:m.validate(f['review'],{f['report']['id']:f['report']},{f['facility']['id']:f['facility']});results.append(True)
 except (AssertionError,KeyError,TypeError,ValueError):results.append(False)
print(json.dumps(results))`],{input:JSON.stringify(cases),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),[true,false,false,false,false,false,false,false]);
 for(let i=0;i<cases.length;i++){const f=cases[i];assert.equal((await applyReportApprovals([f.report],f.overlay,[f.facility]))[0].approval_status==='approved',i===0);}
});

test('report preflight skips only exact-current approvals and never turns stale data into approval',async()=>{
 const {spawnSync}=await import('node:child_process'),fs=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await fs.mkdtemp(join(tmpdir(),'bingo-preflight-'));await fs.mkdir(join(root,'data'));
 const f=approvalFixture();
 const save=async()=>{await fs.writeFile(join(root,'data/unapproved-reports.json'),JSON.stringify(collection([f.report])));await fs.writeFile(join(root,'data/reviewed-facilities.json'),JSON.stringify([f.facility]));await fs.writeFile(join(root,'data/report-approvals.json'),JSON.stringify(f.overlay));};
 const run=()=>{const result=spawnSync('python3',['scripts/report-review-preflight.py',f.report.id,'UNKNOWN','--root',root],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 try{
  await save();let result=run();assert.equal(result[0].state,'already_approved_current');assert.equal(result[1].state,'unknown_report');
  f.report.summary+=' correction';await save();assert.equal(run()[0].state,'needs_review');
  f.review.report_sha256=hash(f.report);f.facility.name='Changed without a version';await save();assert.equal(run()[0].state,'needs_review');
  f.review.facility_sha256=hash(f.facility);f.facility.version++;await save();assert.equal(run()[0].state,'needs_review');
  assert.equal(f.report.approval_status,'unapproved');
  for(const malformed of [[],{schema_version:1,approvals:[null]}]){await fs.writeFile(join(root,'data/report-approvals.json'),JSON.stringify(malformed));const result=spawnSync('python3',['scripts/report-review-preflight.py',f.report.id,'--root',root],{encoding:'utf8'});assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).state,'unavailable');assert.equal(result.stderr,'');}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
