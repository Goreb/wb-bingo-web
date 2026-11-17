"""Small SQLite review gate. Review artifacts are trusted inputs, not AI execution."""
import hashlib
import json
import math
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

TYPES = {'warehouse', 'logistics_hub', 'bridge', 'refinery', 'oil_well', 'data_center',
         'military_facility', 'defence_manufacturing', 'government_building',
         'drone_facility', 'robotics_facility', 'industrial_facility'}
STATUSES = {'unknown', 'operating', 'disrupted', 'temporarily_closed',
            'partially_reopened', 'reopened', 'permanently_closed'}
FIELDS = {'id', 'name', 'facility_type', 'operator', 'region', 'country',
          'footprint_m2', 'incidents', 'operational_status', 'status_as_of'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def shape(value, required, optional=()):
    require(isinstance(value, dict), 'Expected JSON object')
    require(set(required) <= value.keys() and value.keys() <= set(required) | set(optional),
            'Missing or unknown fields: ' + ', '.join(sorted((set(required) - value.keys()) | (value.keys() - set(required) - set(optional)))))


def text(value):
    return isinstance(value, str) and bool(value.strip())


def day(value):
    require(isinstance(value, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)), 'Expected ISO date')
    date.fromisoformat(value)
    require(value <= date.today().isoformat(), 'Future event/publication date')
    return value


def instant(value):
    require(isinstance(value, str), 'Expected timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'Timestamp requires timezone')
    require(parsed <= datetime.now(timezone.utc), 'Future observation/review timestamp')
    return parsed


def validate_candidate(candidate):
    shape(candidate, {'schema_version', 'base_version', 'facility', 'evidence', 'assertions'})
    require(type(candidate['schema_version']) is int and candidate['schema_version'] == 1, 'Unsupported schema')
    require(type(candidate['base_version']) is int and candidate['base_version'] >= 0, 'Invalid base version')
    facility = candidate['facility']
    shape(facility, FIELDS)
    require(text(facility['id']) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', facility['id'])), 'Invalid stable facility ID')
    for field in ('name', 'operator', 'region', 'country'):
        require(text(facility[field]), 'Missing ' + field)
    require(isinstance(facility['facility_type'], str) and facility['facility_type'] in TYPES, 'Unknown facility type')
    require(isinstance(facility['operational_status'], str) and facility['operational_status'] in STATUSES, 'Unknown operational status')
    area = facility['footprint_m2']
    require(area is None or (type(area) in (int, float) and math.isfinite(area) and area > 0), 'Invalid footprint')
    if facility['operational_status'] == 'unknown':
        require(facility['status_as_of'] is None, 'Unknown status has no effective date')
    else:
        day(facility['status_as_of'])
    require(isinstance(facility['incidents'], list), 'incidents must be an array')
    incident_ids = set()
    for incident in facility['incidents']:
        shape(incident, {'id', 'date', 'description'})
        require(text(incident['id']) and incident['id'] not in incident_ids, 'Invalid/duplicate incident ID')
        incident_ids.add(incident['id'])
        day(incident['date'])
        require(text(incident['description']), 'Missing incident description')
    require(isinstance(candidate['evidence'], list) and candidate['evidence'], 'Evidence required')
    evidence = {}
    for item in candidate['evidence']:
        shape(item, {'id', 'url', 'name', 'observed_at', 'published_on', 'excerpt'}, {'access_method', 'excerpt_kind'})
        for key, allowed in (('access_method', {'full_page', 'search_index', 'document'}),
                             ('excerpt_kind', {'paraphrase', 'quote'})):
            if key in item:
                require(isinstance(item[key], str) and item[key] in allowed, 'Invalid evidence ' + key)
        require(text(item['id']) and item['id'] not in evidence, 'Invalid/duplicate evidence ID')
        require(text(item['url']), 'Missing evidence URL')
        url = urlsplit(item['url'])
        require(url.scheme in {'http', 'https'} and bool(url.hostname) and not url.username and not url.password, 'Unsafe evidence URL')
        require(text(item['name']) and text(item['excerpt']), 'Evidence name and excerpt required')
        observed = instant(item['observed_at'])
        if item['published_on'] is not None:
            day(item['published_on'])
            require(item['published_on'] <= observed.date().isoformat(), 'Publication after observation')
        evidence[item['id']] = item
    require(isinstance(candidate['assertions'], list) and candidate['assertions'], 'Assertions required')
    for assertion in candidate['assertions']:
        shape(assertion, {'field', 'value', 'evidence_ids'}, {'effective_on'})
        require(isinstance(assertion['field'], str) and assertion['field'] in FIELDS - {'id', 'status_as_of'}, 'Invalid assertion field')
        require(isinstance(assertion['evidence_ids'], list) and assertion['evidence_ids'], 'Assertion evidence required')
        require(all(isinstance(i, str) and i in evidence for i in assertion['evidence_ids']), 'Unknown assertion evidence')
        if assertion['field'] == 'operational_status':
            require(assertion.get('effective_on') is not None, 'Status assertion requires effective_on')
            day(assertion['effective_on'])
        elif 'effective_on' in assertion:
            day(assertion['effective_on'])
    canonical(candidate)


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS proposals (
            id TEXT PRIMARY KEY, facility_id TEXT NOT NULL, base_version INTEGER NOT NULL,
            candidate TEXT NOT NULL, staged_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY, artifact_hash TEXT UNIQUE NOT NULL,
            proposal_id TEXT NOT NULL REFERENCES proposals(id), artifact TEXT NOT NULL,
            effective_decision TEXT NOT NULL, reasons TEXT NOT NULL, imported_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS publications (
            facility_id TEXT NOT NULL, version INTEGER NOT NULL, proposal_id TEXT NOT NULL UNIQUE,
            review_id INTEGER NOT NULL REFERENCES reviews(id), published_at TEXT NOT NULL,
            PRIMARY KEY(facility_id, version));
          CREATE TABLE IF NOT EXISTS proposal_corrections (
            proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), correction TEXT NOT NULL,
            recorded_at TEXT NOT NULL);
          CREATE TRIGGER IF NOT EXISTS immutable_proposals_update BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_proposals_delete BEFORE DELETE ON proposals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_reviews_update BEFORE UPDATE ON reviews BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_reviews_delete BEFORE DELETE ON reviews BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_publications_update BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_publications_delete BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_proposal_corrections_update BEFORE UPDATE ON proposal_corrections BEGIN SELECT RAISE(ABORT, 'append-only'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_proposal_corrections_delete BEFORE DELETE ON proposal_corrections BEGIN SELECT RAISE(ABORT, 'append-only'); END;
        ''')

    def close(self):
        self.db.close()

    def stage(self, candidate):
        validate_candidate(candidate)
        proposal_id = digest(candidate)
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO proposals VALUES (?, ?, ?, ?, ?)',
                            (proposal_id, candidate['facility']['id'], candidate['base_version'], canonical(candidate), now()))
        return {'proposal_id': proposal_id, 'candidate_hash': proposal_id, 'base_version': candidate['base_version']}

    def correction_reasons(self, candidate, correction, previous):
        """Validate a narrowly scoped, same-ID/same-date description correction."""
        reasons = []
        try:
            shape(correction, {'incident_id', 'previous_incident', 'previous_incident_hash',
                               'replacement_incident', 'reason', 'source_evidence_ids'})
            require(text(correction['incident_id']) and text(correction['reason']), 'Correction ID and reason are required')
            for key in ('previous_incident', 'replacement_incident'):
                incident = correction[key]
                shape(incident, {'id', 'date', 'description'})
                require(text(incident['id']) and text(incident['description']), 'Correction incident fields are required')
                day(incident['date'])
            old_incident = correction['previous_incident']
            replacement = correction['replacement_incident']
            require(correction['incident_id'] == old_incident['id'] == replacement['id'], 'Correction must retain the exact incident ID')
            require(old_incident['date'] == replacement['date'], 'Correction cannot change the incident date')
            require(old_incident['description'] != replacement['description'], 'Correction must change only the description')
            require(correction['previous_incident_hash'] == digest(old_incident), 'Previous incident hash does not match the supplied exact object')
            require(isinstance(correction['source_evidence_ids'], list) and correction['source_evidence_ids'] and
                    all(text(i) for i in correction['source_evidence_ids']), 'Correction requires source evidence IDs')
            require(previous is not None, 'A correction requires an existing published version')
            current_candidate = json.loads(previous['candidate'])
            current = current_candidate['facility']
            require(candidate['facility']['id'] == current['id'], 'Correction facility does not match current publication')
            require(candidate['base_version'] == previous['version'], 'Correction must use the exact current base version')
            old_matches = [i for i in current['incidents'] if i['id'] == correction['incident_id']]
            require(len(old_matches) == 1 and old_matches[0] == old_incident, 'Supplied previous incident is not the exact current incident')
            expected = json.loads(canonical(current))
            index = next(i for i, item in enumerate(expected['incidents']) if item['id'] == correction['incident_id'])
            expected['incidents'][index] = replacement
            require(candidate['facility'] == expected, 'Correction candidate changes fields or incidents beyond the one described correction')
            evidence_ids = {item['id'] for item in candidate['evidence']}
            require(set(correction['source_evidence_ids']) <= evidence_ids, 'Correction references missing source evidence')
            incident_assertions = [a for a in candidate['assertions'] if a['field'] == 'incidents']
            require(len(incident_assertions) == 1 and incident_assertions[0]['value'] == candidate['facility']['incidents'],
                    'Correction requires one exact full incident-list assertion')
            require(set(correction['source_evidence_ids']) <= set(incident_assertions[0]['evidence_ids']),
                    'Correction evidence must support the incident-list assertion')
        except (ValueError, TypeError, KeyError, StopIteration) as error:
            reasons.append(str(error))
        return reasons

    def stage_correction(self, candidate, correction):
        """Stage an explicitly authorized correction; ordinary stage remains append-only."""
        validate_candidate(candidate)
        previous = self.current(candidate['facility']['id'])
        reasons = self.correction_reasons(candidate, correction, previous)
        require(not reasons, 'Invalid historical correction: ' + '; '.join(reasons))
        staged = self.stage(candidate)
        serialized = canonical(correction)
        with self.db:
            existing = self.db.execute('SELECT correction FROM proposal_corrections WHERE proposal_id=?',
                                       (staged['proposal_id'],)).fetchone()
            require(existing is None or existing['correction'] == serialized,
                    'This candidate hash is already staged with different correction metadata')
            self.db.execute('INSERT OR IGNORE INTO proposal_corrections VALUES (?, ?, ?)',
                            (staged['proposal_id'], serialized, now()))
        return staged

    def pending(self):
        rows = self.db.execute("""SELECT p.id AS proposal_id, p.facility_id, p.base_version,
          p.staged_at, r.effective_decision AS latest_decision, r.reasons
          FROM proposals p LEFT JOIN reviews r ON r.id=(
            SELECT MAX(r2.id) FROM reviews r2 WHERE r2.proposal_id=p.id)
          WHERE (r.id IS NULL OR r.effective_decision='needs_review')
            AND NOT EXISTS (SELECT 1 FROM publications pub WHERE pub.proposal_id=p.id)
            AND p.base_version >= COALESCE((SELECT MAX(pub.version) FROM publications pub WHERE pub.facility_id=p.facility_id), 0)
          ORDER BY p.staged_at, p.id""").fetchall()
        return [{**dict(row), 'reasons': json.loads(row['reasons']) if row['reasons'] else []} for row in rows]

    def status(self):
        counts = {table: self.db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                  for table in ('proposals', 'reviews', 'publications')}
        counts['approved_facilities'] = self.db.execute('SELECT COUNT(DISTINCT facility_id) FROM publications').fetchone()[0]
        counts['pending_proposals'] = len(self.pending())
        latest = self.db.execute('SELECT * FROM publications ORDER BY published_at DESC, review_id DESC LIMIT 1').fetchone()
        return {'counts': counts, 'latest_publication': dict(latest) if latest else None}

    def inspect(self, proposal_id):
        row = self.db.execute('SELECT * FROM proposals WHERE id=?', (proposal_id,)).fetchone()
        require(row is not None, 'Unknown proposal')
        latest = self.db.execute('SELECT * FROM reviews WHERE proposal_id=? ORDER BY id DESC LIMIT 1', (proposal_id,)).fetchone()
        previous = self.current(row['facility_id'])
        correction = self.db.execute('SELECT correction FROM proposal_corrections WHERE proposal_id=?', (row['id'],)).fetchone()
        return {'proposal_id': row['id'], 'candidate_hash': row['id'], 'base_version': row['base_version'],
                'candidate': json.loads(row['candidate']), 'staged_at': row['staged_at'],
                'historical_correction': json.loads(correction['correction']) if correction else None,
                'current_version': previous['version'] if previous else 0,
                'latest_review': {'review_id': latest['id'], 'decision': latest['effective_decision'],
                                  'reasons': json.loads(latest['reasons']), 'artifact': json.loads(latest['artifact'])} if latest else None}

    def current(self, facility_id):
        return self.db.execute('''SELECT p.*, c.candidate FROM publications p JOIN proposals c ON c.id=p.proposal_id
          WHERE p.facility_id=? ORDER BY version DESC LIMIT 1''', (facility_id,)).fetchone()

    def holds(self, candidate, previous, correction=None):
        facility = candidate['facility']
        old = json.loads(previous['candidate'])['facility'] if previous else {}
        reasons = []
        if candidate['base_version'] != (previous['version'] if previous else 0):
            reasons.append('Stale base version; rebase and obtain a new review')
        for field in FIELDS - {'id', 'status_as_of'}:
            assertions = [a for a in candidate['assertions'] if a['field'] == field]
            if len({canonical(a['value']) for a in assertions}) > 1:
                reasons.append('Conflicting evidence for ' + field)
            if any(a['value'] != facility[field] for a in assertions):
                reasons.append('Assertion disagrees with candidate: ' + field)
            # Null/empty unknowns are not positive factual claims.
            changed = field not in old or old[field] != facility[field]
            if (facility[field] not in (None, [], 'unknown') or (changed and field in old and old[field] not in (None, [], 'unknown'))) and not assertions:
                reasons.append('Missing field-level evidence: ' + field)
        old_incidents = {i['id']: i for i in old.get('incidents', [])}
        new_incidents = {i['id']: i for i in facility['incidents']}
        changed_history = any(new_incidents.get(i) != value for i, value in old_incidents.items())
        if changed_history:
            correction_reasons = self.correction_reasons(candidate, correction, previous) if correction else []
            if not correction or correction_reasons:
                reasons.append('Historical incident removal/correction requires a valid dedicated correction workflow')
                reasons.extend(correction_reasons)
        old_date = old.get('status_as_of')
        status_date = facility['status_as_of']
        changed_status = any(old.get(k) != facility[k] for k in ('operational_status', 'status_as_of'))
        if old_date and (not status_date or status_date < old_date):
            reasons.append('Operational status would regress to older or unknown information')
        if changed_status and status_date:
            assertions = [a for a in candidate['assertions'] if a['field'] == 'operational_status']
            if not assertions or any(a.get('effective_on') != status_date for a in assertions):
                reasons.append('Status effective date must match its assertion')
            if old_date and status_date <= old_date:
                reasons.append('Changed status requires evidence newer than previous status')
            if facility['operational_status'] in {'partially_reopened', 'reopened'}:
                evidence = {e['id']: e for e in candidate['evidence']}
                dated = [evidence[i]['published_on'] for a in assertions for i in a['evidence_ids']]
                if not dated or any(not d or d < status_date or (old_date and d <= old_date) for d in dated):
                    reasons.append('Reopening requires dated published evidence newer than previous status')
        return reasons

    def review(self, artifact):
        shape(artifact, {'proposal_id', 'candidate_hash', 'base_version', 'reviewer', 'model',
                         'reviewed_at', 'decision', 'rationale', 'evidence_ids', 'conflicts'},
              {'correction_hash'})
        require(all(text(artifact[k]) for k in ('proposal_id', 'candidate_hash', 'reviewer', 'model', 'rationale')), 'Missing review provenance')
        require(artifact['decision'] in {'approved', 'rejected', 'needs_review'}, 'Invalid review decision')
        require(type(artifact['base_version']) is int, 'Review base version must be integer')
        instant(artifact['reviewed_at'])
        require(isinstance(artifact['conflicts'], list) and all(text(c) for c in artifact['conflicts']), 'Invalid conflicts')
        require(isinstance(artifact['evidence_ids'], list) and all(text(i) for i in artifact['evidence_ids']), 'Invalid reviewed evidence IDs')
        artifact_hash = digest(artifact)
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            duplicate = self.db.execute('SELECT * FROM reviews WHERE artifact_hash=?', (artifact_hash,)).fetchone()
            if duplicate:
                return {'review_id': duplicate['id'], 'decision': duplicate['effective_decision'], 'reasons': json.loads(duplicate['reasons'])}
            proposal = self.db.execute('SELECT * FROM proposals WHERE id=?', (artifact['proposal_id'],)).fetchone()
            require(proposal is not None, 'Unknown proposal')
            require(artifact['candidate_hash'] == proposal['id'] and artifact['base_version'] == proposal['base_version'], 'Review is for another candidate hash/version')
            candidate = json.loads(proposal['candidate'])
            evidence_ids = {e['id'] for e in candidate['evidence']}
            require(set(artifact['evidence_ids']) <= evidence_ids, 'Review references unknown evidence')
            require(instant(artifact['reviewed_at']) >= max(instant(e['observed_at']) for e in candidate['evidence']), 'Review predates evidence observation')
            previous = self.current(proposal['facility_id'])
            correction_row = self.db.execute('SELECT correction FROM proposal_corrections WHERE proposal_id=?',
                                             (proposal['id'],)).fetchone()
            correction = json.loads(correction_row['correction']) if correction_row else None
            if correction:
                require(artifact.get('correction_hash') == digest(correction),
                        'Dedicated correction review must bind the exact correction metadata hash')
            else:
                require('correction_hash' not in artifact,
                        'Correction hash supplied for a proposal without correction metadata')
            reasons = self.holds(candidate, previous, correction)
            if artifact['conflicts']:
                reasons.append('Reviewer reported unresolved conflicts')
            asserted_ids = {i for a in candidate['assertions'] for i in a['evidence_ids']}
            if not asserted_ids <= set(artifact['evidence_ids']):
                reasons.append('Review does not cover every asserted evidence item')
            decision = artifact['decision']
            if decision == 'approved' and reasons:
                decision = 'needs_review'
            review_id = self.db.execute('INSERT INTO reviews(artifact_hash,proposal_id,artifact,effective_decision,reasons,imported_at) VALUES (?,?,?,?,?,?)',
                                       (artifact_hash, proposal['id'], canonical(artifact), decision, canonical(reasons), now())).lastrowid
            if decision == 'approved':
                self.db.execute('INSERT INTO publications VALUES (?,?,?,?,?)',
                                (proposal['facility_id'], proposal['base_version'] + 1, proposal['id'], review_id, now()))
        return {'review_id': review_id, 'decision': decision, 'reasons': reasons}

    def export(self):
        rows = self.db.execute('''SELECT c.candidate, p.version, r.artifact FROM publications p
          JOIN proposals c ON c.id=p.proposal_id JOIN reviews r ON r.id=p.review_id
          WHERE p.version=(SELECT MAX(p2.version) FROM publications p2 WHERE p2.facility_id=p.facility_id)
          ORDER BY p.facility_id''').fetchall()
        records = []
        for row in rows:
            candidate, review = json.loads(row['candidate']), json.loads(row['artifact'])
            facility = candidate['facility']
            facility['sources'] = [{'name': e['name'], 'url': e['url'], 'accessed_at': e['observed_at'][:10],
                                    **{key: e[key] for key in ('access_method', 'excerpt_kind') if key in e},
                                    'supports': sorted({a['field'] for a in candidate['assertions'] if e['id'] in a['evidence_ids']})}
                                   for e in candidate['evidence']]
            facility['status_evidence'] = sorted({i for a in candidate['assertions'] if a['field'] == 'operational_status' for i in a['evidence_ids']})
            facility['evidence'] = candidate['evidence']
            facility['verification'] = {'status': 'ai_reviewed', 'reviewed_on': review['reviewed_at'][:10],
                                        'reviewed_by': review['reviewer'] + '/' + review['model'], 'scope': 'candidate assertions'}
            facility['provenance_note'] = review['rationale']
            facility['version'] = row['version']
            records.append(facility)
        return records
