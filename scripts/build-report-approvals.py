#!/usr/bin/env python3
"""Build a fail-closed report review overlay; raw channel reports are never edited."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def identity_matches(review, report, facility):
    if report['facility_id'] == facility['id']:
        return True
    binding = review.get('identity_binding')
    return (report['facility_id'] is None and isinstance(binding, dict)
            and 'raw_facility_id' in binding and binding['raw_facility_id'] is None
            and binding.get('facility_id') == facility['id']
            and isinstance(binding.get('rationale'), str) and bool(binding['rationale'].strip())
            and isinstance(binding.get('evidence_urls'), list) and bool(binding['evidence_urls'])
            and all(isinstance(url, str) and url in review.get('evidence_urls', []) for url in binding['evidence_urls']))


def event_timing_matches(review, report):
    if 'event_timezone' not in review and 'timing_rationale' not in review:
        return any(u['posted_at'][:10] >= review['event_date'] for u in report['updates'])
    assert isinstance(review.get('event_timezone'), str) and review['event_timezone'].strip(), 'missing reviewed event timezone'
    assert isinstance(review.get('timing_rationale'), str) and review['timing_rationale'].strip(), 'missing timezone review rationale'
    assert re.fullmatch(r'(?:UTC|[A-Z][A-Za-z_]+(?:/[A-Z][A-Za-z0-9_+-]*)+)', review['event_timezone']), 'timezone must be an IANA region/name or UTC'
    zone = ZoneInfo(review['event_timezone'])
    for update in report['updates']:
        stamp = datetime.fromisoformat(update['posted_at'].replace('Z', '+00:00'))
        assert stamp.tzinfo is not None, 'source timestamp needs timezone'
        if stamp.astimezone(zone).date().isoformat() >= review['event_date']:
            return True
    return False


def validate(review, reports, facilities):
    assert review.get('schema_version') == 1 and review.get('decision') == 'approved', 'unsupported review decision'
    assert review.get('scope') == 'incident_date_town', 'unsupported approval scope'
    report = reports[review['report_id']]
    facility = facilities[review['facility_id']]
    assert identity_matches(review, report, facility), 'facility identity mismatch or missing reviewed binding'
    assert review['report_sha256'] == digest(report), 'stale report hash'
    assert type(review['facility_version']) is int and review['facility_version'] == facility['version'], 'stale facility version'
    assert facility['verification']['status'] == 'ai_reviewed', 'facility not gate approved'
    incident = next(i for i in facility['incidents'] if i['id'] == review['incident_id'])
    assert review.get('event_date') == incident['date'] and (report['event_date'] is None or report['event_date'] == incident['date']), 'incident date mismatch'
    assert event_timing_matches(review, report), 'incident after all source posts or missing reviewed timezone'
    for key in ('reviewed_by', 'model', 'approved_summary'):
        assert isinstance(review.get(key), str) and review[key].strip(), 'missing ' + key
    assert re.match(r'^\d{4}-\d\d-\d\dT', review.get('reviewed_at', '')), 'invalid review timestamp'
    stamp = datetime.fromisoformat(review['reviewed_at'].replace('Z', '+00:00'))
    assert stamp.tzinfo is not None, 'timestamp needs timezone'
    urls = review.get('evidence_urls')
    allowed = {s['url'] for s in facility['sources'] if 'incidents' in s.get('supports', [])}
    assert isinstance(urls, list) and urls and all(isinstance(u, str) and u in allowed for u in urls), 'evidence not approved incident sources'
    return {**review, 'facility_sha256': digest(facility)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    data = args.root / 'data'
    reports = {r['id']: r for r in json.loads((data / 'unapproved-reports.json').read_text())['incidents']}
    facilities = {f['id']: f for f in json.loads((data / 'reviewed-facilities.json').read_text())}
    approvals, seen, duplicates = [], set(), set()
    for path in sorted((data / 'report-reviews').glob('*.json')):
        try:
            review = validate(json.loads(path.read_text()), reports, facilities)
            if review['report_id'] in seen:
                duplicates.add(review['report_id'])
                raise ValueError('duplicate review for report')
            seen.add(review['report_id'])
            approvals.append(review)
        except (AssertionError, KeyError, ValueError, TypeError, AttributeError, IndexError, StopIteration) as exc:
            print(f'Excluded {path.name}: {exc or "missing incident"}', file=sys.stderr)
    approvals = [review for review in approvals if review['report_id'] not in duplicates]
    (data / 'report-approvals.json').write_text(json.dumps({'schema_version': 1, 'approvals': approvals}, ensure_ascii=False, indent=2) + '\n')
    print(f'Built {len(approvals)} report approvals.')


if __name__ == '__main__':
    main()
