#!/usr/bin/env python3
"""Reconcile a bounded, source-attributed JSON inventory projection against Bingo.

Usage: python3 scripts/import-public-inventory.py INPUT.json --output OUTPUT.json
The input is an assessment containing inventory_rows. Rows require name, source_url,
facility_type, country, disposition (new/matched/held), with existing_ids for matches.
A researcher supplies explicit alias decisions; fuzzy matches never become approvals.
No network scraping, coordinates, operating-status inference, or canonical writes.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def normalized(value):
    return re.sub(r'[^\w]+', '', value.casefold())

def reconcile(document, root=ROOT):
    existing = {}
    catalog = json.loads((root / 'data/catalog.json').read_text())
    for dataset in catalog['datasets']:
        payload = json.loads((root / dataset['path']).read_text())
        records = payload if isinstance(payload, list) else payload.get('facilities', [])
        for record in records:
            existing[record['id']] = record
    names = {normalized(r['name']): r['id'] for r in existing.values()}
    result, seen = [], set()
    for row in document['inventory_rows']:
        if row['country'] != 'Russia' or row['facility_type'] not in {'refinery', 'data_center'}:
            raise ValueError('Out-of-scope row')
        if not row['source_url'].startswith('https://'):
            raise ValueError('HTTPS source required')
        if 'datacentermap.com' in row['source_url']:
            raise ValueError('DataCenterMap database reuse is excluded by terms')
        disposition = row['disposition']
        if disposition not in {'new', 'matched', 'held'}:
            raise ValueError('Unknown disposition')
        for identity in row.get('existing_ids', []):
            if identity not in existing:
                raise ValueError('Unknown existing identity: ' + identity)
        if disposition != 'new':
            continue
        key = normalized(row['name'])
        if key in names or key in seen:
            raise ValueError('Duplicate name requires an explicit match/hold: ' + row['name'])
        seen.add(key)
        token = re.sub(r'[^a-z0-9]+', '-', row['name'].lower()).strip('-')
        result.append({
            'id': 'DISC-PUBLIC-' + token, 'name': row['name'],
            'facility_type': row['facility_type'], 'operator': row.get('operator', 'Not recorded'),
            'region': row.get('region', 'Not recorded'), 'country': 'Russia',
            'footprint_m2': None, 'incidents': [], 'operational_status': 'unknown',
            'status_as_of': None, 'sources': [{'name': row['source_name'], 'url': row['source_url']}],
            'verification': {'status': 'unreviewed'},
            'provenance_note': 'Unapproved public-inventory discovery. ' + row.get('note', '') +
                ' Source access on ' + document['assessed_on'] + ' is not a facility verification or status date. '
                'Identity, operator relationship, geographic label and current condition require AI review. '
                'Empty incidents means history has not been researched. No operating or reopening assertion.'
        })
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    document = json.loads(raw)
    result = reconcile(document)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'rows': len(result), 'input_sha256': hashlib.sha256(raw).hexdigest(),
                      'output_sha256': hashlib.sha256(args.output.read_bytes()).hexdigest()}))

if __name__ == '__main__':
    main()
