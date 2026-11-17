import { latestFacilityUpdate } from './latest-update.js?v=latest-tile-20261026';
import { incidentPresentation, operationPresentation } from './facility-status.js?v=card-ui-20261026-2';
import { displayDate, displayTimestamp, displayValue, displayStatus, displayLocation, locationRegions, warehouseBrand, facilityNameParts, facilityCardName } from './display.js?v=warehouse-logos-20261026';
import { groupIncidentReports } from './incident-groups.js';
import { loadPreferences, savePreferences, loadFavorites, saveFavorites, loadPresets, savePresets, cleanPreferences, DEFAULT_PREFERENCES } from './preferences.js?v=warehouse-start-20261026';
import { renderOverviewMap, approximateTown, townIndex } from './overview-map.js';
import { reportMedia, mediaPreview, createMediaGallery, orderedFacilityMedia } from './gallery.js?v=inline-telegram-20261026';
import { loadCollection, selectRecords, safeLink, normalizeOperator } from './data.js?v=infrastructure-20261026';
import { loadReports, selectReports, mediaLabel, citationLabel } from './reports.js?v=workbench-1';
import { statusPresentation, explicitOriginFlag, applyStatusClaims } from './status.js?v=status-v3-20261020';

const $ = id => document.getElementById(id);
const create = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const formatNumber = value => new Intl.NumberFormat('en').format(value);
const state = { catalog: null, records: [], failures: [], type: 'warehouse', compact: false, loading: false, limit: 24, updateStatus: null, reports: [], reportError: null, reportLimit: 6, trustPolicy: null, photoThumbnails: null, reportMedia: null };
const filterControls = ['searchInput', 'operatorFilter', 'regionFilter', 'incidentFilter', 'sortSelect', 'approvedOnly', 'incidentsOnly'];
const reviewLabels = { unreviewed: 'Needs review', identity_sourced: 'Identity sourced', ai_reviewed: 'AI reviewed' };
const DAMAGE_LABELS = ['No damage', 'Targeted', 'Small Fire', 'Medium Fire', 'Large Fire', 'Fully uploaded to Cloud'];

const preferences = loadPreferences();
const boldMode = () => preferences.evidenceMode === 'bold';
let favorites = loadFavorites(), presets = loadPresets(), view = preferences.defaultView, refreshTimer;
const advanced = {attackStatus:'attackStatusFilter', group:'groupFilter', review:'reviewFilter', status:'statusFilter', media:'mediaFilter', dateFrom:'dateFrom', dateTo:'dateTo', damage:'damageFilter', missing:'missingFilter', source:'sourceFilter'};
filterControls.push(...Object.values(advanced));
function filters() {
  const advancedFilters=Object.fromEntries(Object.entries(advanced).map(([key,id])=>[key,$(id).value]));
  if(boldMode())advancedFilters.review='';
  return { query: $('searchInput').value, type: state.type, operator: $('operatorFilter').value, region: $('regionFilter').value, incident: $('incidentFilter').value, sort: $('sortSelect').value, approvedOnly: $('approvedOnly').checked&&!boldMode(), ...advancedFilters, ...(view==='favorites'?{favoriteIds:favorites}:{}) };
}
function favoriteButton(record) {
  const button=create('button','favorite-button',favorites.has(record.id)?'★':'☆');button.type='button';
  button.setAttribute('aria-pressed',String(favorites.has(record.id)));button.setAttribute('aria-label',`${favorites.has(record.id)?'Remove from':'Add to'} favorites: ${record.name}`);
  button.addEventListener('click',event=>{event.stopPropagation();favorites.has(record.id)?favorites.delete(record.id):favorites.add(record.id);if(!saveFavorites(favorites))$('settingsMessage').textContent='Browser storage unavailable; favorites last for this session.';button.textContent=favorites.has(record.id)?'★':'☆';button.setAttribute('aria-pressed',String(favorites.has(record.id)));button.setAttribute('aria-label',`${favorites.has(record.id)?'Remove from':'Add to'} favorites: ${record.name}`);renderResults(true);});return button;
}
function matchesMedia(record) {
  const mode=$('mediaFilter').value;if(!mode)return true;
  const items=orderedFacilityMedia(state.reports,state.reportMedia,record.id,thumbnailPath);
  const photo=items.some(item=>item.kind==='image')||!!record.image, video=items.some(item=>item.kind==='video'||item.kind==='telegram_video');
  return mode==='photos'?photo:mode==='video'?video:mode==='text_only'?!photo&&!video:!items.some(item=>item.src||item.thumbnail)&&!record.image;
}
function selectedReports() { const current=filters(); if(boldMode()){current.approvedOnly=false;current.review='';} return selectReports(groupIncidentReports(state.reports),state.records,current); }
function switchView(next) {
  document.querySelectorAll('.media-gallery').forEach(g=>g.dispatchEvent(new Event('gallery-pause')));
  view=next;
  if(next==='favorites'){resetFilters(false);if(state.catalog)renderCategories();}
  document.querySelectorAll('#workspaceTabs [data-view]').forEach(button=>{const active=button.dataset.view===view;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
  $('overviewPanel').hidden=view!=='overview';$('settingsPanel').hidden=view!=='settings';$('explorer').hidden=['overview','settings'].includes(view);
  const tab=document.querySelector(`#workspaceTabs [data-view="${view}"]`);if(tab)$('explorer').setAttribute('aria-labelledby',tab.id);
  $('explorerTitle').textContent=view==='favorites'?'Your favorites':view==='incidents'?'Incident reports':'Explore facilities';
  renderResults();
}
const dateLabel = displayDate;

function link(label, url) {
  const safe = safeLink(url);
  if (!safe) return create('span', '', `${label} (link unavailable)`);
  const anchor = create('a', '', label);
  anchor.href = safe; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
  return anchor;
}
function metric(label, value) {
  const box = create('div', 'metric-item');
  box.append(create('span', 'metric-label', label), create('span', 'metric-value', value));
  return box;
}
function fillSelect(id, field, label) {
  const select = $(id), previous = select.value;
  select.replaceChildren(new Option(label, ''));
  [...new Set([...state.records.map(record => record[field]), ...(field === 'operator' ? state.reports.flatMap(report => report.reported_operators || []).map(normalizeOperator) : field === 'region' ? state.reports.map(report => report.location) : [])])].sort((a,b) => a.localeCompare(b)).forEach(value => select.add(new Option(value, value)));
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}
function refreshOperatorOptions() {
  const select = $('operatorFilter'), previous = select.value;
  // Facet against the other controls, never against its own selected operator.
  const matching = selectRecords(state.records, { ...filters(), operator: '' }).filter(matchesMedia);
  const values = [...new Set(matching.map(record => normalizeOperator(record.operator)))].sort((a,b) => a.localeCompare(b));
  const wanted = ['', ...values];
  if (wanted.length !== select.options.length || wanted.some((value,index) => select.options[index]?.value !== value)) {
    select.replaceChildren(new Option('All operators', ''), ...values.map(value => new Option(value, value)));
  }
  select.value = values.includes(previous) ? previous : '';
}
function renderCategories() {
  const container = $('categoryFilters'); container.replaceChildren();
  [{ id: '', label: 'All facilities', symbol: 'ALL' }, ...state.catalog.categories.filter(type => type.id !== 'robotics_facility')].forEach(type => {
    const count = state.records.filter(record => (!type.id || record.type === type.id) && (!$('approvedOnly').checked || record.verification.status === 'ai_reviewed')).length;
    const button = create('button', 'category'); button.type = 'button';
    button.setAttribute('aria-pressed', String(state.type === type.id));
    button.setAttribute('aria-label', `${type.label}, ${count} ${count === 1 ? 'record' : 'records'}`);
    const top = create('span', 'category-top');
    top.append(create('span', 'category-symbol', type.symbol), create('span', 'category-count', formatNumber(count)));
    button.append(top, create('span', 'category-label', type.label));
    button.addEventListener('click', () => {
      state.type = type.id;
      // Keep the focused category button mounted for keyboard users.
      [...container.children].forEach(child => child.setAttribute('aria-pressed', String(child === button)));
      renderResults();
    });
    container.append(button);
  });
}
function thumbnailPath(photo) {
  const item = state.photoThumbnails?.schema_version === 1 && state.photoThumbnails.photos?.[photo.path];
  return item?.source_photo_sha256 === photo.sha256 && /^img\/reports\/thumb-[a-f0-9]{16}\.jpg$/.test(item.path) ? item.path : photo.path;
}
function card(record) {
  const type = state.catalog.categories.find(item => item.id === record.type);
  const status = statusPresentation(record);
  const incidentState = incidentPresentation(record), operationState = operationPresentation(record, status);
  const article = create('article', `${record.verification.status === 'ai_reviewed' || boldMode() ? 'card' : 'card unapproved'} status-card status-${operationState.tone}`);
  article.dataset.incidentStatus = incidentState.visualKey || incidentState.key;
  const brand = warehouseBrand(record);
  if (brand) {
    article.dataset.warehouseBrand = brand.key;
    article.style.setProperty('--warehouse-brand-color', brand.color);
  }
  const visual = create('div', 'card-visual');
  const fallback = create('span', 'visual-fallback', type.symbol); fallback.setAttribute('aria-hidden', 'true'); visual.append(fallback);
  const orderedMedia = orderedFacilityMedia(state.reports,state.reportMedia,record.id,thumbnailPath);
  const sourcedItem = orderedMedia.find(item=>item.thumbnail);
  const sourcedPreview = sourcedItem?.thumbnail || null;
  const mediaStatus = sourcedItem?.media_verification === 'verified' || sourcedItem?.media_verification === 'proven' ? 'Verified' : 'Unverified';
  const imagePath = sourcedPreview || record.image;
  if (imagePath && preferences.showBanners) {
    const image = create('img'); image.src = imagePath; image.alt = sourcedPreview ? `${mediaStatus} source media preview for ${record.name}` : ''; image.loading = 'lazy';
    image.addEventListener('error', () => {
      image.remove();
      // Legacy photo totals must not count a file that failed to load.
      if (!orderedMedia.length && record.image) {
        record.image = null;
        article.querySelector('.media-count')?.remove();
      }
    }, { once: true }); visual.append(image);
  }
  const overlay = create('div', 'visual-label');
  const operatorLabel = displayValue(record.operator).replace(/\s*\(3data distributor listing\)/i, '');
  const operatorBadge = create('span', 'operator-tag', operatorLabel);
  if (brand?.logo) {
    const logo = create('img', 'operator-logo');
    logo.src = brand.logo; logo.alt = brand.label;
    logo.width = brand.key === 'wildberries' ? 100 : 74; logo.height = 16;
    operatorBadge.textContent = ''; operatorBadge.classList.add('has-logo');
    operatorBadge.title = brand.label;
    logo.addEventListener('error', () => {
      operatorBadge.textContent = operatorLabel;
      operatorBadge.classList.remove('has-logo');
    }, { once: true });
    operatorBadge.append(logo);
  }
  overlay.append(create('span', 'type-tag', type.singular), operatorBadge, favoriteButton(record));
  const photoCount = orderedMedia.filter(item => item.kind === 'image').length || (record.image && !orderedMedia.length ? 1 : 0);
  const videoCount = orderedMedia.filter(item => item.kind === 'video' || item.kind === 'telegram_video').length;
  const topBadges = create('div', 'card-top-badges');
  if (photoCount || videoCount) {
    const counts = create('span', 'image-label media-count', `📷 ${photoCount} · 🎥 ${videoCount}`);
    counts.setAttribute('aria-label', `${photoCount} photos, ${videoCount} videos`);
    counts.title = `${photoCount} photos · ${videoCount} videos, including linked source videos`;
    topBadges.append(counts);
  }
  const location = displayLocation(record, { town: approximateTown(record, state.locationTownIndex || new Map())?.label, regions: state.locationRegions });
  const place = create('span', 'location-tag', location.label);
  if (location.flagPath) {
    place.textContent = location.placeLabel;
    const flag = create('img', 'region-flag'); flag.src = location.flagPath;
    flag.alt = `${location.flagName} flag`; flag.width = 18; flag.height = 12;
    place.append(flag);
  }
  place.title = location.description; place.setAttribute('aria-label', location.description);
  topBadges.append(place); visual.append(topBadges);
  visual.append(overlay);
  const body = create('div', 'card-body');
  const nameParts = facilityCardName(record);
  const title = create('h3', '', nameParts.title);
  const incidentText = record.hasIncident ? '📅' : record.incidentReview === 'not_reviewed' ? 'History: ?' : 'No incident recorded';
  const incidentBadge = create('span', `incident-badge${record.hasIncident ? '' : ' no-record'}`, incidentText);
  if (record.hasIncident) { const time = create('time', '', dateLabel(record.lastIncident)); if (record.lastIncident) time.dateTime = record.lastIncident; incidentBadge.append(time); incidentBadge.setAttribute('aria-label', `Latest incident: ${dateLabel(record.lastIncident)}`); }
  const heading = create('div', 'card-heading');
  const leftHeading = create('div', 'card-heading-left');
  leftHeading.append(title);
  nameParts.subtitles.forEach(text => leftHeading.append(create('h4', 'facility-name-subtitle', text)));
  const incidentPill = create('span', `incident-state status-pill status-${incidentState.tone}`, `◎ ${incidentState.label}`); incidentPill.title = `Incident status: ${incidentState.basis}`; incidentPill.setAttribute('aria-label', `Incident status: ${incidentState.label}`);
  const statusPill = create('span', `status-pill status-${operationState.tone}`, `⚙ ${operationState.label}`); statusPill.title = operationState.basis;
  statusPill.setAttribute('aria-label', operationState.asOf ? `${operationState.label}, as of ${dateLabel(operationState.asOf)}` : operationState.label);
  leftHeading.append(incidentPill);
  const operationSummary = create('div', 'operation-summary');
  if (operationState.asOf) operationSummary.append(create('span', 'status-date', `As of ${dateLabel(operationState.asOf)}`));
  operationSummary.append(statusPill);
  heading.append(leftHeading, operationSummary);
  body.append(heading);
  const statusLine = create('div', 'status-line');
  const latest = latestFacilityUpdate(record, state.reports.filter(report => !$('approvedOnly').checked || boldMode() || report.approval_status === 'approved'));
  if (latest) {
    const update = create('div', `status-claim latest-update${latest.reopening ? ' reopening-claim' : ''}${latest.kind === 'incident' ? ' incident-update' : ''}`);
    const flag = latest.origin ? explicitOriginFlag(latest.origin) : null;
    update.append(create('strong', '', `${flag ? `${flag} ` : ''}${latest.title}`));
    update.append(create('span', 'status-date', `${latest.kind === 'source' ? 'Posted ' : ''}${dateLabel(latest.date)}`));
    if (latest.summary) {
      const summary = create('p', 'latest-update-summary', latest.summary);
      summary.title = latest.summary;
      update.append(summary);
    }
    if (safeLink(latest.source?.url)) update.append(link(`${latest.source.name || 'Source'} ↗`, latest.source.url));
    else {
      const sources = create('button', 'text-button latest-update-sources', 'View sources & updates ↗');
      sources.type = 'button';
      sources.addEventListener('click', event => { event.stopPropagation(); openRecord(record); });
      update.append(sources);
    }
    statusLine.append(update);
  }
  const infoRow = create('div', 'card-info-row'); infoRow.append(statusLine); body.append(infoRow);
  const bottom = create('div', 'card-bottom');
  if(!boldMode())bottom.append(create('span', `review-label${record.verification.status === 'ai_reviewed' ? '' : ' needs-review'}`, `${record.sources.length} ${record.sources.length === 1 ? 'source' : 'sources'}${record.verification.status === 'ai_reviewed' ? '' : ` · ${reviewLabels[record.verification.status]}`}`));
  const button = create('button', 'detail-button'); button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-label', `View record: ${record.name}`); button.addEventListener('click', () => openRecord(record));
  const activity = create('div', 'card-activity'); activity.append(incidentBadge, bottom); body.append(activity); article.append(visual, body, button);
  return article;
}
function renderResults(keepPage = false) {
  $('incidentsOnly').checked = $('incidentFilter').value === 'reported';
  if (!state.catalog) return;
  refreshOperatorOptions();
  if (keepPage !== true) { state.limit = autoLoader ? 24 : Infinity; state.reportLimit = autoLoader ? 6 : Infinity; }
  const selected = selectRecords(state.records, filters()).filter(matchesMedia);
  $('tabFavorites').textContent=`Favorites (${favorites.size})`;
  if(preferences.rememberFilters){try{localStorage.setItem('bingo.lastFilters.v1',JSON.stringify(filters()));}catch{}}
  $('resultCount').textContent = `${formatNumber(selected.length)} of ${formatNumber(state.records.length)} facilities${$('approvedOnly').checked ? ' · approved only' : ''}${selected.length > state.limit ? ` · showing ${state.limit}` : ''}`;
  const grid = $('facilitiesGrid'); grid.replaceChildren(...selected.slice(0,state.limit).map(card)); grid.classList.toggle('compact', state.compact);
  let legend = $('statusLegend');
  if (!legend) {
    legend = create('div', 'status-legend'); legend.id = 'statusLegend'; legend.setAttribute('role', 'group'); legend.setAttribute('aria-label', 'Left border: incident status. Right border: operating status.'); legend.title='Left: incident history · Right: operating status (green running/resumed, muted sage reopening claimed, amber damaged/disrupted, red stopped/closed, grey unknown)';
    [['never_attacked','No attack recorded / ?'],['reported_event','Fire / explosion reported'],['targeted','Targeted'],['attacked','Attacked'],['multiple_attacks','Multiple attacks'],['destroyed','Destroyed']].forEach(([key,label])=>{const item=create('span','status-legend-item',label);item.dataset.incidentStatus=key;legend.append(item);});
    grid.before(legend);
  }
  legend.hidden = !['facilities','favorites'].includes(view);
  $('loadMore').hidden = selected.length <= state.limit;
  $('emptyState').hidden = selected.length !== 0;
  const currentType = state.catalog.categories.find(type => type.id === state.type);
  const categoryEmpty = currentType && !state.records.some(record => record.type === state.type);
  $('emptyTitle').textContent = categoryEmpty ? `${currentType.label}: records not added yet` : 'No matching facilities';
  $('emptyMessage').textContent = categoryEmpty ? 'This category is ready. Records will appear as sources are checked and additions pass review.' : state.records.length ? 'Try another search, operator or region, or clear your filters.' : 'The collection is empty. Add a reviewed dataset to begin.';
  if (!selected.length && selectReports(state.reports, state.records, filters()).length) { $('emptyTitle').textContent = 'No matching facility profiles'; $('emptyMessage').replaceChildren(document.createTextNode('Matching reports are available in the Incidents tab. '));const browse=create('button','button','View matching incidents');browse.type='button';browse.addEventListener('click',()=>switchView('incidents'));$('emptyMessage').append(browse); }
  const filtered = state.type || $('approvedOnly').checked || ['searchInput','operatorFilter','regionFilter','incidentFilter',...Object.values(advanced)].some(id => $(id).value);
  $('resetButton').hidden = !filtered;
  renderReports();
  const reports=selectedReports();
  if(view==='overview'){
    $('mapLegend').replaceChildren(create('span','','● Purple: facility records'),create('span','','● Amber: incident reports'));
    $('overviewReportMetrics').replaceChildren(metric('Incident groups',formatNumber(reports.length)),metric(boldMode()?'Reported groups':'Approved incidents',formatNumber(boldMode()?reports.length:reports.filter(r=>r.approval_status==='approved').length)),metric('Favorites',formatNumber(favorites.size)));
    const latest=[...reports].sort((a,b)=>(b.event_date||b.updates[0].posted_at).localeCompare(a.event_date||a.updates[0].posted_at));
    $('overviewIncidentList').replaceChildren(...latest.slice(0,5).map(reportRow));
    const all=create('button','button','Browse all incidents →');all.type='button';all.addEventListener('click',()=>switchView('incidents'));$('overviewIncidentList').append(all);
    renderOverviewMap($('overviewMap'),selected,reports,state.mapLocations,preferences,openRecord,report=>{openDialog(report.facility_name,'INCIDENT REPORT');const row=reportRow(report);$('dialogContent').append(row);row.open=true;});
  }
  const cardsVisible=view==='facilities'||view==='favorites';
  $('facilitiesGrid').hidden=!cardsVisible;$('emptyState').hidden=!cardsVisible||selected.length!==0;$('loadMore').hidden=!cardsVisible||selected.length<=state.limit;
  $('reportSection').hidden=view!=='incidents';$('compactButton').hidden=!cardsVisible;
  refreshAutoLoad();
  if(view==='favorites'&&!selected.length){$('emptyTitle').textContent=favorites.size?'No matching favorites':'No favorites yet';$('emptyMessage').textContent='Use the star on any facility card to save it here across categories.';}
}
function reportRow(report) {
  const row = create('details', 'report-row');
  const summary = create('summary', 'report-summary');
  const media = reportMedia(report, state.reportMedia, thumbnailPath);
  const preview = mediaPreview(media);
  if (preview) {
    const thumbnail = create('img', 'report-thumbnail'); thumbnail.src = preview; thumbnail.alt = `${boldMode() ? 'Source photo' : 'Unverified source photo'} for ${report.facility_name}`; thumbnail.loading = 'lazy';
    thumbnail.addEventListener('error', () => thumbnail.remove(), {once:true}); summary.append(thumbnail);
  }
  summary.append(create('strong', '', report.facility_name), create('span', 'report-location', report.location), create('span', 'report-date', report.event_date ? `Event: ${dateLabel(report.event_date)}` : `Posts from ${dateLabel(report.updates[0].posted_at.slice(0, 10))}`), create('span', `report-label${(boldMode() || report.approval_status === 'approved') ? ' approved' : ''}`, boldMode() ? 'Approved hit' : report.approval_status === 'approved' ? 'Approved incident' : 'Unapproved'));
  if(!boldMode())summary.append(create('span', 'report-media', mediaLabel(report)));
  if (report.updates.some(update => update.kind === 'correction')) summary.append(create('span', 'report-label', 'Correction noted'));
  row.append(summary, create('p', 'report-claim', report.canonical_event?.description || report.approval?.approved_summary || report.summary));
  if (report.source_reports?.length) row.append(create('p', 'report-source', `🔗 ${report.source_reports.length} reports · ${report.updates.length} source posts`));
  if (report.approval) {
    const proof = create('p', 'report-source');
    proof.append('Checked sources: ');
    report.approval.evidence_urls.forEach((url, index) => { if (index) proof.append(' · '); proof.append(link(new URL(url).hostname + ' ↗', url)); });
    row.append(proof);
  }
  const timeline = create('ol', 'report-timeline');
  [...report.updates].sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at) || a.post_id - b.post_id).forEach(update => {
    const item = create('li', 'event');
    const kind = update.kind[0].toUpperCase() + update.kind.slice(1);
    item.append(create('strong', '', `${kind} · ${displayTimestamp(update.posted_at)}`), create('p', '', update.summary));
    const source = create('p', 'report-source'); source.append(link(`Source post ${update.post_id} ↗`, update.source_url));
    if (update.media_kind !== 'none') source.append(create('span', '', ` · ${update.media_kind === 'mixed' ? 'Mixed media' : update.media_kind === 'photo' ? 'Photo' : 'Video'}${update.media_available ? '' : ' · preview unavailable'}`));
    if (update.duplicate_post_ids.length) {
      source.append(create('span', '', ' · Also posted: '));
      update.duplicate_post_ids.forEach((postId, index) => {
        if (index) source.append(create('span', '', ', '));
        source.append(link(String(postId), `https://t.me/supernova_plus/${postId}`));
        const duplicate = update.duplicate_posts?.find(item => item.post_id === postId);
        if (duplicate) source.append(create('span', '', ` (${displayTimestamp(duplicate.posted_at)})`));
      });
    }
    item.append(source);
    if (update.source_attribution) item.append(create('p', 'report-attribution', `Source attribution: ${update.source_attribution}`));
    if (update.citations?.length) {
      const citations = create('ul', 'report-citations');
      update.citations.forEach(citation => {
        const citationItem = create('li');
        citationItem.append(link(citation.name, citation.url), create('span', '', ` · ${citationLabel(citation)}`));
        citations.append(citationItem);
      });
      item.append(citations);
    }
    timeline.append(item);
  });
  const timelineDetails = create('details', 'report-updates');
  const corrections = report.updates.filter(update => update.kind === 'correction').length;
  timelineDetails.open=preferences.showSourceDetails;
  timelineDetails.append(create('summary', '', `${report.updates.length} dated source posts${corrections ? ` · ${corrections} corrections` : ''}`), timeline);
  row.append(timelineDetails);
  if (media.length) {
    let gallery;
    row.addEventListener('toggle', () => {
      if (!row.open) { gallery?.dispatchEvent(new Event('gallery-pause')); return; }
      if (gallery) return;
      gallery = createMediaGallery(media, report.facility_name);
      row.insertBefore(gallery, timelineDetails);
    });
  }
  return row;
}
function renderReports() {
  const container = $('reportSection');
  container.hidden = false;
  if (container.hidden) return;
  const reports = selectedReports();
  $('reportCount').textContent = state.reportError || `Incident groups · ${formatNumber(reports.length)} · ${formatNumber(reports.reduce((sum, report) => sum + (report.source_reports?.length || 1), 0))} reports`;
  $('reportList').replaceChildren(...reports.slice(0, state.reportLimit).map(reportRow));
  $('reportSentinel').hidden = reports.length <= state.reportLimit;
  if (!reports.length && !state.reportError) $('reportList').append(create('p', 'report-empty', 'No matching reports.'));
}
function resetFilters(render=true) {
  state.type = ''; ['searchInput','operatorFilter','regionFilter','incidentFilter',...Object.values(advanced)].forEach(id => $(id).value = '');
  $('approvedOnly').checked = false;
  if(render){renderCategories();renderResults();}
}

function section(title) {
  const element = create('section', 'dialog-section'); element.append(create('h3', '', title)); return element;
}
function openDialog(title, eyebrow) {
  $('detailDialog').className = '';
  delete $('detailDialog').dataset.incidentStatus;
  $('dialogContent').replaceChildren(create('h2', 'dialog-title', title));
  $('dialogContent').firstElementChild.id = 'dialogTitle'; $('dialogEyebrow').textContent = eyebrow;
  $('detailDialog').showModal();
}
function openRecord(record) {
  const type = state.catalog.categories.find(item => item.id === record.type);
  const status = statusPresentation(record);
  const nameParts = facilityCardName(record);
  const incidentState = incidentPresentation(record), operationState = operationPresentation(record, status);
  openDialog(nameParts.title, `${type.singular.toUpperCase()} / ${record.id}`);
  const dialog = $('detailDialog'); dialog.className = `facility-detail status-${operationState.tone}`;
  dialog.dataset.incidentStatus = incidentState.visualKey || incidentState.key;
  const content = $('dialogContent');
  const hero = create('header', 'detail-hero');
  const title = content.firstElementChild;
  const titleRow = create('div', 'detail-title-row'); titleRow.append(title, favoriteButton(record));
  hero.append(titleRow);
  nameParts.subtitles.forEach(text => hero.append(create('p', 'detail-name-subtitle', text)));
  const badges = create('div', 'detail-identity');
  badges.append(create('span', 'detail-chip', type.singular), create('span', 'detail-chip', displayValue(record.operator)));
  const place = displayLocation(record, { town: approximateTown(record, state.locationTownIndex || new Map())?.label, regions: state.locationRegions });
  const location = create('span', 'detail-chip detail-location', place.placeLabel || place.label);
  if (place.flagPath) { const flag = create('img', 'region-flag'); flag.src = place.flagPath; flag.alt = `${place.flagName} flag`; flag.width = 18; flag.height = 12; location.append(flag); }
  location.title = place.description; badges.append(location); hero.append(badges);
  const states = create('div', 'detail-states');
  const incidentBox = create('div', 'detail-state incident-summary');
  incidentBox.append(create('span', 'small-label', 'INCIDENT HISTORY'), create('span', `status-pill detail-incident status-${incidentState.tone}`, `◎ ${incidentState.label}`));
  const operationBox = create('div', 'detail-state operation-summary');
  operationBox.append(create('span', 'small-label', operationState.asOf ? `AS OF ${dateLabel(operationState.asOf)}` : 'OPERATION'), create('span', `status-pill status-${operationState.tone}`, `⚙ ${operationState.label}`));
  states.append(incidentBox, operationBox); hero.append(states);
  if (record.footprint != null) hero.append(create('p', 'detail-area', `▧ ${formatNumber(record.footprint)} m² · footprint`));
  content.append(hero);
  const facilityMedia = orderedFacilityMedia(state.reports,state.reportMedia,record.id,thumbnailPath);
  if (facilityMedia.length) { const media = create('section', 'detail-media'); media.append(createMediaGallery(facilityMedia, record.name)); content.append(media); }
  if (record.verification.status !== 'ai_reviewed' && !boldMode()) content.append(create('p', 'report-label', 'Unapproved · Needs review'));
  if (record.summary) content.append(create('p', 'detail-summary', record.summary));
  if (record.statusClaims?.length) {
    const claims = section('Operating-status claims');
    claims.classList.add('detail-claims');
    for (const claim of record.statusClaims) {
      const flag = explicitOriginFlag(claim.origin);
      const text = create('p', '', `${flag ? `${flag} ` : ''}${claim.status === 'reopened' || claim.status === 'partially_reopened' ? 'Reopening claimed' : `${claim.status.replaceAll('_',' ')} claimed`}${claim.asOf ? ` · ${dateLabel(claim.asOf)}` : ''}`);
      text.classList.add('detail-claim');
      if (claim.status === 'reopened' || claim.status === 'partially_reopened') text.classList.add('reopening-claim');
      if (claim.summary) text.append(create('span', '', ` ${claim.summary}`));
      if (claim.source?.url) { text.append(' '); text.append(link(`${claim.source.name || 'Source'} ↗`, claim.source.url)); }
      claims.append(text);
    }
    content.append(claims);
  }
  const history = section('Recorded incident history');
  history.classList.add('detail-history');
  if (!record.incidents.length) history.append(create('p','',record.incidentReview === 'not_reviewed' ? 'Incident history has not yet been reviewed for this facility.' : 'No incidents are recorded in this dataset.'));
  const reports = groupIncidentReports(state.reports.filter(report => report.facility_id === record.id && (!$('approvedOnly').checked || report.approval_status === 'approved')));
  const linked = new Set();
  [...record.incidents].sort((a,b)=>(b.date||'').localeCompare(a.date||'')).forEach(event => {
    const report = reports.find(report => report.approval_status === 'approved' && report.approval?.incident_id === event.id);
    if (report) { linked.add(report.id); history.append(reportRow({...report, canonical_event: event})); }
    else { const row=create('div','event');row.append(create('strong','',dateLabel(event.date)),create('p','',event.description));history.append(row); }
  });
  content.append(history);
  const unmatched = reports.filter(report => !linked.has(report.id));
  if (unmatched.length) {
    const reportSection = section(`Reports awaiting incident matching (${unmatched.length})`);
    reportSection.append(...unmatched.map(reportRow)); content.append(reportSection);
  }
  const sources=section(`Source references (${record.sources.length})`),list=create('ol','source-list');
  record.sources.forEach(source=>{const item=create('li');item.append(link(source.name,source.url));if(source.supports.length)item.append(create('p','',`Supports: ${source.supports.join(', ')}.`));if(source.accessMethod)item.append(create('p','',`Access: ${source.accessMethod.replaceAll('_',' ')}${source.accessedAt ? ` · checked ${dateLabel(source.accessedAt)}` : ''}.`));list.append(item);});
  if(record.sources.length)sources.append(list);else sources.append(create('p','','No source references supplied.'));
  const evidence = create('details', 'detail-evidence');
  evidence.append(create('summary', '', `Sources & review notes · ${record.sources.length} references`));
  evidence.append(sources);
  const provenance = section('Evidence & provenance');
  provenance.append(create('p','',`Collection: ${record.datasetLabel}.`));
  if (record.legacy) provenance.append(create('p','',`Inherited confidence: ${record.inheritedConfidence}. This is the original dataset’s assessment, not verification by this project.`));
  if (record.inheritedDamage != null) provenance.append(create('p','',`Inherited damage assessment: ${DAMAGE_LABELS[record.inheritedDamage] || 'Unknown'}. Historical claim; it does not establish the facility’s current condition.`));
  if (record.verification.reviewedOn) provenance.append(create('p','',`Source/review check: ${dateLabel(record.verification.reviewedOn)}. Reviewer: ${record.verification.reviewedBy}. Review is limited to the cited assertions, not a guarantee of accuracy or current operation.`));
  if (record.provenanceNote) provenance.append(create('p','',record.provenanceNote));
  if (record.legacy) provenance.append(create('p','', 'Original imagery is inherited and has not been independently authenticated.'));

  evidence.append(provenance); content.append(evidence);
  content.append(create('p', 'detail-disclaimer', 'AI-reviewed source reporting, not independent verification. Coverage may be incomplete; unknown details remain ?. Media and attributed claims retain their own labels.'));
}
function openAbout() {
  openDialog('Know what the data can tell you.', 'DATA & SOURCES');
  const content=$('dialogContent');content.append(create('p','dialog-subtitle','Coverage, provenance and review are part of every record.'));
  const scope=section('Coverage & update process');scope.append(create('p','','Initial coverage follows the original collection. Planned regional phases are Ukraine, NATO countries, then worldwide. This is a growing collection, not a complete inventory.'));
  const scheduled = state.updateStatus?.schedule?.status === 'ACTIVE';
  scope.append(create('p','',scheduled ? 'Four-hourly Codex checks are configured on the local Mac, which must remain available. Candidates and changes pass an AI review gate before entering the approved database.' : 'Automatic update status is not available. Candidates and changes must pass an AI review gate before entering the approved database.'));
  if(state.updateStatus?.last_success_at)scope.append(create('p','',`Last completed batch: ${displayTimestamp(state.updateStatus.last_success_at)}. ${state.updateStatus.schedule?.first_unattended_run_verified ? 'An unattended run has completed.' : 'The initial batch was run manually; the first unattended run is not yet verified.'}`));
  scope.append(create('p','','“AI reviewed” means an AI assessed the cited assertions. It is not independent ground truth. Reopening requires explicit dated evidence; silence or an old operating page is not proof.'));
  content.append(scope);
  if (state.trustPolicy?.schema_version === 1 && Array.isArray(state.trustPolicy.sources)) {
    const trusted = section('Trusted sources & approval');
    trusted.append(create('p','',state.trustPolicy.summary));
    const list = create('ul','source-list');
    state.trustPolicy.sources.forEach(source => { if (!safeLink(source.url)) return; const item=create('li',''); item.append(link(source.name,source.url),create('p','',source.use)); list.append(item); });
    trusted.append(list); content.append(trusted);
  }
  if(!state.catalog){content.append(create('p','provenance-note','The data catalog is not currently available.'));return;}
  if(state.failures.length){const notice=create('div','provenance-note',`Unavailable collections: ${state.failures.map(item=>item.label).join(', ')}. `);const retry=create('button','button','Try again');retry.type='button';retry.addEventListener('click',()=>{$('detailDialog').close();load();});notice.append(retry);content.append(notice);}
  state.catalog.datasets.forEach(dataset=>{const box=create('section','dataset-block');box.append(create('h3','',dataset.label),create('p','',dataset.notes||''),create('p','',dataset.license_note||''));if(dataset.source_url)box.append(link('Original collection ↗',dataset.source_url));box.append(create('p','',`${state.records.filter(record=>record.datasetId===dataset.id).length} loaded records${dataset.imported_on ? ` · imported ${dataset.imported_on}`:''}.`));content.append(box);});
  const meaning=section('Reading the labels');meaning.append(create('p','','Needs review: inherited or incomplete evidence. Identity sourced: official sources establish basic identity only. AI reviewed: a proposal passed the recorded AI review. No incident recorded does not mean no incident occurred. “Not established” is the default operating status until dated evidence supports a change.'));content.append(meaning);
}
async function load() {
  if(state.loading)return;state.loading=true;$('loadingState').hidden=false;$('errorState').hidden=true;$('emptyState').hidden=true;$('facilitiesGrid').replaceChildren();$('facilitiesGrid').setAttribute('aria-busy','true');$('resultCount').textContent='Loading facilities…';
  filterControls.forEach(id=>$(id).disabled=true);$('compactButton').disabled=true;$('reportSection').hidden=true;
  try{
    const [collection, updateStatus, reports, trustPolicy, photoThumbnails, reportMediaManifest, statusClaimOverlay] = await Promise.all([loadCollection(), fetch('data/update-status.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).catch(()=>null), loadReports(), fetch('data/trusted-sources.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).catch(()=>null), fetch('data/photo-thumbnails.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).catch(()=>null), fetch('data/report-media.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).catch(()=>null), fetch('data/status-claims.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).catch(()=>null)]);Object.assign(state,collection);applyStatusClaims(state.records,statusClaimOverlay);state.updateStatus=updateStatus;state.reports=reports.incidents;state.reportError=reports.error;state.trustPolicy=trustPolicy;state.photoThumbnails=photoThumbnails;state.reportMedia=reportMediaManifest;
    $('updateBadge').textContent=updateStatus?.schedule?.status==='ACTIVE'?'Four-hour checks configured · Local Mac':'Curated collection · Not a live feed';
    state.mapLocations=await fetch('data/map-locations.json').then(r=>r.ok?r.json():null).catch(()=>null);
    state.locationTownIndex = townIndex(state.mapLocations); state.locationRegions = locationRegions(state.records);
    const categoryNames={warehouse:'Warehouses & fulfilment',logistics_hub:'Logistics & transport',bridge:'Bridges',refinery:'Oil refineries',oil_well:'Oil wells',data_center:'Data centers',military_facility:'Military facilities',defence_manufacturing:'Defence production',government_building:'Government buildings',drone_facility:'Drone facilities',robotics_facility:'Robotics facilities',industrial_facility:'Industrial production'};state.catalog.categories.forEach(c=>{c.label=categoryNames[c.id]||c.label;});
    const sources=new Set(state.records.flatMap(r=>r.sources.map(s=>s.url)).concat(state.reports.flatMap(r=>r.updates.flatMap(u=>[u.source_url,...(u.citations||[]).map(c=>c.url)]))).filter(safeLink).map(url=>new URL(url).hostname.replace(/^www\./,'')));
    const oldSource=$('sourceFilter').value;$('sourceFilter').replaceChildren(new Option('All sources',''),...[...sources].sort().map(host=>new Option(host,host)));$('sourceFilter').value=oldSource;
    fillSelect('operatorFilter','operator','All operators');fillSelect('regionFilter','region','All regions');renderCategories();
    $('totalCount').textContent=formatNumber(state.records.length);$('typeCount').textContent=String(new Set(state.records.map(record=>record.type)).size);$('incidentCount').textContent=formatNumber(state.records.filter(record=>record.hasIncident).length);$('sourceCount').textContent=formatNumber(state.records.reduce((total,record)=>total+record.sources.length,0));
    const inherited=state.records.filter(record=>record.legacy).length;
    const approved=state.records.filter(record=>record.verification.status==='ai_reviewed').length;
    const unapproved=state.records.length-approved;
    $('dataNotice').querySelector('p').textContent=state.failures.length ? `Partial collection: ${state.failures.map(item=>item.label).join(', ')} could not load. Available records are shown; use Try again in Data & sources after resolving the missing dataset.` : `${approved} approved facilities · ${unapproved} pending. Incident reports are checked separately.`;
    $('dataNotice').classList.toggle('warning',!!state.failures.length);if(!state.preferencesRestored){state.preferencesRestored=true;if(preferences.rememberFilters){try{restoreFilters(JSON.parse(localStorage.getItem('bingo.lastFilters.v1'))||{});}catch{}}}renderResults();
  }catch(error){$('overviewIncidentList').replaceChildren(create('p','panel-note',error.message));const retry=create('button','button','Try again');retry.addEventListener('click',load);$('overviewIncidentList').append(retry);$('mapCoverage').textContent='Geographic coverage unavailable';state.catalog=null;state.records=[];$('categoryFilters').replaceChildren();$('errorState').hidden=false;$('errorMessage').textContent=error.message;$('resultCount').textContent='Data unavailable';$('dataNotice').querySelector('p').textContent='Serve this site over HTTP and check the data files. Previously displayed totals are unavailable.';['totalCount','typeCount','incidentCount','sourceCount'].forEach(id=>$(id).textContent='—');}
  finally{state.loading=false;$('loadingState').hidden=true;$('facilitiesGrid').setAttribute('aria-busy','false');filterControls.forEach(id=>$(id).disabled=!state.catalog);$('compactButton').disabled=!state.catalog;}
}
$('searchInput').addEventListener('input',renderResults);filterControls.slice(1).filter(id=>id!=='approvedOnly' && id!=='incidentsOnly').forEach(id=>$(id).addEventListener('change',renderResults));
$('incidentsOnly').addEventListener('change',()=>{ $('incidentFilter').value=$('incidentsOnly').checked?'reported':''; renderResults(); });
$('approvedOnly').addEventListener('change',()=>{renderCategories();renderResults();});
$('compactButton').addEventListener('click',()=>{state.compact=!state.compact;preferences.density=state.compact?'compact':'comfortable';savePreferences(preferences);document.documentElement.dataset.density=preferences.density;$('compactButton').setAttribute('aria-pressed',String(state.compact));$('compactButton').textContent=state.compact?'Expanded view':'Compact view';renderResults();});
$('resetButton').addEventListener('click',resetFilters);$('emptyReset').addEventListener('click',resetFilters);$('retryButton').addEventListener('click',load);$('aboutButton').addEventListener('click',openAbout);$('closeDialog').addEventListener('click',()=>$('detailDialog').close());
// Load near the end of either list, preserving existing cards, open reports and media.
const autoLoader = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
  let appended = false;
  for (const entry of entries) {
    if (!entry.isIntersecting || entry.target.hidden || !state.catalog || state.loading) continue;
    if (entry.target.id === 'loadMore' && ['facilities','favorites'].includes(view)) {
      const selected = selectRecords(state.records, filters()).filter(matchesMedia);
      $('facilitiesGrid').append(...selected.slice(state.limit, state.limit + 24).map(card));
      state.limit += 24; appended = true;
      $('loadMore').hidden = selected.length <= state.limit;
      $('resultCount').textContent = `${formatNumber(selected.length)} of ${formatNumber(state.records.length)} facilities${$('approvedOnly').checked ? ' · approved only' : ''}${selected.length > state.limit ? ` · showing ${state.limit}` : ''}`;
    } else if (entry.target.id === 'reportSentinel' && view === 'incidents' && $('reportSection').open) {
      const reports = selectedReports();
      $('reportList').append(...reports.slice(state.reportLimit, state.reportLimit + 20).map(reportRow));
      state.reportLimit += 20; appended = true;
      $('reportSentinel').hidden = reports.length <= state.reportLimit;
    }
  }
  if (appended) refreshAutoLoad();
}, { rootMargin: '0px 0px 600px 0px' }) : null;
function refreshAutoLoad() {
  if (!autoLoader) return;
  autoLoader.disconnect();
  if (['facilities','favorites'].includes(view) && !$('loadMore').hidden) autoLoader.observe($('loadMore'));
  if (view === 'incidents' && $('reportSection').open && !$('reportSentinel').hidden) autoLoader.observe($('reportSentinel'));
}
$('reportSection').addEventListener('toggle',refreshAutoLoad);
initializeWorkspace();
load();

$('detailDialog').addEventListener('close', () => $('detailDialog').querySelectorAll('.media-gallery').forEach(gallery => gallery.dispatchEvent(new Event('gallery-pause'))));

function restoreFilters(value) {
  resetFilters(false);state.type=typeof value.type==='string'?value.type:'';
  const mapping={query:'searchInput',operator:'operatorFilter',region:'regionFilter',incident:'incidentFilter',sort:'sortSelect',...advanced};
  for(const [key,id] of Object.entries(mapping))if(typeof value[key]==='string')$(id).value=key==='operator'&&value[key]?normalizeOperator(value[key]):value[key];
  $('approvedOnly').checked=value.approvedOnly===true;renderCategories();
}
function renderPresets(){const select=$('filterPresetSelect');select.replaceChildren(new Option('Choose a preset',''),...presets.map(p=>new Option(p.name,p.id)));}
function applyPreferences(){
  for(const key of ['density','fontSize','contrast'])document.documentElement.dataset[key]=preferences[key];
  document.body.classList.toggle('reduce-motion',preferences.reduceMotion);state.compact=preferences.density==='compact';
  for(const [key,value] of Object.entries(preferences)){const control=$('setting'+key[0].toUpperCase()+key.slice(1));if(control){if(control.type==='checkbox')control.checked=value;else if(key==='evidenceMode')control.value=value==='bold'?'1':'0';else control.value=String(value);if(key==='evidenceMode')control.setAttribute('aria-valuetext',value==='bold'?'Bold':'Cautious');}}
  clearInterval(refreshTimer);if(preferences.autoRefresh)refreshTimer=setInterval(()=>{if(!document.hidden)load();},preferences.autoRefresh*60000);
  $('compactButton').setAttribute('aria-pressed',String(state.compact));$('compactButton').textContent=state.compact?'Expanded view':'Compact view';renderResults(true);
}
function initializeWorkspace(){
  document.querySelectorAll('#workspaceTabs [data-view]').forEach(button=>{button.addEventListener('click',()=>switchView(button.dataset.view));button.addEventListener('keydown',event=>{const tabs=[...document.querySelectorAll('#workspaceTabs [data-view]')],i=tabs.indexOf(button);const next=event.key==='ArrowRight'?tabs[(i+1)%tabs.length]:event.key==='ArrowLeft'?tabs[(i+tabs.length-1)%tabs.length]:event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):null;if(next){event.preventDefault();next.focus();switchView(next.dataset.view);}});});
  for(const key of Object.keys(preferences)){const control=$('setting'+key[0].toUpperCase()+key.slice(1));if(control)control.addEventListener('change',()=>{preferences[key]=control.type==='checkbox'?control.checked:key==='autoRefresh'?Number(control.value):key==='evidenceMode'?(control.value==='1'?'bold':'cautious'):control.value;const saved=savePreferences(preferences);$('settingsMessage').textContent=saved?'Settings saved in this browser.':'Storage unavailable; settings last for this session.';if(!preferences.rememberFilters){try{localStorage.removeItem('bingo.lastFilters.v1');}catch{}}applyPreferences();});}
  $('clearAdvanced').addEventListener('click',()=>{Object.values(advanced).forEach(id=>$(id).value='');renderResults();});
  $('saveFilterPreset').addEventListener('click',()=>{const name=$('savedFilterName').value.trim();if(!name)return;presets.push({id:crypto.randomUUID(),name,filters:filters()});savePresets(presets);renderPresets();$('savedFilterName').value='';});
  $('filterPresetSelect').addEventListener('change',()=>{const preset=presets.find(p=>p.id===$('filterPresetSelect').value);if(preset){restoreFilters(preset.filters);renderResults();}});
  $('deleteFilterPreset').addEventListener('click',()=>{presets=presets.filter(p=>p.id!==$('filterPresetSelect').value);savePresets(presets);renderPresets();});
  $('resetSettings').addEventListener('click',()=>{Object.assign(preferences,DEFAULT_PREFERENCES);savePreferences(preferences);applyPreferences();$('settingsMessage').textContent='Settings reset. Favorites kept.';});
  $('exportPreferences').addEventListener('click',()=>{const blob=new Blob([JSON.stringify({schema_version:1,preferences,favorites:[...favorites],presets},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=create('a');a.href=url;a.download='bingo-preferences.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  $('importPreferences').addEventListener('change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>1000000)throw Error('Preference file is too large.');const imported=JSON.parse(await file.text());if(imported.schema_version!==1)throw Error('Unsupported preference format.');Object.assign(preferences,cleanPreferences(imported.preferences));const memory={getItem:key=>key.includes('favorites')?JSON.stringify(imported.favorites):JSON.stringify(imported.presets)};favorites=loadFavorites(memory);presets=loadPresets(memory);const saved=[savePreferences(preferences),saveFavorites(favorites),savePresets(presets)].every(Boolean);renderPresets();applyPreferences();$('settingsMessage').textContent=saved?'Preferences imported.':'Imported for this session; browser storage unavailable.';}catch(error){$('settingsMessage').textContent=error.message;}event.target.value='';});
  renderPresets();applyPreferences();switchView(view);
}

// Distance-based threshold works consistently for wheel, touch and keyboard scrolling.
const backToTop = $('backToTop');
let topArrowFrame = null;
function updateTopArrow() {
  backToTop.hidden = window.scrollY < window.innerHeight * 3;
  topArrowFrame = null;
}
window.addEventListener('scroll', () => {
  if (topArrowFrame === null) topArrowFrame = requestAnimationFrame(updateTopArrow);
}, { passive: true });
window.addEventListener('resize', updateTopArrow);
backToTop.addEventListener('click', () => {
  const reduced = preferences.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' });
  document.querySelector('.brand')?.focus({ preventScroll: true });
});
updateTopArrow();
