import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, PREFERENCE_KEYS, cleanPreferences, loadPreferences, savePreferences, loadFavorites, saveFavorites, loadPresets, savePresets } from '../preferences.js';
function memory() {
  const values = new Map([['unrelated', 'retained']]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
test('corrupt and blocked storage leave defaults available, without deleting anything', () => {
  const storage = memory(); storage.setItem(PREFERENCE_KEYS.preferences, '{broken');
  assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES);
  assert.equal(storage.getItem(PREFERENCE_KEYS.preferences), '{broken');
  const blocked = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota'); } };
  assert.deepEqual(loadPreferences(blocked), DEFAULT_PREFERENCES);
  assert.deepEqual([...loadFavorites(blocked)], []);
  assert.deepEqual(loadPresets(blocked), []);
  assert.equal(savePreferences({}, blocked), false);
  assert.equal(saveFavorites(['WB-001'], blocked), false);
});
test('preferences whitelist values and round-trip explicit false values', () => {
  const storage = memory();
  assert.equal(savePreferences({density:'compact',showBanners:false,mapTiles:false,autoRefresh:15,unknown:'ignore',contrast:'unreadable'}, storage), true);
  const result = loadPreferences(storage);
  assert.equal(result.density, 'compact'); assert.equal(result.showBanners, false); assert.equal(result.mapTiles, false); assert.equal(result.autoRefresh, 15);
  assert.equal(result.contrast, 'high'); assert.equal(Object.hasOwn(result, 'unknown'), false);
  assert.equal(storage.getItem('unrelated'), 'retained');
  assert.deepEqual(cleanPreferences(['compact']), DEFAULT_PREFERENCES);
  assert.equal(cleanPreferences({autoRefresh:'5',showBanners:'false'}).autoRefresh, 0);
  assert.equal(cleanPreferences({showBanners:'false'}).showBanners, true);
});
test('favorites preserve facility and report IDs, deduplicate and discard malformed values', () => {
  const storage = memory();
  saveFavorites(new Set(['WB-001','report:tg-42',null,44,'','bad\nvalue',' WB-003']), storage);
  assert.deepEqual([...loadFavorites(storage)], ['WB-001','report:tg-42']);
  storage.setItem(PREFERENCE_KEYS.favorites, '{}'); assert.equal(loadFavorites(storage).size, 0);
});
test('saved presets retain usable filters and discard malformed or duplicate entries', () => {
  const storage = memory();
  savePresets([{id:'one',name:'  Refineries  ',filters:{type:'refinery',approvedOnly:true,damage:'0',source:'Reuters',ignored:'x'}},{id:'one',name:'Duplicate'},{id:'two',name:'  '},null], storage);
  assert.deepEqual(loadPresets(storage), [{id:'one',name:'Refineries',filters:{type:'refinery',damage:'0',source:'Reuters',approvedOnly:true}}]);
  assert.equal(storage.getItem('unrelated'), 'retained');
});
