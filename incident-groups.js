// Only group links that have passed loadReports' exact-version approval checks.
// Dates alone are deliberately not a grouping key. Original objects stay immutable.
export function groupIncidentReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    const linked = report.approval_status === 'approved' && report.approval?.incident_id && report.facility_id;
    const key = linked ? JSON.stringify([report.facility_id, report.approval.incident_id]) : `report:${report.id}`;
    const members = groups.get(key) || [];
    members.push(report); groups.set(key, members);
  }
  return [...groups.values()].map(members => {
    const first = members[0];
    if (members.length === 1) return first;
    const updates = members.flatMap(report => report.updates).sort((a,b) => Date.parse(a.posted_at)-Date.parse(b.posted_at) || a.post_id-b.post_id);
    const kinds = new Set(updates.map(update => update.media_kind).filter(kind => kind !== 'none'));
    const media_status = !kinds.size ? 'text_only' : kinds.size > 1 || kinds.has('mixed') ? 'mixed_media_unverified' : kinds.has('photo') ? 'photo_backed_unverified' : 'video_backed_unverified';
    return {...first, updates, media_status, source_reports: members,
      approval: {...first.approval, evidence_urls: [...new Set(members.flatMap(report => report.approval.evidence_urls))]}};
  });
}
