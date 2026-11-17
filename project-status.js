/* Read-only view: all imported text uses textContent, never HTML interpolation. */
const byId = id => document.getElementById(id);
const labels = { verified: 'Verified', in_progress: 'In progress', pending: 'Pending', later: 'Later' };
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function plainList(id, items) {
  const target = byId(id);
  target.replaceChildren(...items.map(item => element('li', '', item)));
}
function statusList(id, items) {
  byId(id).replaceChildren(...items.map(item => {
    const state = Object.hasOwn(labels, item.status) ? item.status : 'pending';
    const node = element('li', state);
    const title = element('div', 'item-title');
    title.append(element('span', '', item.title), element('span', `badge ${state}`, labels[state]));
    node.append(title, element('p', 'item-detail', item.detail));
    return node;
  }));
}
function prettyDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unavailable' : date.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function render(data) {
  byId('source-progress').textContent = data.reuse?.message || 'No reviewed dataset pilot snapshot available.';
  const app = data.application;
  byId('application-summary').textContent = app?.available ? `${app.imported_incidents} new incident/update entries imported across ${app.changed_facilities} facilities; ${app.new_facilities} new approved facilities; ${app.status_changes} operating-status changes. ${app.pending_incident_ids} proposed incident IDs still await application.` : 'Application comparison unavailable.';
  byId('reviewer-summary').textContent = app?.available ? `${app.approved_before} → ${app.approved_now} approved facilities. Queue: ${app.ready_versions} candidate snapshots for ${app.proposed_facilities} facility IDs; versions are not distinct incidents. Reviewer: ${app.reviewer}.` : '';
  const prepared = app?.prepared_backlog;
  if (prepared) byId('reviewer-summary').textContent += ` Prepared backlog: ${prepared.completed_groups}/${prepared.total_groups} facility groups finished; ${prepared.remaining_groups} remaining, ${prepared.dispositions.held || 0} held.`;
  const scout = app?.scout_checkpoint;
  byId('scout-checkpoint').textContent = scout ? `Scout checkpoint: ${prettyDate(scout.saved_at)}. ${scout.at_snapshot_end ? 'Reached the end of the saved report list; unresolved cases remain recorded.' : `Next report: ${scout.next_report_id || 'not recorded'}.`} Last checked: ${(scout.last_checked_ids || []).join(', ') || 'not recorded'}.` : 'Scout checkpoint unavailable.';
  byId('quota-summary').textContent = app?.quota?.remaining_percent != null ? `Last account reading: ${app.quota.remaining_percent}% remaining (${prettyDate(app.quota.observed_at)}). Stop: ${app.stop_remaining_percent}% remaining.` : `Stop: ${app?.stop_remaining_percent ?? 'unavailable'}% remaining; no current usage reading saved.`;
  const project = data.project;
  const metrics = data.metrics;
  for (const key of ['goal', 'summary', 'phase']) byId(key).textContent = project[key];
  statusList('milestones', project.milestones);
  statusList('checks', project.checks);
  plainList('next-steps', project.next_steps);
  plainList('decisions', project.decisions);
  plainList('blockers', project.blockers);
  const cards = [
    [metrics.facilities, 'Facility records in the app', `${metrics.ai_reviewed} AI-reviewed · ${metrics.unreviewed} need review (${metrics.discovery_unreviewed ?? 0} discovery entries)`],
    [metrics.categories_registered, 'Registered categories', `${metrics.categories_populated} currently populated`],
    [metrics.operators, 'Represented operators', 'Counted from catalogue datasets'],
    [metrics.ai_reviewed, 'AI-reviewed identities', `${metrics.legacy_reviewed ?? 0}/${metrics.legacy_total ?? 38} original entries reviewed · operating status may be unknown`],
  ];
  byId('metrics').replaceChildren(...cards.map(([value, label, note]) => {
    const node = element('div', 'metric');
    node.append(element('strong', 'metric-value', value), element('span', 'metric-label', label), element('span', 'metric-note', note));
    return node;
  }));
  const counts = [[metrics.candidate_files, 'Candidate files'], [metrics.review_files, 'Review files'], [metrics.archived_candidate_files, 'Archived candidates']];
  if (data.pipeline.available) {
    const db = data.pipeline.counts;
    counts.push([db.proposals, 'DB proposals'], [db.reviews, 'DB reviews'], [db.pending_proposals, 'Pending proposals'], [db.publications, 'Publication versions'], [db.approved_facilities, 'Published identities']);
  }
  if (data.source_checks) counts.push([data.source_checks.pending_lead_count, 'Source leads pending'], [data.source_checks.sources.filter(source => source.status === 'success').length + '/' + data.source_checks.sources.length, 'Readable source listings']);
  byId('review-counts').replaceChildren(...counts.map(([count, label]) => {
    const node = element('div', 'review-stat');
    node.append(element('strong', '', count), element('span', '', label));
    return node;
  }));
  byId('database-status').textContent = data.pipeline.available
    ? 'Local SQLite snapshot read in read-only mode. Held reviews remain in the audit history.' : data.pipeline.message;
  byId('coverage-targets').replaceChildren(...metrics.category_counts.map(item => { const row = element('tr'); row.append(element('th', '', item.label), element('td', '', item.count), element('td', '', item.reviewed ?? 'Not recorded'), element('td', '', item.awaiting_review ?? 'Not recorded')); return row; }));
  const missing = metrics.missing_counts;
  byId('missing-summary').textContent = missing ? `Missing information: operator ${missing.operator} · location/region ${missing.region} · footprint ${missing.footprint} · current operating condition ${missing.current_status}.` : 'Missing-data measurements unavailable.';
  const maximum = Math.max(1, ...metrics.category_counts.map(item => item.count));
  byId('categories').replaceChildren(...metrics.category_counts.map(item => {
    const node = element('li');
    const bar = element('div', 'bar');
    const fill = element('span');
    fill.style.width = `${Math.max(0, Math.min(100, item.count / maximum * 100))}%`;
    bar.append(fill);
    node.append(element('span', '', item.label), bar, element('strong', '', item.count));
    return node;
  }));
  byId('git-state').textContent = data.git.state;
  const details = [['Branch', data.git.branch || 'Unavailable'], ['Changed files', data.git.changed_files ?? 'Unavailable']];
  for (const remote of data.git.remotes || []) details.push([remote.name, remote.url]);
  details.push(['Delivery', data.git.delivery || 'Unavailable']);
  byId('git-details').replaceChildren(...details.flatMap(([label, value]) => [element('dt', '', label), element('dd', '', value)]));
  const automation = data.automation;
  byId('automation-status').textContent = automation.message + (automation.available
    ? ` Reported status: ${automation.status}. Last run: ${automation.last_run_at ? prettyDate(automation.last_run_at) : 'unavailable'}. ${automation.batch_summary || ''}` : '');
  byId('snapshot-date').textContent = `Snapshot generated ${prettyDate(data.generated_at)}`;
  byId('dashboard').hidden = false;
}
let loading = false;
async function refresh() {
  if (loading) return;
  loading = true;
  byId('refresh').disabled = true;
  const status = byId('load-status');
  status.classList.remove('error');
  status.textContent = 'Loading saved snapshot…';
  try {
    const response = await fetch('project-status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Snapshot request failed');
    const data = await response.json();
    if (data.schema_version !== 1) throw new Error('Unsupported snapshot version');
    render(data);
    const age = Date.now() - new Date(data.generated_at).valueOf();
    status.textContent = `Snapshot: ${prettyDate(data.generated_at)}. ` + (age > 6 * 60 * 60 * 1000 ? 'Over six hours old; regenerate locally to update measurements.' : 'Saved measurements reload every 30 seconds.');
  } catch {
    status.classList.add('error');
    status.textContent = 'Could not load the project snapshot. Serve this folder over HTTP and run python3 scripts/update-project-status.py. Any visible data is from the last successful load.';
  } finally {
    byId('refresh').disabled = false;
    loading = false;
  }
}
byId('refresh').addEventListener('click', refresh);
refresh();

// Reload saved measurements only; this never runs research or changes data.
setInterval(refresh, 30000);
