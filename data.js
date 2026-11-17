import { incidentStatusMatches, operationStatusMatches } from './facility-status.js';
import { hasUnconfirmedOperatingStatus, statusFilterMatches } from './status.js?v=status-v3-20261020';

// Presentation aliases only: source snapshots and approval hashes stay unchanged.
export function normalizeOperator(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || /^(?:unknown|not (?:recorded|identified|reported)(?:\b.*)?)$/i.test(name)) return 'Not recorded';
  if (/^wildberries(?:\s*(?:&|and)\s*russ)?$/i.test(name)) return 'Wildberries';
  if (/^ozon$/i.test(name)) return 'Ozon';
  if (/^key point(?:\s*\((?:3data distributor listing|management operator; legal operator .*)\))?$/i.test(name)) return 'Key Point';
  if (/^3data(?:\s*\(franchise network\))?$/i.test(name)) return '3data';
  if (/^rosneft(?:\s*\(reported as controlling operator\))?$/i.test(name)) return 'Rosneft';
  if (/^transneft(?:\s*\(as reported by Reuters\))?$/i.test(name)) return 'Transneft';
  return name;
}

// Display grouping only; canonical source categories and review bindings are unchanged.
export function presentationFacilityType(type, name) {
  if (['warehouse', 'logistics_hub'].includes(type) &&
      /\b(?:(?:oil|fuel|diesel|petroleum)\s+(?:depot|terminal|storage)|tank\s+farm)\b/i.test(name)) return 'oil_depot';
  if (type === 'logistics_hub' && /\bbridge\b/i.test(name)) return 'bridge';
  if (type === 'logistics_hub' && /\b(?:railway|railroad)\s+(?:station|bridge|junction|depot|yard)|\brail\s+(?:bridge|junction|yard)\b/i.test(name)) return 'railway_facility';
  if (type === 'logistics_hub' && /\b(?:port|seaport|harbou?r)|\b(?:grain|container|cargo)\s+terminal\b/i.test(name)) return 'port_terminal';
  if (['industrial_facility', 'logistics_hub'].includes(type) &&
      /\b(?:substation|(?:thermal |nuclear )?power (?:plant|station)|gas distribution station)\b/i.test(name)) return 'power_infrastructure';
  return type;
}

export function safeLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function localImage(value) {
  return typeof value === 'string' && /^(?:img\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)|placeholder\.jpg)$/.test(value) ? value : null;
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

const cleanText = (value, fallback = '') => typeof value === 'string' && value.trim() && value !== 'N/A' ? value.trim() : fallback;
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function validateCatalog(catalog) {
  if (catalog?.version !== 1 || !Array.isArray(catalog.categories) || !Array.isArray(catalog.datasets)) throw new Error('Unsupported data catalog.');
  const types = new Set();
  for (const type of catalog.categories) {
    if (!/^[a-z_]+$/.test(type.id) || !cleanText(type.label) || !cleanText(type.singular) || types.has(type.id)) throw new Error('Invalid or duplicate facility category.');
    types.add(type.id);
  }
  const datasets = new Set();
  for (const dataset of catalog.datasets) {
    if (!cleanText(dataset.id) || datasets.has(dataset.id) || !['legacy-wb', 'facilities-v1'].includes(dataset.format) || !/^(?:data\/)?[a-zA-Z0-9_-]+\.json$/.test(dataset.path)) throw new Error('Invalid dataset configuration.');
    datasets.add(dataset.id);
  }
  return catalog;
}

export function normalizeRecords(records, dataset, categories) {
  if (!Array.isArray(records)) throw new Error('Dataset must contain an array of facilities.');
  const types = new Set(categories.map(type => type.id));
  const ids = new Set();
  return records.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || !cleanText(raw.id) || !cleanText(raw.name)) throw new Error(`Record ${index + 1} requires an ID and name.`);
    if (ids.has(raw.id.trim())) throw new Error(`Duplicate facility ID: ${raw.id}`);
    ids.add(raw.id.trim());
    const type = cleanText(raw.facility_type, dataset.defaults?.facility_type);
    if (!types.has(type)) throw new Error(`Unknown facility type for ${raw.id}.`);
    const legacy = dataset.format === 'legacy-wb';
    const events = (legacy ? raw.strikes : raw.incidents) ?? [];
    if (!Array.isArray(events) || (raw.sources != null && !Array.isArray(raw.sources))) throw new Error(`Invalid history or sources for ${raw.id}.`);
    const sources = (raw.sources ?? []).map(source => ({ name: cleanText(source?.name, 'Source reference'), url: safeLink(source?.url), supports: Array.isArray(source?.supports) ? source.supports.filter(item => typeof item === 'string') : [], accessedAt: validDate(source?.accessed_at), accessMethod: cleanText(source?.access_method) }));
    const incidents = events.map(event => ({ id: cleanText(event?.id) || null, date: validDate(event?.date), description: cleanText(event?.description, 'No description supplied.') }));
    const dates = incidents.map(event => event.date).filter(Boolean);
    const explicitDate = validDate(legacy ? raw.last_strike_date : raw.last_incident_date);
    if (explicitDate) dates.push(explicitDate);
    const verification = raw.verification ?? {};
    const reviewedOn = validDate(verification.reviewed_on);
    const reviewedBy = cleanText(verification.reviewed_by);
    const reviewStatus = ['identity_sourced', 'ai_reviewed'].includes(verification.status) && !!reviewedOn && !!reviewedBy && sources.some(source => source.url) ? verification.status : 'unreviewed';
    const statuses = ['unknown', 'operating', 'disrupted', 'temporarily_closed', 'partially_reopened', 'reopened', 'permanently_closed', 'damaged'];
    const sourceOperator = cleanText(raw.operator, dataset.defaults?.operator || 'Not recorded');
    let operator = normalizeOperator(sourceOperator);
    // A source-named warehouse brand can supply the company label without
    // claiming that the brand is the separately registered legal entity.
    if (operator === 'Not recorded' && type === 'warehouse') {
      const brandedName = /^(Wildberries|Ozon) warehouse\b/i.exec(raw.name.trim());
      if (brandedName) operator = normalizeOperator(brandedName[1]);
    }
    return {
      id: raw.id.trim(), key: `${dataset.id}:${raw.id.trim()}`, name: raw.name.trim(),
      type: presentationFacilityType(type, raw.name), sourceType: type, operator, sourceOperator,
      region: cleanText(raw.region, 'Not recorded'), country: cleanText(raw.country),
      footprint: numberOrNull(raw.footprint_m2), image: localImage(raw.image_url),
      incidents, sources, lastIncident: dates.sort().at(-1) || null,
      hasIncident: incidents.length > 0 || !!explicitDate,
      inheritedConfidence: legacy ? cleanText(raw.confidence, 'Not recorded') : null,
      inheritedDamage: legacy ? numberOrNull(raw.damage_level) : null,
      coordinates: cleanText(raw.coordinates),
      summary: cleanText(raw.summary), provenanceNote: cleanText(raw.provenance_note),
      incidentReview: cleanText(raw.incident_review, legacy ? 'inherited' : 'not_reviewed'),
      operationalStatus: reviewStatus === 'ai_reviewed' && validDate(raw.status_as_of) && Array.isArray(raw.status_evidence) && raw.status_evidence.length && statuses.includes(raw.operational_status) ? raw.operational_status : 'unknown',
      statusAsOf: reviewStatus === 'ai_reviewed' && raw.operational_status !== 'unknown' && Array.isArray(raw.status_evidence) && raw.status_evidence.length ? validDate(raw.status_as_of) : null,
      verification: { status: reviewStatus, reviewedOn: reviewStatus !== 'unreviewed' ? reviewedOn : null, reviewedBy: reviewStatus !== 'unreviewed' ? reviewedBy : null },
      datasetId: dataset.id, datasetLabel: dataset.label, legacy
    };
  });
}

export function selectRecords(records, filters) {
  const query = (filters.query || '').toLocaleLowerCase().trim();
  const result = records.filter(record =>
    (!filters.approvedOnly || record.verification.status === 'ai_reviewed') &&
    (!filters.review || (filters.review === 'approved' ? record.verification.status === 'ai_reviewed' : record.verification.status !== 'ai_reviewed')) &&
    (operationStatusMatches(record, filters.status) ?? statusFilterMatches(record, filters.status)) &&
    incidentStatusMatches(record, filters.attackStatus) &&
    (filters.damage === '' || filters.damage == null || record.inheritedDamage === Number(filters.damage)) &&
    (!filters.dateFrom || (record.lastIncident && record.lastIncident >= filters.dateFrom)) &&
    (!filters.dateTo || (record.lastIncident && record.lastIncident <= filters.dateTo)) &&
    (!filters.source || record.sources.some(source => source.url && new URL(source.url).hostname.replace(/^www\./,'') === filters.source)) &&
    (!filters.missing || (filters.missing === 'operator' ? record.operator === 'Not recorded' : filters.missing === 'region' ? record.region === 'Not recorded' : filters.missing === 'footprint' ? record.footprint == null : hasUnconfirmedOperatingStatus(record))) &&
    (!filters.group || (filters.group === 'energy' ? ['refinery','oil_well','oil_depot','power_infrastructure'].includes(record.type) : filters.group === 'digital' ? record.type === 'data_center' : filters.group === 'logistics' ? ['warehouse','logistics_hub','port_terminal','railway_facility','bridge'].includes(record.type) : filters.group === 'defence' ? ['military_facility','defence_manufacturing'].includes(record.type) : filters.group === 'government' ? record.type === 'government_building' : filters.group === 'industry' ? ['drone_facility','robotics_facility','industrial_facility'].includes(record.type) : false)) &&
    (!filters.favoriteIds || filters.favoriteIds.has(record.id)) &&
    (!filters.type || record.type === filters.type) &&
    (!filters.operator || normalizeOperator(record.operator) === normalizeOperator(filters.operator)) &&
    (!filters.region || record.region === filters.region) &&
    (!filters.incident || (filters.incident === 'reported' ? record.hasIncident : !record.hasIncident)) &&
    (!query || [record.id, record.name, record.region, record.country, record.operator, record.sourceOperator].join(' ').toLocaleLowerCase().includes(query))
  );
  const compareName = (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  result.sort((a, b) => {
    if (filters.sort === 'recent') return (b.lastIncident || '').localeCompare(a.lastIncident || '') || compareName(a, b);
    if (filters.sort === 'area') return (b.footprint ?? -1) - (a.footprint ?? -1) || compareName(a, b);
    return compareName(a, b);
  });
  return result;
}

export async function loadCollection(fetcher = fetch) {
  const read = async path => {
    const response = await fetcher(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
    return response.json();
  };
  const catalog = validateCatalog(await read('data/catalog.json'));
  if (!catalog.categories.some(type => type.id === 'oil_depot')) {
    const oilWellsIndex = catalog.categories.findIndex(type => type.id === 'oil_well');
    catalog.categories.splice(oilWellsIndex >= 0 ? oilWellsIndex + 1 : catalog.categories.length, 0,
      { id: 'oil_depot', label: 'Oil depots', singular: 'Oil depot', symbol: 'OD', description: 'Oil and fuel depots, storage facilities and terminals.' });
  }
  const displayCategories = [
    { id: 'port_terminal', after: 'logistics_hub', label: 'Ports & terminals', singular: 'Port / terminal', symbol: 'PT' },
    { id: 'railway_facility', after: 'port_terminal', label: 'Railway facilities', singular: 'Railway facility', symbol: 'RL' },
    { id: 'power_infrastructure', after: 'oil_depot', label: 'Power infrastructure', singular: 'Power infrastructure', symbol: 'PW' }
  ];
  for (const { after, ...category } of displayCategories) {
    if (catalog.categories.some(type => type.id === category.id)) continue;
    const index = catalog.categories.findIndex(type => type.id === after);
    catalog.categories.splice(index >= 0 ? index + 1 : catalog.categories.length, 0, category);
  }
  const results = await Promise.allSettled(catalog.datasets.map(async dataset => normalizeRecords(await read(dataset.path), dataset, catalog.categories)));
  const records = [], failures = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') records.push(...result.value);
    else failures.push({ id: catalog.datasets[index].id, label: catalog.datasets[index].label, message: result.reason.message });
  });
  if (failures.length && failures.length === catalog.datasets.length) throw new Error('The facility datasets could not be loaded. Check the files and try again.');
  const unique = new Map();
  for (const record of records) {
    const previous = unique.get(record.id);
    if (previous?.legacy && record.verification.status === 'ai_reviewed') Object.assign(record,{inheritedDamage:previous.inheritedDamage,inheritedConfidence:previous.inheritedConfidence,hasOriginalRecord:true});
    if (record.legacy && previous?.verification.status === 'ai_reviewed') Object.assign(previous,{inheritedDamage:record.inheritedDamage,inheritedConfidence:record.inheritedConfidence,hasOriginalRecord:true});
    if (!previous || (previous.verification.status !== 'ai_reviewed' && record.verification.status === 'ai_reviewed')) unique.set(record.id, record);
    else if (!(record.verification.status !== 'ai_reviewed' && previous.verification.status === 'ai_reviewed')) throw new Error(`Duplicate facility ID across datasets: ${record.id}`);
  }
  return { catalog, records: [...unique.values()], failures };
}
