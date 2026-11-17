"""Offline fixtures; these do not establish live source accessibility."""
import importlib.util
from pathlib import Path
import unittest
import urllib.error

SPEC = importlib.util.spec_from_file_location('source_checker', Path(__file__).resolve().parents[1] / 'scripts/check-incident-sources.py')
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)
NEWS = {'name': 'Example', 'url': 'https://example.com/', 'domains': ['example.com']}
TG = {'name': 'TG', 'url': 'https://t.me/s/supernova_plus', 'domains': ['t.me'], 'telegram': True}


def post(ident, text='Склад Озон в Истре горит'):
    return f'<div class="tgme_widget_message" data-post="supernova_plus/{ident}"><div class="tgme_widget_message_text">{text}</div><time datetime="2026-10-19T12:00:00Z"></time></div>'


class SourceCheckerTests(unittest.TestCase):
    def test_news_links_are_same_domain_and_strip_queries(self):
        html = '<a href="/news/fire?utm=test">Warehouse fire in Istra</a><a href="https://evil.test/x">Warehouse fire elsewhere</a><script>hidden</script>'
        rows = checker.extract(html, NEWS)
        self.assertEqual([r['url'] for r in rows], ['https://example.com/news/fire'])

    def test_telegram_date_text_and_id(self):
        row = checker.extract(post(42), TG)[0]
        self.assertEqual(row['id'], 42)
        self.assertEqual(row['published_at'], '2026-10-19T12:00:00Z')
        self.assertIn('Озон', row['text'])

    def test_repeat_is_deduplicated_but_correction_survives(self):
        state, queue = {}, {}
        def fixture(html):
            return lambda *args: (html, {})
        first = checker.check(NEWS, state, queue, fixture('<a href="/fire">Warehouse fire in Istra</a>'))
        repeat = checker.check(NEWS, state, queue, fixture('<a href="/fire">Warehouse fire in Istra</a>'))
        correction = checker.check(NEWS, state, queue, fixture('<a href="/fire">Correction warehouse fire in Istra</a>'))
        self.assertTrue(first['changed'])
        self.assertFalse(repeat['changed'])
        self.assertEqual(repeat['new_leads'], 0)
        self.assertEqual(correction['new_leads'], 1)
        self.assertEqual(len(queue), 2)
        self.assertTrue(all(x['approval'] == 'none' for x in queue.values()))

    def test_blocked_empty_and_http_error_are_honest(self):
        self.assertEqual(checker.check(NEWS, {}, {}, lambda *a: ('<title>Access denied</title>', {}))['status'], 'blocked')
        self.assertEqual(checker.check(NEWS, {}, {}, lambda *a: ('<div id="app"></div>', {}))['status'], 'limited')
        def failure(*args):
            raise urllib.error.HTTPError(NEWS['url'], 403, 'denied', {}, None)
        self.assertEqual(checker.check(NEWS, {}, {}, failure)['status'], 'blocked')

    def test_incremental_cap_and_failed_second_page_retain_leads(self):
        calls, queue, state = [], {}, {'cursor': 40}
        def fixture(url, *args):
            calls.append(url)
            if len(calls) == 2:
                raise TimeoutError()
            return post(41), {}
        result = checker.check(TG, state, queue, fixture)
        self.assertEqual(calls, [TG['url'] + '?after=40', TG['url'] + '?after=41'])
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['catchup_complete'])
        self.assertEqual(state['cursor'], 41)
        self.assertEqual(len(queue), 1)

    def test_known_entity_and_unmatched_relevant_queue(self):
        facilities = [{'id': 'I', 'name': 'Istra historical warehouse', 'operator': 'Ozon'}, {'id': 'P', 'name': 'Pushkino warehouse', 'operator': 'Ozon'}]
        matches = checker.facility_matches('Склад Озон в Истре горит', facilities)
        self.assertEqual([m['facility_id'] for m in matches], ['I'])
        self.assertEqual(checker.facility_matches('Ozon company announces financial results', facilities), [])
        queue = {}
        checker.check(TG, {}, queue, lambda *a: (post(99, 'Нефтебаза горит в неизвестном городе'), {}), facilities=facilities)
        self.assertEqual(next(iter(queue.values()))['routing'], 'unmatched_relevant')

    def test_public_result_contains_no_raw_text_or_precise_location(self):
        queue = {}
        result = checker.check(TG, {}, queue, lambda *a: (post(99, 'Склад 55.1234, 37.1234, улица Частная 12'), {}))
        self.assertNotIn('55.1234', str(result))
        self.assertIn('55.1234', str(queue))
        self.assertEqual(result['cursor_after'], 99)
        self.assertFalse(result['catchup_complete'])


if __name__ == '__main__':
    unittest.main()
