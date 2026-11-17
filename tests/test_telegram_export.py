"""Private offline export parsing invariants; fixtures contain no real messages."""
import importlib.util
import json
from hashlib import sha256
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('telegram_export', Path(__file__).resolve().parents[1] / 'scripts/parse-telegram-export.py')
tg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tg)


def message(ident, text='', extra='', classes=''):
    return f'''<div class="message default {classes}" id="message{ident}"><div class="body"><div class="date details" title="19.10.2026 10:00:00 UTC+01:00">10:00</div>{extra}<div class="text">{text}</div></div></div>'''


class TelegramExportTests(unittest.TestCase):
    def parse(self, html, root=Path('/tmp')):
        parser = tg.ExportParser('messages.html', root)
        parser.feed(html)
        parser.close()
        self.assertFalse(parser.stack)
        return parser

    def test_forward_date_does_not_replace_post_date_and_links_br_preserved(self):
        extra = '<div class="forwarded body"><div class="from_name">Source <span class="date" title="01.01.2020 09:00:00 UTC+01:00">old</span></div></div>'
        m = self.parse(message(41, 'One<br>two <a href="https://example.test/a">linked <b>word</b></a>', extra)).messages[0]
        self.assertEqual(m['timestamp'], '2026-10-19T10:00:00+01:00')
        self.assertEqual(m['forwarded_metadata'][0]['timestamp'], '2020-01-01T09:00:00+01:00')
        self.assertEqual(m['text'], 'One\ntwo linked word')
        self.assertEqual(m['links'], ['https://example.test/a'])
        self.assertEqual(m['post_url'], 'https://t.me/supernova_plus/41')

    def test_joined_reply_and_placeholder_do_not_claim_media_available(self):
        extra = '<div class="reply_to"><a href="messages.html#go_to_message40">reply</a></div><div class="media_wrap"><div class="media media_photo">Photo<div>Not included, change data exporting settings to download.</div></div></div>'
        p = self.parse('<div class="message service" id="message1">service</div>' + message(41, 'НПЗ', extra) + message(42, '', extra, 'joined'))
        self.assertEqual(p.service_count, 1)
        self.assertEqual(len(p.messages), 2)
        self.assertTrue(p.messages[1]['joined'])
        self.assertEqual(p.messages[1]['reply_references'], ['messages.html#go_to_message40'])
        self.assertTrue(p.messages[0]['media'][0]['not_included_placeholder'])
        self.assertEqual(p.messages[0]['media'][0]['references'], [])
        self.assertEqual(len(tg.deduplicate(p.messages)), 2)

    def test_exact_duplicate_provenance_and_dated_correction_retained(self):
        p = self.parse(message(9, 'НПЗ пожар 1 мая') + message(10, 'НПЗ   пожар 1 мая') + message(11, 'НПЗ пожар 2 мая') + message(12, 'Исправление: НПЗ пожар 1 мая'))
        rows = tg.deduplicate(p.messages)
        self.assertEqual([m['id'] for m in rows], [9, 11, 12])
        self.assertEqual(rows[0]['duplicate_posts'][0]['post_url'], 'https://t.me/supernova_plus/10')
        self.assertEqual(len(tg.retrieve(rows)[0]), 3)

    def test_untrusted_html_is_only_data_and_paths_cannot_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'photo.jpg').write_bytes(b'fixture')
            extra = '<script>throw new Error("execute")</script><div class="media media_photo"><a href="photo.jpg"><img src="../../secret"></a><a href="https://example.test/image">external</a></div>'
            m = self.parse(message(3, 'НПЗ<script>BAD</script> <img src="bad" onerror="BAD()">', extra), root).messages[0]
            self.assertNotIn('BAD', m['text'])
            refs = m['media'][0]['references']
            self.assertTrue(refs[0]['local_file_present'])
            self.assertFalse(refs[1]['safe_local_path'])
            self.assertFalse(refs[2]['local_file_present'])
            self.assertIsNone(tg.local_reference(root, '%2e%2e/secret'))
            self.assertIsNone(tg.local_reference(root, 'file:///etc/passwd'))

    def test_full_run_numeric_file_order_hashes_and_no_silent_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'export'; source.mkdir()
            output = root / 'private'
            for name, ident in [('messages10.html', 10), ('messages2.html', 2), ('messages.html', 1)]:
                (source / name).write_text(message(ident, f'НПЗ report {ident}'), encoding='utf-8')
            with patch.object(tg, 'OUTPUT', output):
                manifest = tg.run(source)
            self.assertEqual([f['file'] for f in manifest['files']], ['messages.html', 'messages2.html', 'messages10.html'])
            self.assertEqual(manifest['candidate_count'], 3)
            self.assertEqual(manifest['excluded_unique_row_count'], 0)
            self.assertEqual(manifest['files'][0]['sha256'], sha256((source / 'messages.html').read_bytes()).hexdigest())
            self.assertEqual([r['id'] for r in json.loads((output / 'candidates.json').read_text())], [1, 2, 10])
            (source / 'messages2.html').write_text(message(1, 'duplicate ID'), encoding='utf-8')
            previous = (output / 'manifest.json').read_bytes()
            with patch.object(tg, 'OUTPUT', output), self.assertRaises(ValueError):
                tg.run(source)
            self.assertEqual((output / 'manifest.json').read_bytes(), previous)

    def test_military_and_fundraising_excluded_but_civilian_claim_unapproved(self):
        rows = self.parse(message(1, 'Склад боеприпасов') + message(2, 'Ozon склад пожар') + message(3, 'НПЗ сбор средств') + message(4, 'Нефтебаза') + message(5, 'Электростанция')).messages
        candidates, reasons = tg.retrieve(rows)
        self.assertEqual([m['id'] for m in candidates], [2])
        self.assertEqual(candidates[0]['approval_status'], 'unapproved_retrieval_only')
        self.assertEqual(reasons['military_depot_or_target'], 1)
        self.assertEqual(reasons['fundraising_or_recruiting'], 1)
        self.assertEqual(reasons['no_category_keyword'], 2)


if __name__ == '__main__':
    unittest.main()
