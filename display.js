// Stored dates remain ISO; display the source's calendar date without timezone shifts.
export function displayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '?';
}
export function displayTimestamp(value) {
  const day = displayDate(value);
  if (day === '?') return day;
  const time = /T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(value || '');
  return time ? `${day} · ${time[1]} ${time[2] === 'Z' ? 'UTC' : `UTC${time[2]}`}` : day;
}
export const displayValue = value => value == null || value === '' || /^(not (?:recorded|established|reported|provided|specified)(?: by .+)?|unknown|unspecified)$/i.test(String(value)) ? '?' : value;
export const displayStatus = status => status.label === 'Operating status unknown' ? '?' : status.label.replace('operation unknown', 'operation ?');

// Compact card labels only; stored geography and detailed source wording remain intact.
const cleanArea = value => String(value || '').replace(/\s*\([^)]*\)/g, '').replace(/\bRepublic of\s+/gi, '').replace(/\s+(region|oblast|krai|territory|autonomous (?:district|okrug)|okrug)\b/gi, '').trim();
export function locationRegions(records) {
  const regions = new Map();
  for (const record of records) {
    const parts = String(record.region || '').split(',').map(cleanArea).filter(Boolean);
    if (parts.length < 2) continue;
    const town = parts[0].toLowerCase(), area = parts.at(-1);
    if (!regions.has(town)) regions.set(town, area);
    else if (regions.get(town) !== area) regions.set(town, null);
  }
  return regions;
}
export function displayLocation(record, { town = null, regions = new Map() } = {}) {
  const rawRegion = String(record.region || '');
  const parts = rawRegion.split(',').map(cleanArea).filter(Boolean);
  const isArea = /oblast|krai|region|republic|okrug|autonomous|territory|Crimea|Tatarstan|Dagestan|Bashkortostan|Bashkiria|Udmurtia|Mari El/i.test(rawRegion);
  const townName = parts.length > 1 ? parts[0] : town || (!isArea ? parts[0] : null) || '?';
  const areaName = parts.length > 1 ? parts.at(-1) : isArea ? parts[0] : regions.get(townName.toLowerCase()) || (/^(Moscow|Saint Petersburg)$/i.test(townName) ? townName : '?');
  const region = `${townName}, ${areaName || '?'}`;
  // The original collection covers Russia and explicitly labelled occupied Crimea.
  const country = record.country || (record.legacy ? (/\bCrimea\b/i.test(record.region || '') ? 'Ukraine' : 'Russia') : null);
  const flag = { Russia: '🇷🇺', Ukraine: '🇺🇦' }[country] || displayValue(country);
  const regionalFlags = [
    [/\bTatarstan\b/i, 'Tatarstan', 'tatarstan'],
    [/\bDagestan\b/i, 'Dagestan', 'dagestan'],
    [/\b(Bashkortostan|Bashkiria)\b/i, 'Bashkortostan', 'bashkortostan'],
    [/\b(Udmurtia|Udmurt Republic)\b/i, 'Udmurtia', 'udmurtia'],
    [/\bMari El\b/i, 'Mari El', 'mari-el']
  ];
  // Never substitute regional flags for Ukraine, including Crimea.
  const regional = country === 'Russia' ? regionalFlags.find(([pattern]) => pattern.test(record.region || '')) : null;
  return { label: `📍 ${region} · ${flag}`, placeLabel: `📍 ${region} · `,
    flagPath: regional ? `img/flags/${regional[2]}.svg` : { Russia: 'img/flags/russia.svg', Ukraine: 'img/flags/ukraine.svg' }[country] || null,
    flagName: regional?.[1] || country,
    description: `${region} · ${regional ? `${regional[1]} flag · ` : ''}${displayValue(country)}` };

}

// Warehouse thumbnail accents only; operating and incident colours stay independent.
export function warehouseBrand(record) {
  if (record.type !== 'warehouse') return null;
  const operator = String(record.operator || '').trim().toLowerCase();
  if (/^wildberries(?:\s*(?:&|and)\s*russ)?$/.test(operator)) return { key: 'wildberries', color: '#bb63e8', logo: 'img/brands/wildberries.svg', label: 'Wildberries' };
  if (operator === 'ozon') return { key: 'ozon', color: '#65baff', logo: 'img/brands/ozon.svg', label: 'Ozon' };
  return null;
}

export function facilityNameParts(value) {
  const name = String(value || ''), stack = [], ranges = [];
  let start = -1;
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    if (char === '(' || char === '[') {
      if (!stack.length) start = i;
      stack.push(char);
    } else if (stack.length && ((char === ')' && stack.at(-1) === '(') || (char === ']' && stack.at(-1) === '['))) {
      stack.pop();
      if (!stack.length) ranges.push([start, i]);
    }
  }
  let title = '', cursor = 0;
  const subtitles = [];
  for (const [start, end] of ranges) {
    title += name.slice(cursor, start) + ' ';
    const subtitle = name.slice(start + 1, end).trim();
    if (subtitle) subtitles.push(subtitle);
    cursor = end + 1;
  }
  title = (title + name.slice(cursor)).replace(/\s+/g, ' ').trim();
  return title ? { title, subtitles } : { title: name, subtitles: [] };
}

// Compact display only: canonical names, search and source assertions stay intact.
export function facilityCardName(record) {
  const parts = facilityNameParts(record.name);
  if (record.type !== 'warehouse') return parts;
  let title = parts.title;
  const subtitles = [...parts.subtitles];
  if (/^reported\s+/i.test(title)) {
    title = title.replace(/^reported\s+/i, '');
    subtitles.unshift('Reported');
  }
  const brand = warehouseBrand(record);
  if (brand?.key === 'wildberries') title = title.replace(/\bWildberries(?:\s*(?:&|and)\s*Russ)?\b/gi, '');
  if (brand?.key === 'ozon') title = title.replace(/\bOzon\b/gi, '');
  title = title.replace(/\bwarehouses?(?:\s+premises)?\b/gi, '')
    .replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '');
  if (!title) return parts;
  title = title[0].toUpperCase() + title.slice(1);
  return { title, subtitles };
}
