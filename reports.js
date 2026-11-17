import { incidentStatusMatches, operationStatusMatches } from './facility-status.js';
import { statusFilterMatches } from './status.js';
import { validDate, safeLink, normalizeOperator } from './data.js?v=approval-2';

const types = new Set(['warehouse', 'logistics_hub', 'bridge', 'refinery', 'oil_well', 'data_center', 'military_facility', 'defence_manufacturing', 'government_building', 'drone_facility', 'robotics_facility', 'industrial_facility']);
const mediaLabels = {
  photo_backed_unverified: 'Photo-backed · unverified',
  video_backed_unverified: 'Video-backed · unverified',
  text_only: 'Text only · unverified',
  mixed_media_unverified: 'Mixed media · unverified'
};
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const postId = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !!validDate(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));

export function citationLabel(citation) {
  const relationship = citation.relationship === 'independently_found' ? 'Independent source' : 'Cited source';
  return `${relationship} · ${citation.access === 'read' ? 'checked' : 'linked, unread'}`;
}

export function reportPhotos(report) {
  const seen = new Set();
  return report.updates.flatMap(update => (update.photos || []).map(photo => ({...photo, post_id: update.post_id, source_url: update.source_url}))).filter(photo => {
    if (seen.has(photo.sha256)) return false;
    seen.add(photo.sha256); return true;
  });
}

export function facilityPhoto(incidents, facilityId, { approvedOnly = false } = {}) {
  const matches = incidents.filter(report => report.facility_id === facilityId);
  matches.sort((a, b) => Math.max(...b.updates.map(update => Date.parse(update.posted_at))) - Math.max(...a.updates.map(update => Date.parse(update.posted_at))));
  for (const report of matches) {
    const photo = reportPhotos(report)[0];
    if (photo) return photo;
  }
  return null;
}

function validateUpdateEvidence(update) {
  if (update.duplicate_posts !== undefined) {
    if (!Array.isArray(update.duplicate_posts)) throw new Error('Invalid dated duplicate posts.');
    const seen = new Set();
    for (const duplicate of update.duplicate_posts) {
      if (!duplicate || !postId(duplicate.post_id) || seen.has(duplicate.post_id) || !update.duplicate_post_ids.includes(duplicate.post_id) || !timestamp(duplicate.posted_at) || duplicate.source_url !== `https://t.me/supernova_plus/${duplicate.post_id}`) throw new Error('Invalid dated duplicate posts.');
      seen.add(duplicate.post_id);
    }
  }
  if (update.source_attribution !== undefined && update.source_attribution !== null && !text(update.source_attribution)) throw new Error('Invalid source attribution.');
  if (update.citations !== undefined) {
    if (!Array.isArray(update.citations) || update.citations.some(citation => !citation || !text(citation.name) || !safeLink(citation.url) || !['cited_by_post', 'independently_found'].includes(citation.relationship) || !['linked_not_read', 'read'].includes(citation.access))) throw new Error('Invalid report citation.');
  }
  if (update.photos !== undefined) {
    if (!Array.isArray(update.photos)) throw new Error('Invalid report photos.');
    for (const photo of update.photos) {
      const match = typeof photo?.path === 'string' && /^img\/reports\/tg-([1-9]\d*)-([a-f0-9]{12})\.jpg$/.exec(photo.path);
      if (!match || match[1] !== String(update.post_id) || !/^[a-f0-9]{64}$/.test(photo.sha256) || !photo.sha256.startsWith(match[2]) || typeof photo.source_reference !== 'string' || !/^photos\/[A-Za-z0-9][A-Za-z0-9_@.-]*\.jpg$/.test(photo.source_reference) || photo.source_reference.includes('..') || !update.media_available || !['photo', 'mixed'].includes(update.media_kind)) throw new Error('Unsafe or inconsistent report photo.');
    }
  }
}

export function mediaLabel(report) {
  const status = report.media_status;
  if (status === 'text_only') return mediaLabels.text_only;
  const kinds = status === 'mixed_media_unverified' ? ['photo', 'video', 'mixed'] : status === 'photo_backed_unverified' ? ['photo', 'mixed'] : ['video', 'mixed'];
  const available = report.updates.some(update => kinds.includes(update.media_kind) && update.media_available);
  if (available) return mediaLabels[status] || 'Unverified';
  return ({photo_backed_unverified: 'Photo referenced · unverified', video_backed_unverified: 'Video referenced · unverified', mixed_media_unverified: 'Media referenced · unverified'})[status] || 'Unverified';
}

export function validateReports(data) {
  if (data?.schema_version !== 1 || data.source !== 'Supernova+' || !timestamp(data.imported_at) || !Array.isArray(data.incidents)) throw new Error('Invalid incident report collection.');
  const incidentIds = new Set(), posts = new Set();
  for (const incident of data.incidents) {
    if (!incident || !id(incident.id) || incidentIds.has(incident.id) || !(incident.facility_id === null || id(incident.facility_id)) || !text(incident.facility_name) || !types.has(incident.facility_type) || !text(incident.location) || !['Russia', 'Crimea (Russian-occupied)'].includes(incident.country) || !(incident.event_date === null || validDate(incident.event_date)) || !text(incident.summary) || incident.approval_status !== 'unapproved' || !Object.hasOwn(mediaLabels, incident.media_status) || !Array.isArray(incident.updates) || !incident.updates.length) throw new Error('Invalid or duplicate incident report.');
    if (incident.reported_operators != null && (!Array.isArray(incident.reported_operators) || incident.reported_operators.some(value => !text(value)))) throw new Error('Invalid reported operators.');
    incidentIds.add(incident.id);
    const mediaKinds = new Set();
    for (const update of incident.updates) {
      if (!update || !postId(update.post_id) || !timestamp(update.posted_at) || !['report', 'update', 'correction'].includes(update.kind) || !text(update.summary) || update.source_url !== `https://t.me/supernova_plus/${update.post_id}` || !['photo', 'video', 'mixed', 'none'].includes(update.media_kind) || typeof update.media_available !== 'boolean' || !Array.isArray(update.duplicate_post_ids) || update.duplicate_post_ids.some(value => !postId(value))) throw new Error(`Invalid source update for ${incident.id}.`);
      validateUpdateEvidence(update);
      for (const value of [update.post_id, ...update.duplicate_post_ids]) {
        if (posts.has(value)) throw new Error(`Duplicate source post: ${value}.`);
        posts.add(value);
      }
      if (update.media_kind !== 'none') mediaKinds.add(update.media_kind);
      if (update.media_kind === 'none' && update.media_available) throw new Error('Text-only update cannot have available media.');
    }
    const expected = !mediaKinds.size ? 'text_only' : mediaKinds.size > 1 || mediaKinds.has('mixed') ? 'mixed_media_unverified' : mediaKinds.has('photo') ? 'photo_backed_unverified' : 'video_backed_unverified';
    if (incident.media_status !== expected) throw new Error(`Inconsistent media label for ${incident.id}.`);
  }
  return data;
}

// Canonical UTF-8 JSON matches the audit builder (raw report fields only).
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function sha256(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function identityMatches(report, review) {
  if (report.facility_id === review.facility_id) return true;
  const binding=review.identity_binding;
  return report.facility_id === null && binding && Object.hasOwn(binding,'raw_facility_id') && binding.raw_facility_id === null && binding.facility_id === review.facility_id && text(binding.rationale) && Array.isArray(binding.evidence_urls) && binding.evidence_urls.length>0 && binding.evidence_urls.every(url=>typeof url==='string' && review.evidence_urls?.includes(url));
}

function eventTimingMatches(report, review) {
  if (!Object.hasOwn(review,'event_timezone') && !Object.hasOwn(review,'timing_rationale')) return report.updates.some(update=>update.posted_at.slice(0,10)>=review.event_date);
  if (!text(review.event_timezone) || !text(review.timing_rationale) || !/^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z0-9_+-]*)+)$/.test(review.event_timezone)) return false;
  const formatter=new Intl.DateTimeFormat('en',{timeZone:review.event_timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  return report.updates.some(update=>{
    const parts=Object.fromEntries(formatter.formatToParts(new Date(update.posted_at)).map(part=>[part.type,part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`>=review.event_date;
  });
}

export async function applyReportApprovals(incidents, overlay, facilities) {
  if (overlay?.schema_version !== 1 || !Array.isArray(overlay.approvals) || !Array.isArray(facilities)) return incidents;
  const approved = new Map(), duplicates = new Set();
  for (const review of overlay.approvals) {
    if (approved.has(review?.report_id)) duplicates.add(review.report_id);
    approved.set(review?.report_id, review);
  }
  return Promise.all(incidents.map(async report => {
    const review = approved.get(report.id);
    if (!review || duplicates.has(report.id)) return report;
    try {
      const facility = facilities.find(item => item.id === review.facility_id);
      const incident = facility?.incidents?.find(item => item.id === review.incident_id);
      const sources = new Set((facility?.sources || []).filter(source => source.supports?.includes('incidents')).map(source => source.url));
      if (review.schema_version !== 1 || review.decision !== 'approved' || review.scope !== 'incident_date_town' || !text(review.approved_summary) || !text(review.reviewed_by) || !text(review.model) || !timestamp(review.reviewed_at) || !identityMatches(report, review) || facility?.verification?.status !== 'ai_reviewed' || !Number.isSafeInteger(review.facility_version) || facility.version !== review.facility_version || !validDate(review.event_date) || incident?.date !== review.event_date || (report.event_date !== null && report.event_date !== review.event_date) || !eventTimingMatches(report, review) || !Array.isArray(review.evidence_urls) || !review.evidence_urls.length || !review.evidence_urls.every(url => safeLink(url) && sources.has(url)) || review.report_sha256 !== await sha256(report) || review.facility_sha256 !== await sha256(facility)) return report;
      return {...report, facility_id: review.facility_id, event_date: review.event_date, approval_status: 'approved', approval: {...review}};
    } catch { return report; }
  }));
}

export async function loadReports(fetcher = fetch) {
  try {
    const response = await fetcher('data/unapproved-reports.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = validateReports(await response.json());
    let incidents = data.incidents;
    try {
      const approvalResponse = await fetcher('data/report-approvals.json', {cache: 'no-store'});
      if (approvalResponse.ok) {
        const overlay = await approvalResponse.json();
        if (overlay?.approvals?.length) {
          const facilityResponse = await fetcher('data/reviewed-facilities.json', {cache: 'no-store'});
          if (facilityResponse.ok) incidents = await applyReportApprovals(incidents, overlay, await facilityResponse.json());
        }
      }
    } catch { /* Missing/stale review overlays never suppress raw source reports. */ }
    return { incidents, error: null };
  } catch {
    return { incidents: [], error: 'Unapproved incident reports unavailable.' };
  }
}

// Unknown event dates use the first source posting day, never a later correction.
function reportDate(report) {
  return report.event_date || report.updates.map(update => update.posted_at.slice(0, 10)).sort()[0] || '';
}
function reportHasSource(report, domain) {
  const urls = [
    ...report.updates.flatMap(update => [update.source_url, ...(update.citations || []).map(citation => citation.url)]),
    ...(report.approval?.evidence_urls || [])
  ];
  return urls.some(url => {
    try { return !!safeLink(url) && new URL(url).hostname.replace(/^www\./, '') === domain; }
    catch { return false; }
  });
}
function matchesReportMedia(report, media) {
  if (!media) return true;
  if (media === 'photos') return reportPhotos(report).length > 0;
  if (media === 'video') return report.updates.some(update => ['video', 'mixed'].includes(update.media_kind));
  if (media === 'text_only') return report.media_status === 'text_only';
  if (media === 'missing') return report.media_status !== 'text_only' && !report.updates.some(update => update.media_available);
  return true;
}

export function selectReports(incidents, records, filters = {}) {
  if (filters.incident === 'none') return [];
  const facilities = new Map(records.map(record => [record.id, record]));
  const query = (filters.query || '').trim().toLocaleLowerCase();
  return incidents.filter(incident => {
    const facility = facilities.get(incident.facility_id);
    const date = reportDate(incident);
    return (!filters.review || (filters.review === 'approved' ? incident.approval_status === 'approved' : incident.approval_status !== 'approved')) &&
      (!filters.group || (filters.group === 'energy' ? ['refinery', 'oil_well'].includes(incident.facility_type) : filters.group === 'digital' ? incident.facility_type === 'data_center' : filters.group === 'logistics' ? ['warehouse', 'logistics_hub', 'bridge'].includes(incident.facility_type) : filters.group === 'defence' ? ['military_facility', 'defence_manufacturing'].includes(incident.facility_type) : filters.group === 'government' ? incident.facility_type === 'government_building' : filters.group === 'industry' ? ['drone_facility', 'robotics_facility', 'industrial_facility'].includes(incident.facility_type) : false)) &&
      (!filters.dateFrom || (date && date >= filters.dateFrom)) &&
      (!filters.dateTo || (date && date <= filters.dateTo)) &&
      (!filters.source || reportHasSource(incident, filters.source)) &&
      (!filters.favoriteIds || filters.favoriteIds.has(incident.facility_id)) &&
      (!filters.status || facility && (operationStatusMatches(facility, filters.status) ?? statusFilterMatches(facility, filters.status))) && (!filters.attackStatus || facility && incidentStatusMatches(facility, filters.attackStatus)) &&
      (filters.damage === '' || filters.damage == null || facility?.inheritedDamage === Number(filters.damage)) &&
      (!filters.missing || (facility && (filters.missing === 'operator' ? facility.operator === 'Not recorded' : filters.missing === 'region' ? facility.region === 'Not recorded' : filters.missing === 'footprint' ? facility.footprint == null : facility.operationalStatus === 'unknown'))) &&
      matchesReportMedia(incident, filters.media) && (!filters.approvedOnly || incident.approval_status === 'approved') &&
      (!filters.type || incident.facility_type === filters.type) &&
      (!filters.operator || (facility && normalizeOperator(facility.operator) === normalizeOperator(filters.operator)) || incident.reported_operators?.some(operator => normalizeOperator(operator) === normalizeOperator(filters.operator))) &&
      (!filters.region || (facility?.region || incident.location) === filters.region) &&
      (!query || [incident.id, incident.facility_id, incident.facility_name, incident.location, incident.country, incident.summary, facility?.operator, ...incident.updates.map(update => update.summary)].join(' ').toLocaleLowerCase().includes(query));
  }).sort((a, b) => reportDate(b).localeCompare(reportDate(a)) || a.facility_name.localeCompare(b.facility_name) || a.id.localeCompare(b.id));
}
