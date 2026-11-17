#!/usr/bin/env python3
"""Offline, private Telegram HTML export extraction. Never executes source HTML.

Candidates are keyword retrieval suggestions, never verified facilities or public
output. The fixed destination is git-ignored pipeline/runtime/telegram-export.
"""
import argparse
from collections import Counter
from datetime import datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'pipeline/runtime/telegram-export'
VOID = {'br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'embed', 'area', 'base', 'col', 'param', 'track'}


class Node:
    def __init__(self, tag, attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    @property
    def classes(self):
        return set(self.attrs.get('class', '').split())

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        if self.tag in {'script', 'style'}:
            return ''
        if self.tag == 'br':
            return '\n'
        return ''.join(c.text() if isinstance(c, Node) else c for c in self.children)


def clean(text):
    return '\n'.join(re.sub(r'[^\S\n]+', ' ', line).strip() for line in text.splitlines()).strip()


def normalized(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).strip()


def local_reference(root, reference):
    """Resolve only paths inside export; do not fetch URLs or follow escapes."""
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    candidate = (root / unquote(parsed.path)).resolve()
    if not candidate.is_relative_to(root.resolve()):
        return None
    return candidate


def timestamp(value):
    try:
        return datetime.strptime(value, '%d.%m.%Y %H:%M:%S UTC%z').isoformat()
    except ValueError:
        return None


def extract(node, filename, root):
    ident = int(node.attrs['id'][7:])
    all_nodes = list(node.walk())
    forwarded = [n for n in all_nodes if {'forwarded', 'body'} <= n.classes]
    forwarded_nodes = {id(n) for f in forwarded for n in f.walk()}
    dates = [n for n in all_nodes if 'date' in n.classes and n.attrs.get('title') and id(n) not in forwarded_nodes]
    own_date = next((n for n in dates if n.tag == 'div'), None)
    date_raw = own_date.attrs['title'] if own_date else None
    texts = [n for n in all_nodes if n.tag == 'div' and 'text' in n.classes]
    text = '\n'.join(clean(n.text()) for n in texts).strip()
    links = [n.attrs['href'] for t in texts for n in t.walk() if n.tag == 'a' and 'href' in n.attrs]
    replies = [n.attrs['href'] for r in all_nodes if 'reply_to' in r.classes for n in r.walk() if 'href' in n.attrs]
    media_nodes = [n for n in all_nodes if any(c.startswith('media_') and c != 'media_wrap' for c in n.classes)]
    # Real exports may instead have linked photos and thumbnails.
    for n in all_nodes:
        if n.tag == 'a' and {'photo_wrap', 'video_file_wrap', 'document_wrap'} & n.classes and n not in media_nodes:
            media_nodes.append(n)
    media = []
    for n in media_nodes:
        refs = list(dict.fromkeys(c.attrs[a] for c in n.walk() for a in ('href', 'src') if a in c.attrs))
        checked = []
        for ref in refs:
            path = local_reference(root, ref)
            checked.append({'reference': ref, 'local_file_present': bool(path and path.is_file()), 'safe_local_path': bool(path)})
        media.append({'kind': next((c[6:] for c in sorted(n.classes) if c.startswith('media_')), 'photo' if 'photo_wrap' in n.classes else 'attachment'),
                      'not_included_placeholder': 'Not included' in n.text(), 'references': checked})
    forwards = []
    for f in forwarded:
        author = next((n for n in f.walk() if 'from_name' in n.classes), None)
        fd = next((n.attrs['title'] for n in f.walk() if 'date' in n.classes and n.attrs.get('title')), None)
        forwards.append({'attribution': clean(author.text()) if author else None, 'timestamp_raw': fd, 'timestamp': timestamp(fd) if fd else None})
    return {'id': ident, 'post_url': f'https://t.me/supernova_plus/{ident}', 'source_file': filename,
            'timestamp_raw': date_raw, 'timestamp': timestamp(date_raw) if date_raw else None,
            'text': text, 'links': links, 'reply_references': replies,
            'reply_message_ids': sorted({int(match.group(1)) for ref in replies if (match := re.search(r'(?:go_to_message|#message)(\d+)', ref))}), 'joined': 'joined' in node.classes,
            'forwarded_metadata': forwards, 'media': media}


class ExportParser(HTMLParser):
    def __init__(self, filename, root):
        super().__init__(convert_charrefs=True)
        self.filename, self.root, self.stack, self.messages = filename, root, [], []
        self.service_count = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get('class', '').split())
        if not self.stack:
            if tag != 'div' or 'message' not in classes:
                return
            if 'service' in classes:
                self.service_count += 1
            if 'default' not in classes or not re.fullmatch(r'message\d+', attrs.get('id', '')):
                return
        node = Node(tag, attrs.items())
        if self.stack:
            self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self.stack or tag in VOID:
            return
        matching = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i].tag == tag), None)
        if matching is None:
            return
        root_node = self.stack[0]
        del self.stack[matching:]
        if not self.stack:
            self.messages.append(extract(root_node, self.filename, self.root))

    def handle_data(self, data):
        if self.stack:
            self.stack[-1].children.append(data)


CATEGORIES = {
    'refineries': r'нпз|нефтеперераб|нафтоперероб|refiner',
    'warehouses': r'склад|озон|ozon|wildberries|вайлдбер|вайлдбер|валбер|\bwb\b|вб\b|warehouse',
    'logistics_hubs': r'логист|логіст|распределительн.{0,15}центр|розподільч.{0,15}центр|сортировочн.{0,15}центр|logistic',
    'data_centers': r'дата.?центр|дата.?центре|центр.{0,15}обработки данных|\bцод\b|data.?cent[er]',
    'individual_oil_wells': r'скважин|свердловин|oil well',
}
EXCLUSIONS = {
    'military_depot_or_target': r'склад.{0,35}(боеприпас|боєприпас|боекомплект|бк\b|военн|військ|ракет|оруж|збро)|(?:военн|військ|артиллерийск|артилерійськ).{0,20}склад|арсенал|пункт.{0,15}(дислокац|управления)|военкомат',
    'fundraising_or_recruiting': r'сбор.{0,20}(средств|донат)|збір.{0,20}(кошт|донат)|задонат|募|вступай.{0,20}(полк|бригад)|набор.{0,20}(добровольц|контракт)',
    'explicit_live_targeting': r'координат.{0,30}(цели|цілі|переда|скид)|присылайте.{0,30}(позици|координат)|надсилайте.{0,30}(позиці|координат)|куда.{0,15}ударить',
}


def deduplicate(messages):
    groups, rows = {}, []
    for m in sorted(messages, key=lambda m: m['id']):
        key = normalized(m['text'])
        # Empty album/media messages are distinct evidence, never text duplicates.
        if key and key in groups:
            groups[key]['duplicate_posts'].append({'id': m['id'], 'post_url': m['post_url'], 'timestamp': m['timestamp'], 'source_file': m['source_file']})
        else:
            row = dict(m, duplicate_posts=[])
            rows.append(row)
            if key:
                groups[key] = row
    return rows


def retrieve(rows):
    candidates, reasons = [], Counter()
    for row in rows:
        text = row['text'].casefold()
        cats = [cat for cat, pattern in CATEGORIES.items() if re.search(pattern, text)]
        if not cats:
            reasons['no_category_keyword'] += 1
            continue
        excluded = [reason for reason, pattern in EXCLUSIONS.items() if re.search(pattern, text)]
        if excluded:
            for reason in excluded:
                reasons[reason] += 1
            continue
        flags = []
        if re.search(r'\b\d{2}\.\d{4,}\s*[,; ]\s*\d{2}\.\d{4,}', text):
            flags.append('possible_precise_coordinates_private_only')
        candidates.append(dict(row, retrieval_categories=cats, approval_status='unapproved_retrieval_only', publication_holds=flags + ['semantic_safety_and_source_review_required']))
    return candidates, dict(sorted(reasons.items()))


def run(source):
    source = Path(source).resolve()
    files = sorted((p for p in source.iterdir() if re.fullmatch(r'messages(?:\d+)?\.html', p.name)), key=lambda p: int(re.search(r'\d+', p.stem)[0]) if re.search(r'\d+', p.stem) else 1)
    if not files:
        raise ValueError('No matching Telegram HTML files')
    messages, file_manifest = [], []
    for path in files:
        if not path.resolve().is_relative_to(source):
            raise ValueError('Export HTML escapes source directory')
        raw = path.read_bytes()
        parser = ExportParser(path.name, source)
        parser.feed(raw.decode('utf-8-sig'))
        parser.close()
        if parser.stack:
            raise ValueError(f'Unclosed message in {path.name}')
        messages.extend(parser.messages)
        file_manifest.append({'file': path.name, 'bytes': len(raw), 'sha256': sha256(raw).hexdigest(), 'message_count': len(parser.messages), 'service_count': parser.service_count})
    ids = [m['id'] for m in messages]
    if len(ids) != len(set(ids)):
        raise ValueError('Repeated message IDs across export; inspect before proceeding')
    rows = deduplicate(messages)
    candidates, rejected = retrieve(rows)
    dates = sorted(m['timestamp'] for m in messages if m['timestamp'])
    media = [a for m in messages for a in m['media']]
    references = [dict(message_id=m['id'], **ref) for m in messages for a in m['media'] for ref in a['references']]
    manifest = {'schema_version': 1, 'source_channel': 'https://t.me/supernova_plus', 'private_runtime_only': True,
                'files': file_manifest, 'html_file_count': len(files), 'message_count': len(messages), 'unique_text_or_empty_message_count': len(rows),
                'exact_duplicate_post_count': len(messages)-len(rows), 'candidate_count': len(candidates), 'retrieval_exclusion_counts': rejected, 'excluded_unique_row_count': len(rows) - len(candidates),
                'posting_date_range': {'first': dates[0] if dates else None, 'last': dates[-1] if dates else None},
                'missing_or_invalid_posting_timestamp_count': sum(not m['timestamp'] for m in messages),
                'media': {'attachment_elements': len(media), 'not_included_placeholders': sum(a['not_included_placeholder'] for a in media), 'references': references,
                          'present_local_references': sum(r['local_file_present'] for r in references), 'kinds': dict(Counter(a['kind'] for a in media))},
                'limitations': ['Retrieval patterns do not establish a named facility, truth, incident date, civilian status or publication safety.',
                               'Candidates and source text remain private and unapproved; semantic review must remove tactical details and private identifiers before any public projection.',
                               'Joined messages are preserved individually; joined is an export layout hint and does not prove album or event membership.',
                               'Exact whitespace-normalized repeats are grouped; dates, corrections and other differing texts are not fuzzily deleted.',
                               'Forward timestamps remain separate from posting timestamps. Neither necessarily establishes event date.',
                               'Media placeholders do not prove files or photos are available. Local path existence does not verify content or authenticity.',
                               'Keyword exclusions are conservative retrieval decisions and may miss relevant reports. No messages are deleted from messages.json.',
                               'No external URLs are fetched; scripts, styles and HTML handlers are never executed.']}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, payload in [('messages.json', messages), ('candidates.json', candidates), ('manifest.json', manifest)]:
        target = OUTPUT / name
        temporary = target.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(target)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    result = run(args.source)
    print(json.dumps({key: result[key] for key in ('html_file_count', 'message_count', 'exact_duplicate_post_count', 'candidate_count', 'posting_date_range')}))
