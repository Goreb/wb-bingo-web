import copy
import tempfile
import unittest
from pathlib import Path
from pipeline.store import Store, digest, validate_candidate


def candidate(status='unknown', effective=None, base=0):
    facility = {'id': 'example-facility', 'name': 'Example fixture', 'facility_type': 'warehouse',
                'operator': 'Fixture operator', 'region': 'Fixture region', 'country': 'RU',
                'footprint_m2': None, 'incidents': [], 'operational_status': status, 'status_as_of': effective}
    assertions = [{'field': field, 'value': facility[field], 'evidence_ids': ['e1']}
                  for field in ('name', 'facility_type', 'operator', 'region', 'country')]
    if status != 'unknown':
        assertions.append({'field': 'operational_status', 'value': status, 'effective_on': effective, 'evidence_ids': ['e1']})
    return {'schema_version': 1, 'base_version': base, 'facility': facility,
            'evidence': [{'id': 'e1', 'name': 'Synthetic test source', 'url': 'https://example.com/test',
                          'observed_at': '2026-01-10T00:00:00Z', 'published_on': '2026-01-09',
                          'excerpt': 'Synthetic test fixture only; not a real facility assertion.'}], 'assertions': assertions}


def review(staged, **changes):
    artifact = {**staged, 'reviewer': 'test-fixture-only', 'model': 'no-real-ai-call',
                'reviewed_at': '2026-01-11T00:00:00Z', 'decision': 'approved',
                'rationale': 'Synthetic testing artifact; never publish as real evidence.', 'evidence_ids': ['e1'], 'conflicts': []}
    artifact.update(changes)
    return artifact


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'test.sqlite')

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def approve(self, record):
        result = self.store.review(review(self.store.stage(record)))
        self.assertEqual('approved', result['decision'], result)

    def test_gate_and_idempotence(self):
        staged = self.store.stage(candidate())
        self.assertEqual(staged, self.store.stage(candidate()))
        self.assertEqual([], self.store.export())
        artifact = review(staged)
        first = self.store.review(artifact)
        self.assertEqual(first, self.store.review(artifact))
        self.assertEqual(1, len(self.store.export()))
        self.assertEqual('ai_reviewed', self.store.export()[0]['verification']['status'])

    def test_expanded_physical_facility_types_are_accepted(self):
        for facility_type in ('bridge', 'military_facility', 'defence_manufacturing', 'government_building',
                              'drone_facility', 'robotics_facility', 'industrial_facility'):
            item = candidate()
            item['facility']['facility_type'] = facility_type
            next(assertion for assertion in item['assertions'] if assertion['field'] == 'facility_type')['value'] = facility_type
            validate_candidate(item)

    def test_review_must_match_hash_and_version(self):
        staged = self.store.stage(candidate())
        for change in ({'candidate_hash': 'bad'}, {'base_version': 2}):
            with self.assertRaises(ValueError):
                self.store.review(review(staged, **change))
        self.assertEqual([], self.store.export())

    def test_concurrent_proposals_cannot_overwrite_newer_version(self):
        first = candidate()
        second = copy.deepcopy(first)
        second['facility']['name'] = 'Other fixture name'
        second['assertions'][0]['value'] = 'Other fixture name'
        staged = self.store.stage(second)
        self.approve(first)
        result = self.store.review(review(staged))
        self.assertEqual('needs_review', result['decision'])
        self.assertEqual('Example fixture', self.store.export()[0]['name'])

    def test_reopening_requires_new_dated_evidence(self):
        self.approve(candidate('temporarily_closed', '2026-01-05'))
        reopened = candidate('reopened', '2026-01-08', base=1)
        reopened['evidence'][0]['published_on'] = None
        self.assertEqual('needs_review', self.store.review(review(self.store.stage(reopened)))['decision'])
        reopened['evidence'][0]['published_on'] = '2026-01-09'
        self.approve(reopened)
        self.assertEqual('reopened', self.store.export()[0]['operational_status'])

    def test_old_status_cannot_regress_newer_fact(self):
        self.approve(candidate('operating', '2026-01-08'))
        result = self.store.review(review(self.store.stage(candidate('disrupted', '2026-01-05', base=1))))
        self.assertEqual('needs_review', result['decision'])
        self.assertEqual('operating', self.store.export()[0]['operational_status'])

    def test_conflicting_assertions_or_reviewer_conflicts_hold(self):
        item = candidate()
        item['assertions'].append({'field': 'name', 'value': 'Different name', 'evidence_ids': ['e1']})
        self.assertEqual('needs_review', self.store.review(review(self.store.stage(item)))['decision'])
        self.assertEqual('needs_review', self.store.review(review(self.store.stage(candidate()), conflicts=['Contradictory source']))['decision'])
        self.assertEqual([], self.store.export())

    def test_rejection_preserves_approved_facts(self):
        self.approve(candidate())
        self.store.review(review(self.store.stage(candidate('disrupted', '2026-01-09', 1)), decision='rejected'))
        self.assertEqual('unknown', self.store.export()[0]['operational_status'])
        self.assertEqual(1, self.store.export()[0]['version'])

    def test_evidence_coverage_and_incident_retention(self):
        item = candidate()
        item['facility']['incidents'] = [{'id': 'incident-1', 'date': '2026-01-01', 'description': 'Synthetic fixture incident'}]
        item['assertions'].append({'field': 'incidents', 'value': item['facility']['incidents'], 'evidence_ids': ['e1']})
        self.approve(item)
        result = self.store.review(review(self.store.stage(candidate(base=1))))
        self.assertEqual('needs_review', result['decision'])
        self.assertEqual(1, len(self.store.export()[0]['incidents']))
        result = self.store.review(review(self.store.stage(candidate(base=1)), evidence_ids=[]))
        self.assertEqual('needs_review', result['decision'])

    def test_validation_rejects_unsafe_missing_and_invalid_dates(self):
        mutations = [lambda c: c['evidence'][0].update(url='javascript:alert(1)'),
                     lambda c: c['evidence'][0].update(observed_at='2026-01-01'),
                     lambda c: c['evidence'][0].update(published_on='2026-02-30'),
                     lambda c: c['facility'].update(facility_type='oil_field'),
                     lambda c: c.update(extra='unexpected'),
                     lambda c: c['facility'].update(footprint_m2=float('nan'))]
        for mutate in mutations:
            item = candidate()
            mutate(item)
            with self.assertRaises(ValueError):
                validate_candidate(item)

    def test_queue_status_inspect_and_review_transitions(self):
        self.assertIsNone(self.store.status()['latest_publication'])
        item = candidate()
        staged = self.store.stage(item)
        self.assertEqual(1, self.store.status()['counts']['pending_proposals'])
        self.assertEqual(item, self.store.inspect(staged['proposal_id'])['candidate'])
        self.store.review(review(staged, decision='needs_review'))
        self.assertEqual('needs_review', self.store.pending()[0]['latest_decision'])
        self.store.review(review(staged, decision='rejected'))
        self.assertEqual([], self.store.pending())
        self.store.review(review(staged))
        self.assertEqual([], self.store.pending())
        status = self.store.status()
        self.assertEqual(1, status['counts']['approved_facilities'])
        self.assertEqual(3, status['counts']['reviews'])
        self.assertEqual(staged['proposal_id'], status['latest_publication']['proposal_id'])
        with self.assertRaises(ValueError):
            self.store.inspect('missing')

    def test_source_access_and_review_limits_survive_export(self):
        item = candidate()
        item['evidence'][0].update(access_method='search_index', excerpt_kind='paraphrase')
        self.approve(item)
        exported = self.store.export()[0]
        self.assertEqual('search_index', exported['sources'][0]['access_method'])
        self.assertEqual('paraphrase', exported['sources'][0]['excerpt_kind'])
        self.assertIn('Synthetic testing artifact', exported['provenance_note'])
        for field in ('access_method', 'excerpt_kind'):
            invalid = copy.deepcopy(item)
            invalid['evidence'][0][field] = 'made_up'
            with self.assertRaises(ValueError):
                validate_candidate(invalid)

    def test_history_is_append_only(self):
        self.approve(candidate())
        import sqlite3
        for table in ('proposals', 'reviews', 'publications'):
            with self.assertRaises(sqlite3.IntegrityError):
                self.store.db.execute('DELETE FROM ' + table)
            self.store.db.rollback()

    def test_dedicated_description_correction_requires_exact_current_incident_and_review(self):
        original = candidate()
        original['facility']['incidents'] = [{'id': 'incident-1', 'date': '2026-01-01',
                                              'description': 'Original supported description.'}]
        original['assertions'].append({'field': 'incidents', 'value': original['facility']['incidents'],
                                       'evidence_ids': ['e1']})
        self.approve(original)

        corrected = copy.deepcopy(original)
        corrected['base_version'] = 1
        old_incident = copy.deepcopy(corrected['facility']['incidents'][0])
        replacement = {**old_incident, 'description': 'Corrected source-supported description.'}
        corrected['facility']['incidents'][0] = replacement
        corrected['evidence'].append({'id': 'e2', 'name': 'Correction source', 'url': 'https://example.com/correction',
                                      'observed_at': '2026-01-12T00:00:00Z', 'published_on': '2026-01-11',
                                      'excerpt': 'Synthetic source supports the corrected description.'})
        corrected['assertions'][-1] = {'field': 'incidents', 'value': corrected['facility']['incidents'],
                                       'evidence_ids': ['e2']}
        correction = {'incident_id': old_incident['id'], 'previous_incident': old_incident,
                      'previous_incident_hash': digest(old_incident), 'replacement_incident': replacement,
                      'reason': 'Correct a source-extraction error in the existing description.',
                      'source_evidence_ids': ['e2']}

        # The normal path remains held for any change to published history.
        ordinary = self.store.stage(corrected)
        self.assertEqual('needs_review', self.store.review(review(ordinary, evidence_ids=['e1', 'e2'],
                                                                   reviewed_at='2026-01-13T00:00:00Z'))['decision'])

        staged = self.store.stage_correction(corrected, correction)
        self.assertEqual(correction, self.store.inspect(staged['proposal_id'])['historical_correction'])
        with self.assertRaisesRegex(ValueError, 'bind the exact correction'):
            self.store.review(review(staged, evidence_ids=['e1', 'e2'], reviewed_at='2026-01-13T00:00:00Z',
                                     rationale='Review omitted the correction sidecar binding.'))
        incomplete_review = self.store.review(review(staged, evidence_ids=['e1'], reviewed_at='2026-01-13T00:00:00Z',
                                                     correction_hash=digest(correction)))
        self.assertEqual('needs_review', incomplete_review['decision'])
        approved = self.store.review(review(staged, evidence_ids=['e1', 'e2'], reviewed_at='2026-01-13T00:00:00Z',
                                            correction_hash=digest(correction)))
        self.assertEqual('approved', approved['decision'], approved)
        exported = self.store.export()[0]
        self.assertEqual(2, exported['version'])
        self.assertEqual([replacement], exported['incidents'])

    def test_dedicated_correction_rejects_unrelated_change_deletion_or_wrong_hash(self):
        original = candidate()
        original['facility']['incidents'] = [{'id': 'incident-1', 'date': '2026-01-01', 'description': 'Old.'}]
        original['assertions'].append({'field': 'incidents', 'value': original['facility']['incidents'], 'evidence_ids': ['e1']})
        self.approve(original)
        old_incident = copy.deepcopy(original['facility']['incidents'][0])
        replacement = {**old_incident, 'description': 'New.'}
        base = copy.deepcopy(original)
        base['base_version'] = 1
        base['facility']['incidents'][0] = replacement
        base['evidence'].append({'id': 'e2', 'name': 'Correction source', 'url': 'https://example.com/correction',
                                 'observed_at': '2026-01-12T00:00:00Z', 'published_on': '2026-01-11', 'excerpt': 'Correction source.'})
        base['assertions'][-1] = {'field': 'incidents', 'value': base['facility']['incidents'], 'evidence_ids': ['e2']}
        correction = {'incident_id': old_incident['id'], 'previous_incident': old_incident,
                      'previous_incident_hash': digest(old_incident), 'replacement_incident': replacement,
                      'reason': 'Source-backed correction.', 'source_evidence_ids': ['e2']}
        bad_hash = copy.deepcopy(correction)
        bad_hash['previous_incident_hash'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'hash'):
            self.store.stage_correction(base, bad_hash)
        deleted = copy.deepcopy(base)
        deleted['facility']['incidents'] = []
        deleted['assertions'][-1]['value'] = []
        with self.assertRaisesRegex(ValueError, 'changes fields or incidents'):
            self.store.stage_correction(deleted, correction)
        unrelated = copy.deepcopy(base)
        unrelated['facility']['name'] = 'Changed too'
        with self.assertRaisesRegex(ValueError, 'changes fields or incidents'):
            self.store.stage_correction(unrelated, correction)

    def test_superseded_proposals_leave_actionable_queue_but_keep_history(self):
        old = candidate()
        self.store.review(review(self.store.stage(old), decision='needs_review', conflicts=['Missing accessible source']))
        replacement = copy.deepcopy(old)
        replacement['evidence'][0]['excerpt'] = 'New independently checked fixture evidence.'
        self.approve(replacement)
        self.assertEqual([], self.store.pending())
        self.assertEqual(2, self.store.status()['counts']['proposals'])


if __name__ == '__main__':
    unittest.main()
