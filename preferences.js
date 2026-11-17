// Browser-only preferences. Storage failures leave the collection usable.
export const DEFAULT_PREFERENCES = Object.freeze({
  defaultView: 'facilities', density: 'comfortable', fontSize: 'standard', contrast: 'high', evidenceMode: 'cautious',
  showBanners: true, showSourceDetails: false,
  mapTiles: true, mapZoom: 'regional', autoRefresh: 0, dateFormat: 'european',
  rememberFilters: false, reduceMotion: false
});
export const PREFERENCE_KEYS = Object.freeze({ preferences: 'bingo.preferences.v1', favorites: 'bingo.favorites.v1', presets: 'bingo.presets.v1' });
const choices = {
  defaultView: ['overview', 'facilities', 'incidents', 'favorites', 'settings'],
  density: ['comfortable', 'compact'], fontSize: ['standard', 'large'], contrast: ['high', 'standard'],
  mapZoom: ['regional', 'country'], autoRefresh: [0, 5, 15, 60], dateFormat: ['european'], evidenceMode: ['cautious', 'bold']
};
export function cleanPreferences(input) {
  const result = { ...DEFAULT_PREFERENCES };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, fallback] of Object.entries(DEFAULT_PREFERENCES)) {
    if (!Object.hasOwn(input, key)) continue;
    if (choices[key]?.includes(input[key]) || typeof fallback === 'boolean' && typeof input[key] === 'boolean') result[key] = input[key];
  }
  return result;
}
function read(key, storage) {
  try { return JSON.parse((storage ?? globalThis.localStorage)?.getItem(key) ?? 'null'); } catch { return null; }
}
function write(key, value, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target || typeof target.setItem !== 'function') return false;
    target.setItem(key, JSON.stringify(value)); return true;
  } catch { return false; }
}
export function loadPreferences(storage) {
  const stored = read(PREFERENCE_KEYS.preferences, storage);
  const preferences = cleanPreferences(stored);
  // Move the old Overview landing default once, retaining all other settings.
  if (stored?.defaultView === 'overview' && stored.landingDefaultVersion !== 2) preferences.defaultView = 'facilities';
  return preferences;
}
export function savePreferences(value, storage) { return write(PREFERENCE_KEYS.preferences, { ...cleanPreferences(value), landingDefaultVersion: 2 }, storage); }
function cleanIds(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(id => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 240 && !/[\u0000-\u001f]/.test(id)))];
}
export function loadFavorites(storage) { return new Set(cleanIds(read(PREFERENCE_KEYS.favorites, storage))); }
export function saveFavorites(iterable, storage) {
  try { return write(PREFERENCE_KEYS.favorites, cleanIds(Array.from(iterable)), storage); } catch { return false; }
}
const filterStrings = ['query', 'type', 'attackStatus', 'group', 'operator', 'region', 'incident', 'sort', 'review', 'status', 'media', 'dateFrom', 'dateTo', 'damage', 'missing', 'source'];
function cleanFilters(input) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const key of filterStrings) if (Object.hasOwn(input, key) && typeof input[key] === 'string' && input[key].length <= 500) result[key] = input[key];
  if (typeof input.approvedOnly === 'boolean') result.approvedOnly = input.approvedOnly;
  return result;
}
function cleanPresets(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 120 || seen.has(item.id) || typeof item.name !== 'string' || !item.name.trim()) return [];
    seen.add(item.id);
    return [{ id: item.id, name: item.name.trim().slice(0, 80), filters: cleanFilters(item.filters) }];
  });
}
export function loadPresets(storage) { return cleanPresets(read(PREFERENCE_KEYS.presets, storage)); }
export function savePresets(value, storage) { return write(PREFERENCE_KEYS.presets, cleanPresets(value), storage); }
