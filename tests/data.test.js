import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { safeLink, localImage, validDate, validateCatalog, normalizeRecords, selectRecords, loadCollection } from '../data.js';
const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url)));
const legacy = catalog.datasets[0];
const record = (extra = {}) => ({id:'TEST-1',name:'Example',facility_type:'warehouse',operator:'Example operator',region:'Example region',...extra});
const dataset = {id:'test',label:'Test fixture',format:'facilities-v1'};
const normalize = rows => normalizeRecords(rows,dataset,catalog.categories);

test('legacy collection stays unreviewed despite inherited confidence',async()=>{
  const rows=JSON.parse(await readFile(new URL('../facilities.json',import.meta.url)));
  const data=normalizeRecords(rows,legacy,catalog.categories);
  assert.equal(data.length,38);assert.equal(data.filter(x=>x.hasIncident).length,26);
  assert.ok(data.every(x=>x.type==='warehouse'&&x.operator==='Wildberries'&&x.verification.status==='unreviewed'&&x.operationalStatus==='unknown'));
  assert.equal(data.find(x=>x.id==='WB-001').inheritedConfidence,'Confirmed');
});
test('unknown optional facts are null, not zero or intact',()=>{
  const item=normalize([record({footprint_m2:'',last_incident_date:'N/A'})])[0];
  assert.equal(item.footprint,null);assert.equal(item.lastIncident,null);assert.equal(item.operationalStatus,'unknown');assert.equal(item.incidentReview,'not_reviewed');
});
test('null values sort last and combined filters intersect',()=>{
  const records=normalize([record({id:'A',name:'Alpha',footprint_m2:null}),record({id:'B',name:'Beta',footprint_m2:42,operator:'Ozon',incidents:[{date:'2022-08-03',description:'Fixture'}]}),record({id:'C',name:'Gamma',operator:'Ozon',region:'Another region',footprint_m2:100})]);
  assert.deepEqual(selectRecords(records,{sort:'area'}).map(x=>x.id),['C','B','A']);
  assert.equal(selectRecords(records,{operator:'Ozon',region:'Example region',incident:'reported',query:'beta'}).length,1);
  assert.equal(selectRecords(records,{type:'oil_well'}).length,0);
  assert.equal(selectRecords(records,{sort:'recent'})[0].id,'B');
});
test('unsafe links and nonlocal image inputs are rejected',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,x','//example.com','https://user:pass@example.com','not a URL'])assert.equal(safeLink(url),null);
  assert.equal(safeLink('https://example.com/report'),'https://example.com/report');
  for(const value of ['../../secret','https://tracker.example/a.jpg','img/a.svg','img/a.jpg" onerror="x'])assert.equal(localImage(value),null);
  assert.equal(localImage('img/WB-001.jpg'),'img/WB-001.jpg');
});
test('invalid dates do not become incidents; valid leap dates remain',()=>{
  assert.equal(validDate('2026-02-30'),null);assert.equal(validDate('2026-13-01'),null);assert.equal(validDate('2024-02-29'),'2024-02-29');
  assert.equal(normalize([record({last_incident_date:'invalid'})])[0].hasIncident,false);
});
test('dataset identity/schema errors fail explicitly',()=>{
  assert.throws(()=>normalize({}));assert.throws(()=>normalize([record(),record({id:' TEST-1 '})]),/Duplicate/);
  assert.throws(()=>normalize([record({facility_type:'oil_field'})]),/Unknown/);
  assert.throws(()=>normalize([record({name:null})]),/requires/);
  assert.throws(()=>validateCatalog({...catalog,datasets:[{id:'x',format:'facilities-v1',path:'../../private.json'}]}));
});
test('a review badge and operational state require provenance',()=>{
  const source={name:'Fixture',url:'https://example.com'};
  const base=record({sources:[source],verification:{status:'ai_reviewed',reviewed_on:'2026-10-19',reviewed_by:'test-model'},operational_status:'reopened',status_as_of:'2026-10-18',status_evidence:['e1']});
  assert.equal(normalize([base])[0].operationalStatus,'reopened');
  assert.equal(normalize([{...base,verification:{status:'ai_reviewed'}}])[0].operationalStatus,'unknown');
  assert.equal(normalize([{...base,status_evidence:[]}])[0].operationalStatus,'unknown');
  assert.equal(normalize([{...base,verification:{...base.verification,status:'identity_sourced'}}])[0].operationalStatus,'unknown');
});
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
test('HTTP errors never parse an error page as records',async()=>{
  await assert.rejects(loadCollection(async()=>response(null,404)),/HTTP 404/);
});
test('one failed dataset preserves available records and signals partial load',async()=>{
  const config={...catalog,datasets:[{...dataset,path:'data/one.json'},{...dataset,id:'bad',path:'data/bad.json'}]};
  const result=await loadCollection(async path=>path==='data/catalog.json'?response(config):path==='data/one.json'?response([record()]):response(null,503));
  assert.equal(result.records.length,1);assert.equal(result.failures.length,1);assert.equal(result.failures[0].id,'bad');
});
test('malformed JSON and total failures surface; valid empty dataset is supported',async()=>{
  const config={...catalog,datasets:[{...dataset,path:'data/test.json'}]};
  await assert.rejects(loadCollection(async path=>path==='data/catalog.json'?response(config):{ok:true,json:async()=>{throw new SyntaxError('Invalid JSON');}}),/could not be loaded/);
  const result=await loadCollection(async path=>response(path==='data/catalog.json'?config:[]));assert.deepEqual(result.records,[]);assert.deepEqual(result.failures,[]);
});

test('approved revision supersedes a legacy ID without duplicate cards',async()=>{
  const config={...catalog,datasets:[{...legacy,path:'facilities.json'},{...dataset,path:'data/new.json'}]};
  const old={id:'WB-001',name:'Old name',region:'Example',footprint_m2:5,damage_level:3,confidence:'Confirmed',strikes:[]};
  const revised=record({id:'WB-001',name:'Reviewed name',sources:[{name:'Source',url:'https://example.com'}],verification:{status:'ai_reviewed',reviewed_on:'2026-10-19',reviewed_by:'test-fixture'}});
  const result=await loadCollection(async path=>response(path==='data/catalog.json'?config:path==='facilities.json'?[old]:[revised]));
  assert.equal(result.records.length,1);assert.equal(result.records[0].name,'Reviewed name');assert.equal(result.records[0].inheritedDamage,3);assert.equal(result.records[0].inheritedConfidence,'Confirmed');assert.equal(result.records[0].operationalStatus,'unknown');
});

test('approved-only filter excludes discovery, inherited confidence and incomplete review badges',()=>{
  const records=normalize([record({id:'pending',confidence:'Confirmed'}),record({id:'broken',verification:{status:'ai_reviewed'}}),record({id:'approved',operator:'Ozon',sources:[{url:'https://example.com',name:'Source'}],verification:{status:'ai_reviewed',reviewed_on:'2026-10-19',reviewed_by:'fixture'}})]);
  assert.equal(selectRecords(records,{}).length,3);
  assert.deepEqual(selectRecords(records,{approvedOnly:true}).map(x=>x.id),['approved']);
  assert.equal(selectRecords(records,{approvedOnly:true,operator:'Wildberries'}).length,0);
});

test('approval supersedes the same discovery ID without losing approved facts in either dataset order',async()=>{
  const pending=record({id:'PENDING-1',name:'Proposed name',verification:{status:'unreviewed'}});
  const approved=record({id:'PENDING-1',name:'Reviewed name',sources:[{name:'Source',url:'https://example.com'}],verification:{status:'ai_reviewed',reviewed_on:'2026-10-19',reviewed_by:'fixture'}});
  for(const reverse of [false,true]){
    const datasets=[{...dataset,id:'pending',path:'data/pending.json'},{...dataset,id:'approved',path:'data/approved.json'}];
    if(reverse)datasets.reverse();
    const config={...catalog,datasets};
    const result=await loadCollection(async path=>response(path==='data/catalog.json'?config:path==='data/pending.json'?[pending]:[approved]));
    assert.equal(result.records.length,1);assert.equal(result.records[0].name,'Reviewed name');assert.equal(result.records[0].inheritedDamage,null);assert.equal(result.records[0].operationalStatus,'unknown');
    assert.equal(selectRecords(result.records,{approvedOnly:true}).length,1);
  }
});

test('advanced facility filters intersect approval, broad infrastructure, dates and favorites',()=>{
 const rows=normalize([record({id:'a',facility_type:'refinery',incidents:[{date:'2026-08-05',description:'Fixture'}],sources:[{name:'Source',url:'https://www.example.com/news'}],verification:{status:'ai_reviewed',reviewed_on:'2026-10-19',reviewed_by:'fixture'}}),record({id:'b',facility_type:'data_center'}),record({id:'c',facility_type:'refinery'})]);
 assert.deepEqual(selectRecords(rows,{group:'energy',review:'approved',dateFrom:'2026-08-01',dateTo:'2026-08-31',source:'example.com',favoriteIds:new Set(['a','b'])}).map(r=>r.id),['a']);
 assert.equal(selectRecords(rows,{group:'digital',missing:'footprint',review:'pending'}).length,1);
 assert.equal(selectRecords(rows,{dateFrom:'2026-09-01'}).length,0);
});

test('expanded categories normalize and only match their intentional infrastructure groups',()=>{
 const types=['military_facility','defence_manufacturing','government_building','drone_facility','robotics_facility','industrial_facility'];
 const rows=normalize(types.map((facility_type,index)=>record({id:`expanded-${index}`,facility_type})));
 assert.deepEqual(rows.map(row=>row.type),types);
 assert.deepEqual(selectRecords(rows,{group:'defence'}).map(row=>row.type),['military_facility','defence_manufacturing']);
 assert.deepEqual(selectRecords(rows,{group:'government'}).map(row=>row.type),['government_building']);
 assert.deepEqual(selectRecords(rows,{group:'industry'}).map(row=>row.type),['drone_facility','robotics_facility','industrial_facility']);
 assert.equal(selectRecords(rows,{group:'logistics'}).length,0);
});

test('bridges remain distinct and belong to the logistics group',()=>{
 const rows=normalize([record({id:'bridge-1',facility_type:'bridge'}),record({id:'bridge-2',facility_type:'logistics_hub',name:'Railway bridge in Example'})]);
 assert.deepEqual(rows.map(row=>row.type),['bridge','bridge']);
 assert.deepEqual(selectRecords(rows,{group:'logistics'}).map(row=>row.id),['bridge-1','bridge-2']);
});
