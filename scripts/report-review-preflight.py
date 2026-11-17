#!/usr/bin/env python3
"""Read-only check for an existing exact-current report approval; never approves data."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('report_approval_builder', Path(__file__).with_name('build-report-approvals.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def check(report_id, root):
    data = root / 'data'
    reports = {r['id']: r for r in json.loads((data / 'unapproved-reports.json').read_text())['incidents']}
    facilities = {f['id']: f for f in json.loads((data / 'reviewed-facilities.json').read_text())}
    overlay = json.loads((data / 'report-approvals.json').read_text())
    if report_id not in reports:
        return {'report_id': report_id, 'state': 'unknown_report'}
    matches = [r for r in overlay.get('approvals', []) if r.get('report_id') == report_id]
    if overlay.get('schema_version') != 1 or len(matches) != 1:
        return {'report_id': report_id, 'state': 'needs_review', 'reason': 'no unique current approval overlay'}
    review = matches[0]
    try:
        validated = builder.validate(review, reports, facilities)
        if review.get('facility_sha256') != validated['facility_sha256']:
            raise ValueError('approved facility hash changed')
    except (AssertionError, KeyError, ValueError, TypeError, AttributeError, IndexError, StopIteration) as exc:
        return {'report_id': report_id, 'state': 'needs_review', 'reason': str(exc) or 'invalid approval binding'}
    return {'report_id': report_id, 'state': 'already_approved_current',
            'facility_id': review['facility_id'], 'facility_version': review['facility_version'],
            'incident_id': review['incident_id'], 'report_sha256': review['report_sha256'],
            'note': 'Skip unchanged work. New corrections/evidence still require actual AI review.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report_ids', nargs='+')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        results = [check(report_id, args.root) for report_id in args.report_ids]
    except (OSError, ValueError, TypeError, KeyError, AttributeError, IndexError) as exc:
        print(json.dumps({'state': 'unavailable', 'error': str(exc)}))
        return 2
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
