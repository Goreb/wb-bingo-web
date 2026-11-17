import test from 'node:test';
import assert from 'node:assert/strict';
import { facilityCardName } from '../display.js';

test('warehouse card titles retain site identity and uncertainty without repeated labels', () => {
  const record = { type: 'warehouse', operator: 'Ozon', name: 'Reported Ozon warehouse, Voronezh (site unspecified)' };
  assert.deepEqual(facilityCardName(record), { title: 'Voronezh', subtitles: ['Reported', 'site unspecified'] });
  assert.equal(record.name, 'Reported Ozon warehouse, Voronezh (site unspecified)');
  assert.deepEqual(facilityCardName({ type: 'warehouse', operator: 'Wildberries', name: 'Wildberries & Russ warehouse premises, Nikolskoye 2 industrial park (unit unspecified)' }), { title: 'Nikolskoye 2 industrial park', subtitles: ['unit unspecified'] });
  assert.equal(facilityCardName({ type: 'warehouse', operator: 'Wildberries', name: 'Wildberries Chekhov-2 warehouse, Novoselki' }).title, 'Chekhov-2, Novoselki');
});

test('construction, unknown operators and other categories are preserved', () => {
  assert.equal(facilityCardName({ type: 'warehouse', operator: '?', name: 'Warehouse under construction, Cheboksary' }).title, 'Under construction, Cheboksary');
  assert.equal(facilityCardName({ type: 'warehouse', operator: '?', name: 'Ozon warehouse, Voronezh' }).title, 'Ozon, Voronezh');
  assert.equal(facilityCardName({ type: 'warehouse', operator: '?', name: 'Warehouse' }).title, 'Warehouse');
  assert.equal(facilityCardName({ type: 'logistics_hub', operator: 'Ozon', name: 'Ozon warehouse, Voronezh' }).title, 'Ozon warehouse, Voronezh');
});
