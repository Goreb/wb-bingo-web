#!/usr/bin/env python3
"""Build a public-safe local snapshot. No network calls or database writes.

Update CURATED_STATE only after checking the corresponding outcome. Running this
script refreshes measurements, not tests or research. Serve the root over HTTP.
"""
import json
import hashlib
import os
import re
import sqlite3
import subprocess
import tempfile
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Single human-maintained source for milestones; file existence is not test evidence.
CURATED_STATE = {'goal': 'Build the most complete practical facility and incident database, including dated operational '
         'changes and reopenings.',
 'phase': 'Research, reviews and four-hour maintenance resumed',
 'task_state': 'in_progress',
 'summary': 'Current figures are measured from the catalogue, approved export and research queue. Clear '
            'dated Reuters reporting is sufficient; missing cause, damage or operating status does not block '
            'a supported incident.',
 'milestones': [{'title': 'Source research and provenance',
                 'status': 'in_progress',
                 'detail': 'Reuters reports and legitimate Reuters reprints are collected with dates and '
                           'attribution. Targeted research is not a complete inventory of every Reuters '
                           'article.'},
                {'title': 'Independent Luna review',
                 'status': 'verified',
                 'detail': 'All 85 frozen groups were reviewed; 13 retain explicit holds. A Luna reviewer checked source-to-facility/date/assertion '
                           'matching and applies supported candidates through the exact-version SQLite gate. '
                           'Sol remains stopped.'},
                {'title': 'Facility interface and galleries',
                 'status': 'verified',
                 'detail': 'The local facility page and findings overview rendered in Safari. Cards, map, '
                           'incident history, favorites, settings and galleries are available; this is not a '
                           'fresh full UI test.'},
                {'title': 'Historical Telegram archive',
                 'status': 'verified',
                 'detail': 'The supplied 2022–2025 archive was reconciled with the prior text import; dated '
                           'source posts and selected media were preserved. Photos retain their separate '
                           'media provenance.'},
                {'title': 'Regional expansion',
                 'status': 'later',
                 'detail': 'Original geographic scope first; Ukraine, NATO countries and worldwide phases '
                           'are not active.'}],
 'checks': [{'title': 'Measured dashboard',
             'status': 'verified',
             'detail': 'Catalogue, queue and approved-export figures are recomputed locally. Snapshot '
                       'generation is not a source review or a new test run.'},
            {'title': 'Exact review gate',
             'status': 'verified',
             'detail': 'Imported candidates retain exact hashes, source assertions, reviewer provenance and '
                       'append-only publication history. Database totals below are measured, not fixed '
                       'milestone counts.'},
            {'title': 'Local Safari preview',
             'status': 'verified',
             'detail': 'Facility interface and the findings overview loaded from the local HTTP server. '
                       'Public pages.dev delivery is separate.'}],
 'decisions': ['One clear dated Reuters report suffices; no mandatory second source or additional truth '
               'investigation. Preserve attribution and unknown details.',
               'Independent Luna reviewer and scout remain separate. Sol and Astra remain stopped.',
               'Luna work has no user-set usage cap under the latest override; platform limits apply, with no paid '
               'credits or resets.',
               'A hit does not alone establish shutdown. Russian government/operator reopening assertions '
               'remain separately labelled Russian claims.',
               'Local imports and overview updates are authorized; no new Git publication or deployment.'],
 'next_steps': ['Use the current local website and findings overview.',
                'Revisit held assertions only when new evidence resolves their recorded reason.',
                'Continue resumed Reuters/source research, independent Luna reviews and four-hour checks from saved cursors.'],
 'blockers': ['Source coverage is incomplete; public indexes and some source listings have access limits.',
              'Unknown exact facility identities and concrete date conflicts remain held separately.',
              'The local schedule requires this Mac and Codex to be available.']}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def application_snapshot():
    """Compare published records, never treating ready proposals as approvals."""
    try:
        baseline = read_json(ROOT / 'research/applied-findings/before.json')
        before = {item['id']: item for item in baseline['records']}
        after = {item['id']: item for item in read_json(ROOT / 'data/reviewed-facilities.json')}
        old_events = {(key, event['id']) for key, item in before.items()
                      for event in item.get('incidents', [])}
        new_events = {(key, event['id']) for key, item in after.items()
                      for event in item.get('incidents', [])} - old_events
        changes = {key for key in before.keys() & after.keys()
                   if (before[key].get('operational_status'), before[key].get('status_as_of')) !=
                   (after[key].get('operational_status'), after[key].get('status_as_of'))}
        paths = set()
        for path in (ROOT / 'pipeline/runtime/continuous-review/queue').glob('*.json'):
            envelope = read_json(path)
            if envelope.get('state') == 'ready':
                paths.update(envelope.get('candidate_paths', []))
        proposed_events, proposed_ids = set(), set()
        for path in paths:
            candidate = read_json(ROOT / path)['facility']
            proposed_ids.add(candidate['id'])
            proposed_events.update((candidate['id'], event['id'])
                                   for event in candidate.get('incidents', []))
        control = read_json(ROOT / 'pipeline/runtime/continuous-review/control.json')
        reuters = read_json(ROOT / 'research/reuters-archive/control.json')
        usage_path = ROOT / 'pipeline/runtime/continuous-review/usage-status.json'
        quota = read_json(usage_path) if usage_path.is_file() else None
        return {'available': True, 'approved_before': len(before), 'approved_now': len(after),
                'imported_incidents': len(new_events),
                'changed_facilities': len({key for key, _ in new_events} | changes),
                'new_facilities': len(after.keys() - before.keys()),
                'status_changes': len(changes), 'ready_versions': len(paths),
                'proposed_facilities': len(proposed_ids),
                'pending_incident_ids': len(proposed_events - old_events - new_events),
                'reviewer': ('Independent Luna review enabled; Sol stopped'
                             if control.get('reviewer_enabled') else 'Review disabled'),
                'stop_remaining_percent': control.get('usage_guard', {}).get('minimum_remaining_percent'),
                'quota': quota, 'scout_checkpoint': scout_checkpoint(),
                'prepared_backlog': prepared_backlog_snapshot()}
    except (OSError, ValueError, KeyError, TypeError):
        return {'available': False}


def scout_checkpoint():
    """A saved pointer records workflow position, not exhaustive source coverage."""
    try:
        cursor = read_json(ROOT / 'research/reuters-archive/report-backlog-cursor.json')
        reports = read_json(ROOT / 'data/unapproved-reports.json')['incidents']
        offset = cursor.get('next_raw_index')
        return {'saved_at': cursor.get('updated_at_utc'),
                'next_report_id': cursor.get('next_raw_report_id'),
                'at_snapshot_end': type(offset) is int and offset >= len(reports),
                'last_checked_ids': cursor.get('last_checked_report_ids', [])}
    except (OSError, ValueError, TypeError):
        return None


def prepared_backlog_snapshot():
    """Count completed reviewer dispositions against the frozen work list."""
    directory = ROOT / 'pipeline/runtime/prepared-review'
    try:
        manifest = read_json(directory / 'manifest-20261020.json')
        ids = {item['facility_id'] for item in manifest['facility_groups']}
        latest = {}
        ledger = directory / 'review-decisions.jsonl'
        if ledger.is_file():
            for line in ledger.read_text(encoding='utf-8').splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue  # A worker may be appending the final line.
                if row.get('facility_id') in ids and row.get('group_complete') is True:
                    decision = {'approved_with_separate_claim_already_applied': 'approved',
                                'approved_correction': 'approved'}.get(row.get('disposition'), row.get('disposition'))
                    if decision in {'approved', 'already_applied', 'duplicate', 'held', 'rejected'}:
                        latest[row['facility_id']] = decision
        return {'total_groups': len(ids), 'completed_groups': len(latest),
                'remaining_groups': len(ids) - len(latest),
                'dispositions': dict(Counter(latest.values()))}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def media_inventory_milestone():
    title = 'Media inventory · current files'
    try:
        manifest = read_json(ROOT / 'data/report-media.json')
        reports = read_json(ROOT / 'data/unapproved-reports.json')['incidents']
        facility_images = [item['src'] for items in manifest['facility_photos'].values()
                           for item in items if item.get('kind') == 'image']
        incident_images = {item['src'] for items in manifest['by_post'].values()
                           for item in items if item.get('kind') == 'image'}
        for report in reports:
            for update in report.get('updates', []):
                incident_images.update(photo['path'] for photo in update.get('photos', []))
        missing = sum(not (ROOT / path).is_file()
                      for path in incident_images | set(facility_images))
        return {'title': title, 'status': 'in_progress',
                'detail': (f'{len(incident_images)} unique incident-image paths; '
                           f'{len(facility_images)} facility-image entries across '
                           f'{len(manifest["facility_photos"])} facility IDs; '
                           f'{missing} missing referenced files. '
                           'File inventory only; this does not verify image identity or timing.')}
    except (OSError, ValueError, TypeError, KeyError):
        return {'title': title, 'status': 'unavailable',
                'detail': 'Media inventory could not be measured.'}


def facility_photo_scout_milestone():
    try:
        scout = read_json(ROOT / 'research/facility-photo-scout/scout-initial-20261020.json')
        if not isinstance(scout, dict) or not isinstance(scout.get('entries'), list):
            raise ValueError('Invalid facility photo-scout snapshot')
    except (OSError, ValueError, TypeError):
        return {'title': 'Facility photo-scout research', 'status': 'unavailable',
                'detail': 'Separate facility photo-scout artifact is unavailable or unreadable; progress was not measured. No record approval, app/media integration, or deployment.'}
    entries = scout.get('entries', [])
    counts = Counter(entry.get('status', 'unchecked') for entry in entries)
    checked = sum(entry.get('status', 'unchecked') != 'unchecked' for entry in entries)
    visually_screened = sum(entry.get('visual_review', {}).get('pixels_reviewed') is True
                            for entry in entries)
    detail = (f'{checked} of {len(entries)} effective facility IDs checked; '
              f"{counts['dated_source_lead_unverified_image']} dated image leads, "
              f"{counts['undated_gallery_or_image_lead']} undated gallery leads, "
              f"{counts['not_found_in_bounded_search']} not found in bounded searches, "
              f"{counts['confirmed_pre_incident_photo']} confirmed pre-incident photos. "
              f'{visually_screened} source images visually screened; source attribution remains separate from independent identification. '
              'Separate public-source research; no record approval, app/media integration, or deployment.')
    return {'title': 'Facility photo-scout research', 'status': 'in_progress', 'detail': detail}


def scout_queue_milestone():
    title = 'Scout handoff queue'
    try:
        control = read_json(ROOT / 'pipeline/runtime/continuous-review/control.json')
        queue_dir = ROOT / 'pipeline/runtime/continuous-review/queue'
        if not queue_dir.is_dir():
            raise ValueError('Queue directory unavailable')
        ready = []
        for path in queue_dir.glob('*.json'):
            envelope = read_json(path)
            if envelope.get('state') == 'ready':
                if not isinstance(envelope.get('candidate_paths', []), list):
                    raise ValueError('Invalid candidate paths')
                ready.append(envelope)
        candidates = {path for item in ready for path in item.get('candidate_paths', [])}
        reviewer = control.get('reviewer_state', 'unknown').replace('_', ' ')
        detail = (f'{len(ready)} ready handoff batches; {len(candidates)} distinct candidate snapshots. '
                  f'Reviewer: {reviewer}. These are research handoffs, not approved records or SQLite proposals.')
        audit_path = ROOT / 'data/import-assessments/lead-ready-schema-audit-current.json'
        if audit_path.exists():
            audit = read_json(audit_path)
            results = audit['candidate_results']
            passed = sum(item.get('result') == 'pass' for item in results)
            enriched = sum(bool(item.get('enriched_approved_incidents')) for item in results)
            detail += (f' Saved mechanical audit ({audit["recorded_at"]}): '
                       f'{passed}/{len(results)} passed; {enriched} contain historical enrichments '
                       'requiring correction review. This is not source approval.')
        return {'title': title, 'status': 'in_progress', 'detail': detail}
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return {'title': title, 'status': 'unavailable',
                'detail': 'Scout queue or reviewer control could not be read; queue progress is unavailable.'}


def reuters_archive_milestone():
    title = 'Reuters retrospective · Luna'
    try:
        control = read_json(ROOT / 'research/reuters-archive/control.json')
        progress = read_json(ROOT / 'research/reuters-archive/progress.json')
        state = str(progress.get('status', 'unknown')).replace('_', ' ')
        stop = control['budget']['minimum_remaining_percent']
        def ledger_or_snapshot(name, fallback):
            path = ROOT / f'research/reuters-archive/{name}.jsonl'
            if not path.exists():
                return fallback
            return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()
                    if line.strip()]
        windows = ledger_or_snapshot('windows', progress.get('searched_windows', []))
        stories = ledger_or_snapshot('stories', progress.get('stories', []))
        if not isinstance(windows, list) or not isinstance(stories, list):
            raise ValueError('Invalid Reuters progress lists')
        category_path = ROOT / 'research/reuters-archive/category-progress.json'
        category_detail = ''
        if category_path.exists():
            category = read_json(category_path)
            category_detail = (f'Category follow-up: {category.get("completed_rounds", 0)}/'
                               f'{category.get("round_limit", "unknown")} bounded rounds; '
                               f'next: {category.get("next_round", "unknown")}. ')
        legacy_path = ROOT / 'research/reuters-archive/legacy-gap-followup-progress.json'
        if legacy_path.exists():
            legacy = read_json(legacy_path)
            category_detail += (f'Older-incident evidence follow-up: '
                                f'{legacy.get("completed_rounds", 0)} bounded rounds saved. ')
        detail = (f'Saved state: {state}; {len(windows)} search-window entries, '
                  f'{len(stories)} story-ledger entries including leads and corrections. '
                  f'{category_detail}'
                  f'Stop at {stop}% account allowance remaining; shared account meter. '
                  'Targeted searches, not an inventory or review of every Reuters article since February 2022. '
                  'Coverage is incomplete; ledger entries are not a unique reviewed-article count. '
                  + ('The prepared application is complete; source research resumed. Sol remains stopped.' if control.get('enabled') else 'The prepared application is complete; source research is paused. Sol remains stopped.'))
        return {'title': title, 'status': 'in_progress' if control.get('enabled') else 'pending', 'detail': detail}
    except (OSError, ValueError, TypeError, KeyError):
        return {'title': title, 'status': 'unavailable',
                'detail': 'Reuters control/progress unavailable; no archive coverage claimed.'}


def reuters_backlog_milestone():
    title = 'Reuters follow-up research'
    try:
        directory = ROOT / 'research/reuters-archive'
        progress = read_json(directory / 'backlog-progress.json')
        index = read_json(directory / 'lead-backlog-index.json')
        total = len(index['entries'])
        offset = progress['next_cursor']['reference_scan_offset']
        if type(offset) is not int or not 0 <= offset <= total:
            raise ValueError('Invalid backlog cursor')
        indexed = {item['reference_id'] for item in index['entries']}
        decisions = directory / 'backlog-decisions.jsonl'
        checked = {json.loads(line).get('reference_id')
                   for line in decisions.read_text(encoding='utf-8').splitlines() if line.strip()}
        detail = (f'{len(indexed & checked)}/{total} indexed references have saved decisions; '
                  f'checkpoint: {progress.get("last_checkpoint_at", "unknown")}. '
                  'Index entries can repeat or remain unresolved; this is not an incident or approval count. '
                  'Saved decisions preserve source-access and identity/date holds. The independent application reviewer uses Luna; Sol remains stopped.')
        return {'title': title, 'status': 'in_progress', 'detail': detail}
    except (OSError, ValueError, TypeError, KeyError):
        return {'title': title, 'status': 'unavailable',
                'detail': 'Reuters follow-up cursor unavailable; no follow-up coverage claimed.'}


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def public_remote(value):
    # Never publish credentials, host paths or arbitrary private remote URLs.
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?', value)
    return 'https://github.com/' + match.group(1) if match else 'Private or unsupported remote (hidden)'


def git_snapshot():
    try:
        changes = git('status', '--porcelain', '--untracked-files=all').splitlines()
        remotes = []
        for name in git('remote').splitlines():
            remotes.append({'name': name, 'url': public_remote(git('remote', 'get-url', name))})
        return {'branch': git('branch', '--show-current') or 'Detached HEAD', 'changed_files': len(changes),
                'state': 'Local uncommitted changes' if changes else 'Working tree clean', 'remotes': remotes,
                'delivery': 'Snapshot does not establish push, merge or deployment status.'}
    except (OSError, subprocess.SubprocessError):
        return {'state': 'Git snapshot unavailable', 'remotes': []}


def database_snapshot():
    path = ROOT / 'pipeline/runtime/facilities.sqlite3'
    if not path.is_file():
        return {'available': False, 'message': 'Local review database unavailable.'}
    try:
        # Deliberately do not construct Store: its initializer changes the database.
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            db.execute('PRAGMA query_only=ON')
            counts = {name: db.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0]
                      for name in ('proposals', 'reviews', 'publications')}
            counts['approved_facilities'] = db.execute('SELECT COUNT(DISTINCT facility_id) FROM publications').fetchone()[0]
            counts['pending_proposals'] = db.execute('''SELECT COUNT(*) FROM proposals p
                LEFT JOIN reviews r ON r.id=(SELECT MAX(r2.id) FROM reviews r2 WHERE r2.proposal_id=p.id)
                WHERE (r.id IS NULL OR r.effective_decision='needs_review')
                AND NOT EXISTS (SELECT 1 FROM publications pub WHERE pub.proposal_id=p.id)
                AND p.base_version >= COALESCE((SELECT MAX(pub.version) FROM publications pub WHERE pub.facility_id=p.facility_id),0)''').fetchone()[0]
            decisions = dict(db.execute('SELECT effective_decision, COUNT(*) FROM reviews GROUP BY effective_decision'))
        return {'available': True, 'counts': counts, 'review_decisions': decisions}
    except sqlite3.Error:
        return {'available': False, 'message': 'Review database could not be read; previous data is not assumed current.'}


def measurements():
    catalog = read_json(ROOT / 'data/catalog.json')
    records = []
    for dataset in catalog['datasets']:
        path = (ROOT / dataset['path']).resolve()
        if not path.is_relative_to(ROOT):
            raise ValueError('Dataset must be inside repository')
        for record in read_json(path):
            records.append({**dataset.get('defaults', {}), **record,
                            '_review': record.get('verification', {}).get('status', dataset.get('review_status', 'unreviewed'))})
    by_id = {}
    for record in records:
        previous = by_id.get(record['id'])
        if previous is None or record['_review'] == 'ai_reviewed':
            by_id[record['id']] = record
    records = list(by_id.values())
    original_ids = {record['id'] for record in read_json(ROOT / 'facilities.json')}
    types = Counter(record.get('facility_type', 'unknown') for record in records)
    operators = Counter(record.get('operator', 'Unknown') for record in records)
    return {'legacy_total': len(original_ids),
            'legacy_reviewed': sum(record['id'] in original_ids and record['_review'] == 'ai_reviewed' for record in records),
            'facilities': len(records), 'categories_registered': len(catalog['categories']),
            'categories_populated': len(types), 'operators': sum(key != 'Not recorded' for key in operators),
            'ai_reviewed': sum(record['_review'] == 'ai_reviewed' for record in records),
            'unreviewed': sum(record['_review'] != 'ai_reviewed' for record in records),
            'inherited_unreviewed': sum(record['id'] in original_ids and record['_review'] != 'ai_reviewed' for record in records),
            'discovery_unreviewed': sum(record['id'] not in original_ids and record['_review'] != 'ai_reviewed' for record in records),
            'category_counts': [{'label': item['label'], 'count': types[item['id']],
                'reviewed': sum(record.get('facility_type') == item['id'] and record['_review'] == 'ai_reviewed' for record in records),
                'awaiting_review': sum(record.get('facility_type') == item['id'] and record['_review'] != 'ai_reviewed' for record in records)} for item in catalog['categories']],
            'missing_counts': {'operator': sum(record.get('operator') in (None, '', 'Not recorded') for record in records),
                'region': sum(record.get('region') in (None, '', 'Not recorded') for record in records),
                'footprint': sum(record.get('footprint_m2') is None for record in records),
                'current_status': sum(record.get('operational_status', 'unknown') == 'unknown' for record in records)},
            'operator_counts': [{'label': key, 'count': value} for key, value in sorted(operators.items())],
            'candidate_files': len(list((ROOT / 'data/candidates').glob('*.json'))),
            'archived_candidate_files': len(list((ROOT / 'data/candidates/archive').glob('*.json'))),
            'review_files': len(list((ROOT / 'data/reviews').glob('*.json')))}


def automation_snapshot():
    path = ROOT / 'data/update-status.json'
    if not path.is_file():
        return {'available': False, 'message': 'No update-status snapshot available. Automation activation is unverified.'}
    try:
        status = read_json(path)
        # Only explicitly public fields, never arbitrary metadata or paths.
        return {'available': True, 'status': str(status.get('status', 'unknown'))[:80],
                'last_run_at': status.get('last_run_at'), 'last_success_at': status.get('last_success_at'),
                'batch_summary': str(status.get('summary', ''))[:1500],
                'checked_facilities': len(status.get('checked_facility_ids', [])),
                'message': ('Schedule creation confirmed ACTIVE; first unattended run unverified.' if status.get('schedule', {}).get('status') == 'ACTIVE' and not status.get('schedule', {}).get('first_unattended_run_verified') else 'See recorded run status; schedule metadata is a last-checked snapshot.')}
    except (ValueError, OSError):
        return {'available': False, 'message': 'Update-status snapshot is unreadable.'}


def source_snapshot():
    path = ROOT / 'data/source-links.json'
    if not path.is_file():
        return {'available': False, 'message': 'No reviewed external identity links yet.'}
    links = read_json(path)
    review_path = (ROOT / links['review_file']).resolve()
    if not review_path.is_relative_to(ROOT):
        raise ValueError('Review must be inside repository')
    raw = review_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != links['review_sha256']:
        raise ValueError('External identity review hash mismatch')
    review = json.loads(raw)
    if links['approved_mappings'] != review['approved_mappings'] or links['held_mappings'] != review['held_mappings']:
        raise ValueError('Identity links differ from reviewed artifact')
    return {'available': True, 'approved_links': len(links['approved_mappings']),
            'held_links': len(links['held_mappings']), 'reviewed_at': links['reviewed_at'],
            'message': ('Five identity links independently reviewed, one held. ' + (read_json(ROOT / 'data/retrieval-status.json')['summary'] if (ROOT / 'data/retrieval-status.json').is_file() else 'No collector execution evidence recorded.') + ' Source-chain terms still need checking before production redistribution.')}


def main():
    application = application_snapshot()
    project_state = {**CURATED_STATE,
                     'milestones': [*CURATED_STATE['milestones'], media_inventory_milestone(), facility_photo_scout_milestone(),
                                    scout_queue_milestone(), reuters_archive_milestone(),
                                    reuters_backlog_milestone()]}
    if application.get('available'):
        project_state['summary'] = (
            f"{application['imported_incidents']} new incidents have been imported across "
            f"{application['changed_facilities']} facilities since this application started. "
            f"{application['pending_incident_ids']} proposed incident IDs remain pending; "
            "independent Luna source review is enabled. Sol stays stopped. "
            "The charts separate actual imports from proposals; no new public deployment is claimed.")
    snapshot = {'schema_version': 1, 'generated_at': datetime.now(timezone.utc).isoformat(),
                'project': project_state, 'metrics': measurements(), 'git': git_snapshot(),
                'application': application,
                'pipeline': database_snapshot(), 'automation': automation_snapshot(), 'reuse': source_snapshot(),
                'source_checks': read_json(ROOT / 'data/source-check-status.json') if (ROOT / 'data/source-check-status.json').is_file() else None}
    destination = ROOT / 'project-status.json'
    descriptor, temporary = tempfile.mkstemp(prefix='.project-status-', suffix='.tmp', dir=ROOT)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(snapshot, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write('\n')
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Updated project-status.json; no checks, network requests or database writes performed.')


if __name__ == '__main__':
    main()
