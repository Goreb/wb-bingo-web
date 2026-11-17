import test from 'node:test';
import assert from 'node:assert/strict';
import {townIndex, approximateTown, groupTowns} from '../overview-map.js';
const data={towns:[{label:'Moscow',aliases:['Москва'],geoname_id:1,town_center:[55.8,37.6]},{label:'Springfield',aliases:[],geoname_id:2,town_center:[1,2]},{label:'Springfield',aliases:[],geoname_id:3,town_center:[3,4]}]};
test('map uses exact town aliases; region-only and ambiguous names never receive invented points',()=>{
 const index=townIndex(data);
 assert.equal(approximateTown({region:'Москва'},index)?.geoname_id,1);
 assert.equal(approximateTown({region:'Moscow Oblast'},index),null);
 assert.equal(approximateTown({region:'Springfield'},index),null);
 assert.equal(approximateTown({name:'Yandex Moscow data center'},index)?.geoname_id,1);
 assert.equal(approximateTown({region:'Unknown'},index),null);
});
test('map groups multiple facilities and source-only reports without inventing profile matches',()=>{
 const result=groupTowns([{id:'a',region:'Moscow'},{id:'b',region:'Москва'},{id:'c',region:'Unknown'}],[{id:'r',location:'Moscow'}],data);
 assert.equal(result.unmapped,1);assert.equal(result.groups.length,1);assert.equal(result.groups[0].records.length,2);assert.equal(result.groups[0].reports.length,1);
});
