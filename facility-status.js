import { isCurrentStatusClaimOnly, statusPresentation } from './status.js';
// Display summaries only: incident history and operating condition are independent.
// Never count a restart/halt update as another attack, or a fire alone as an attack.
function attackEvent(event) {
  const text = event.description || '';
  if (/\b(?:HALT|RESTART|RESUM|RECOVER|PROCESSING)\b/i.test((event.id || '').replaceAll('-', ' '))) return false;
  if (/\b(?:resumed|restarted|reopened|halted|stopped)\b/i.test(text.split(/[.;]/)[0])) return false;
  if (/refinery-specific.*not.*confirmed|not an attack|no attack|no connection.*attack|nearby|near the refinery/i.test(text)) return false;
  return /\b(?:struck|attacked|hit)\b|\b(?:drone|missile|UAV) (?:attack|strike)\b/i.test(text);
}
export function incidentPresentation(record) {
  if (record.inheritedDamage === 5) return {key:'destroyed', label:'Destroyed', tone:'closed', basis:'Original listing: historical destruction assessment; not a current operating-status claim.'};
  const dates = new Set((record.incidents || []).filter(attackEvent).map(event => event.date).filter(Boolean));
  if (dates.size > 1) return {key:'multiple_attacks',label:'Multiple attacks',tone:'incident',basis:'Attack reports on multiple event dates; operational updates are excluded.'};
  if (dates.size === 1) return {key:'attacked',label:'Attacked',tone:'incident',basis:'A dated attack is explicitly described in the recorded history.'};
  if (record.inheritedDamage === 1) return {key:'targeted',label:'Targeted',tone:'restricted',basis:'Targeting assessment inherited from the original listing.'};
  if (!record.hasIncident) return {key:'never_attacked',label:'No attack recorded',tone:'unknown',basis:'No attack recorded in this collection; this is not a claim of complete history or operation.'};
  const descriptions = (record.incidents || []).map(event => event.description || '').join(' ');
  if (/\b(fire|blaze)\b/i.test(descriptions) && !/\b(no fire|fire did not|false fire report)\b/i.test(descriptions)) {
    const major = /\b(major|large|massive|extensive)\s+(?:warehouse\s+)?(?:fire|blaze)\b/i.test(descriptions);
    return {key:'unknown',visualKey:'reported_event',label:major ? 'Major fire reported' : 'Fire reported',tone:'incident',
      basis:'The recorded source describes a fire. This does not establish an attack, total destruction or present operating condition.'};
  }
  if (/\bexplosion\b/i.test(descriptions) && !/\b(no explosion|explosion did not|false explosion report)\b/i.test(descriptions)) {
    return {key:'unknown',visualKey:'reported_event',label:'Explosion reported',tone:'incident',
      basis:'The recorded source describes an explosion. Cause, damage extent and operating condition remain separate.'};
  }
  return {key:'unknown',label:'?',tone:'unknown',basis:'Incident recorded, but attack classification is not established.'};
}
export function operationPresentation(record, status) {
  const destroyed = incidentPresentation(record).key === 'destroyed';
  const historyDate = record.lastIncident || (record.incidents || []).map(event => event.date).filter(Boolean).sort().at(-1);
  const claim = status.claim;
  const latestKnownDate = [record.statusAsOf, historyDate].filter(Boolean).sort().at(-1);
  if (claim?.unverified && ['reopened','partially_reopened'].includes(claim.status) && claim.asOf && (!latestKnownDate || claim.asOf >= latestKnownDate)) {
    return {...status,key:'operator_claim',tone:'claimed-reopened',label:'Reopening claimed',asOf:claim.asOf,
      basis:'Source-attributed reopening claim; the supported operating record remains unchanged.'};
  }
  const laterOperation = !isCurrentStatusClaimOnly(record) &&
    ['operating','reopened','partially_reopened'].includes(record.operationalStatus) &&
    record.statusAsOf && (!historyDate || record.statusAsOf >= historyDate);
  if (destroyed && !laterOperation && record.operationalStatus !== 'permanently_closed') {
    return {...status,key:'stopped',tone:'closed',label:'Offline',asOf:historyDate || null,
      basis:'Derived from the recorded destroyed classification; no later supported resumption supersedes it. This does not mean permanent closure.'};
  }
  if (isCurrentStatusClaimOnly(record)) return {...status,key:'operator_claim',label:'Claimed',basis:status.label};
  const values = {
    damaged: ['damaged','Affected'], disrupted: ['disrupted','Affected'],
    temporarily_closed: ['stopped','Offline'], permanently_closed: ['permanently_closed','Closed'],
    reopened: ['resumed','Online'], partially_reopened: ['resumed','Affected'],
    operating: ['operating','Online']
  };
  const value = values[record.operationalStatus];
  return value ? {...status,key:value[0],label:value[1],...(value[1] === 'Affected' ? {tone:'restricted'} : {}),basis:status.label}
    : {...status,key:'unknown',tone:'unknown',label:'?',basis:'Operating condition is not established; attack history does not determine it.'};
}
export function incidentStatusMatches(record, filter) {
  return !filter || incidentPresentation(record).key === filter;
}
export function operationStatusMatches(record, filter) {
  if (!filter) return true;
  if (filter === 'unaffected_history') return ['never_attacked','targeted'].includes(incidentPresentation(record).key);
  if (['online','offline','affected','closed'].includes(filter)) return operationPresentation(record, statusPresentation(record)).label.toLowerCase() === filter;
  if (filter === 'partial') return !isCurrentStatusClaimOnly(record) && record.operationalStatus === 'partially_reopened';
  const values = {damaged:['damaged'],stopped:['temporarily_closed'],resumed:['reopened','partially_reopened']};
  if (values[filter]) return operationPresentation(record, statusPresentation(record)).key === filter;
  if (filter === 'unknown' && incidentPresentation(record).key === 'destroyed') return false;
  return null; // Existing claim/unknown/status filtering remains authoritative.
}
