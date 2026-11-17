// Card projection only. Event dates, source-post dates and claim dates stay distinct.
export function latestFacilityUpdate(record, reports = []) {
  const entries = [];
  for (const incident of record.incidents || []) {
    if (incident.date) entries.push({kind:'incident', date:incident.date, title:'Latest incident', summary:incident.description, priority:1});
  }
  if (record.statusAsOf && record.operationalStatus !== 'unknown') {
    const labels = {operating:'Online',reopened:'Operation resumed',partially_reopened:'Partial operation resumed',temporarily_closed:'Operation stopped',permanently_closed:'Permanently closed',disrupted:'Operation affected',damaged:'Damage reported'};
    entries.push({kind:'operation',date:record.statusAsOf,title:'Operating update',summary:labels[record.operationalStatus] || 'Operating update',priority:2});
  }
  for (const claim of record.statusClaims || (record.statusClaim ? [record.statusClaim] : [])) {
    if (!claim.asOf) continue;
    const reopening = ['reopened','partially_reopened'].includes(claim.status);
    entries.push({kind:'claim',date:claim.asOf,title:reopening?'Reopening claimed':`${claim.status.replaceAll('_',' ')} claimed`,summary:claim.summary,source:claim.source,origin:claim.origin,reopening,priority:4});
  }
  for (const report of reports) {
    if (report.facility_id !== record.id) continue;
    for (const update of report.updates || []) {
      if (!update.posted_at) continue;
      entries.push({kind:'source',date:update.posted_at,title:update.kind==='correction'?'Source correction':'Source update',summary:update.summary || report.summary,source:{name:'Source post',url:update.source_url},priority:3});
    }
  }
  // Day-level claims/events cannot establish an intraday order. Prefer an explicitly
  // dated claim on ties; source timestamps order posts within the same day.
  entries.sort((a,b)=>b.date.slice(0,10).localeCompare(a.date.slice(0,10)) || b.priority-a.priority || b.date.localeCompare(a.date));
  return entries[0] || null;
}
