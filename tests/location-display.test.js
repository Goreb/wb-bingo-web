import test from 'node:test';
import assert from 'node:assert/strict';
import {displayLocation, locationRegions} from '../display.js';

test('location badges keep town and region even when names match',()=>{
  assert.equal(displayLocation({region:'Moscow',country:'Russia'}).placeLabel,'📍 Moscow, Moscow · ');
  assert.equal(displayLocation({region:'Zelenodolsk, Republic of Tatarstan',country:'Russia'}).placeLabel,'📍 Zelenodolsk, Tatarstan · ');
});
test('regional icons only replace Russian country flags',()=>{
  assert.equal(displayLocation({region:'Republic of Tatarstan',legacy:true},{town:'Zelenodolsk'}).flagPath,'img/flags/tatarstan.svg');
  for(const region of ['Crimea (Russian-occupied)','Dzhankoi, Crimea (Russian-occupied)','Tatarstan'])
    assert.equal(displayLocation({region,country:'Ukraine'}).flagPath,'img/flags/ukraine.svg');
  assert.equal(displayLocation({region:'Crimea (Russian-occupied)',legacy:true}).flagPath,'img/flags/ukraine.svg');
});
test('missing or conflicting location components remain unknown',()=>{
  assert.equal(displayLocation({region:'Kaluga Oblast',country:'Russia'}).placeLabel,'📍 ?, Kaluga · ');
  const record={region:'Omsk',country:'Russia'};
  assert.equal(displayLocation(record).placeLabel,'📍 Omsk, ? · ');
  assert.equal(displayLocation(record,{regions:locationRegions([{region:'Omsk, Omsk Oblast'}])}).placeLabel,'📍 Omsk, Omsk · ');
  assert.equal(displayLocation(record,{regions:locationRegions([{region:'Omsk, Omsk Oblast'},{region:'Omsk, Another Oblast'}])}).placeLabel,'📍 Omsk, ? · ');
});
