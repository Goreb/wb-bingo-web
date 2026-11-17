import test from 'node:test';
import assert from 'node:assert/strict';
import { presentationFacilityType } from '../data.js';
test('oil storage display grouping collects depots from both old groups without absorbing refineries', () => {
  assert.equal(presentationFacilityType('warehouse', 'Oil depot in Enyem'), 'oil_depot');
  assert.equal(presentationFacilityType('logistics_hub', 'Port of Primorsk oil terminal'), 'oil_depot');
  assert.equal(presentationFacilityType('logistics_hub', 'Transneft oil storage facility in Bryansk'), 'oil_depot');
  assert.equal(presentationFacilityType('warehouse', 'Wildberries warehouse'), 'warehouse');
  assert.equal(presentationFacilityType('refinery', 'Refinery and oil depot'), 'refinery');
});

test('infrastructure grouping distinguishes transport and energy from production sites', () => {
  assert.equal(presentationFacilityType('logistics_hub', 'Bryansk-I Railway Station'), 'railway_facility');
  assert.equal(presentationFacilityType('logistics_hub', 'Port Kavkaz'), 'port_terminal');
  assert.equal(presentationFacilityType('logistics_hub', 'NKHP grain terminal, Novorossiysk'), 'port_terminal');
  assert.equal(presentationFacilityType('logistics_hub', 'Port of Primorsk oil terminal'), 'oil_depot');
  assert.equal(presentationFacilityType('industrial_facility', 'Kashira State District Power Station'), 'power_infrastructure');
  assert.equal(presentationFacilityType('industrial_facility', 'Power substation in Sloboda Belaya'), 'power_infrastructure');
  assert.equal(presentationFacilityType('industrial_facility', 'Low-voltage equipment plant, Korenevo'), 'industrial_facility');
  assert.equal(presentationFacilityType('industrial_facility', 'Railway equipment factory'), 'industrial_facility');
});
