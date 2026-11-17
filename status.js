const STATUS_PRESENTATION = {
  unknown: { tone: 'unknown', label: 'Operating status unknown' },
  operating: { tone: 'operating', label: 'Reported operating' },
  disrupted: { tone: 'restricted', label: 'Disruption reported · current operation unknown' },
  temporarily_closed: { tone: 'closed', label: 'Reported temporarily closed' },
  partially_reopened: { tone: 'restricted', label: 'Reported partially reopened' },
  reopened: { tone: 'operating', label: 'Reported reopened' },
  permanently_closed: { tone: 'closed', label: 'Reported permanently closed' }
};

export function statusPresentation(record) {
  const baseStatus = STATUS_PRESENTATION[record.operationalStatus] || STATUS_PRESENTATION.unknown;
  const currentClaimOnly = isCurrentStatusClaimOnly(record);
  const status = currentClaimOnly
    ? { tone: 'unverified', label: 'Operation claimed · not confirmed' }
    : record.operationalStatus === 'unknown' && record.hasIncident
    ? { tone: 'incident', label: 'Incident reported · operation unknown' }
    : baseStatus;
  return {
    ...status,
    asOf: status.tone !== 'unknown' ? record.statusAsOf || null : null,
    asOfLabel: currentClaimOnly ? 'Claim as of' : record.statusAsOf ? 'Status as of' : 'Status date',
    claim: record.statusClaim?.unverified && record.statusClaim.status ? record.statusClaim : null
  };
}

export function isCurrentStatusClaimOnly(record) {
  return Boolean(record.statusClaim?.canonicalStatusIsClaim &&
    record.statusAsOf &&
    record.statusClaim.status === record.operationalStatus &&
    record.statusClaim.asOf === record.statusAsOf);
}

export function hasUnconfirmedOperatingStatus(record) {
  return record.operationalStatus === 'unknown' || isCurrentStatusClaimOnly(record);
}

export function statusFilterMatches(record, statusFilter) {
  if (!statusFilter) return true;
  const claimOnly = isCurrentStatusClaimOnly(record);
  if (statusFilter === 'operator_claim') return claimOnly;
  if (statusFilter === 'unknown') return hasUnconfirmedOperatingStatus(record);
  return !claimOnly && record.operationalStatus === statusFilter;
}

export function explicitOriginFlag(origin) {
  const codes = { russia: 'RU', ukraine: 'UA', united_states: 'US', belarus: 'BY' };
  const code = codes[typeof origin === 'string' ? origin.toLowerCase() : ''] || origin;
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
  const codePoints = [...code].map(character => 0x1f1e6 + character.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

export function applyStatusClaims(records, overlay) {
  if (overlay?.schema_version !== 1 || !Array.isArray(overlay.claims)) return records;
  const byId = new Map(records.map(record => [record.id, record]));
  const statuses = new Set(Object.keys(STATUS_PRESENTATION));
  for (const raw of overlay.claims) {
    if (raw?.verified !== false || !statuses.has(raw.status) || typeof raw.facility_id !== 'string') continue;
    const record = byId.get(raw.facility_id);
    if (!record) continue;
    const claim = {
      status: raw.status,
      origin: typeof raw.origin === 'string' ? raw.origin : null,
      asOf: /^\d{4}-\d{2}-\d{2}$/.test(raw.as_of || '') ? raw.as_of : null,
      source: raw.source && typeof raw.source === 'object' ? { name: String(raw.source.name || 'Source report'), url: raw.source.url || null } : null,
      summary: typeof raw.summary === 'string' ? raw.summary : null,
      canonicalStatusIsClaim: raw.canonical_status_is_claim === true && !!record.statusAsOf &&
        raw.status === record.operationalStatus && raw.as_of === record.statusAsOf,
      unverified: true
    };
    (record.statusClaims ||= []).push(claim);
  }
  for (const record of records) {
    if (record.statusClaims?.length) {
      record.statusClaims.sort((a, b) => (b.asOf || '').localeCompare(a.asOf || ''));
      record.statusClaim = record.statusClaims.find(claim => claim.canonicalStatusIsClaim) || record.statusClaims[0];
    }
  }
  return records;
}
