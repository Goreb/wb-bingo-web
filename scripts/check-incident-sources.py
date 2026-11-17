#!/usr/bin/env python3
"""Bounded source discovery; no facility writes, approvals, or public source text."""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import urllib.error
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 2_000_000
TERMS = re.compile(r'warehouse|logistic|refiner|oil well|data\s?cent(?:er|re)|military facility|defen[cs]e (?:plant|production|factory)|government building|drone (?:plant|production|factory)|robotics? (?:plant|production|factory)|industrial (?:plant|production|factory)|titanium (?:plant|works)|rubber (?:plant|works)|ozon|wildberries|склад|логист|нефт|нпз|дата.?центр|цод|военн(?:ый|ая) объект|оборонн(?:ый|ая) завод|правительственн(?:ое|ый) здание|производств.{0,20}беспилот|робототехнич|промышленн.{0,20}завод|титан.{0,12}завод|резин.{0,12}завод|озон|вайлдбер|reopen|reconstruct|correction|возобнов|восстанов|опроверж|уточнен', re.I)
BLOCKS = re.compile(r'access denied|verify you are human|just a moment|captcha|enable javascript and cookies', re.I)
VOID = {'br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'embed', 'area', 'base', 'col', 'param', 'track'}


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)


def read(path, default):
    return json.loads(path.read_text()) if path.exists() else default


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for c in self.children:
            if isinstance(c, Node):
                yield from c.walk()

    def text(self):
        if self.tag in {'script', 'style'}:
            return ''
        return ' '.join(c.text() if isinstance(c, Node) else c for c in self.children)


class Page(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs)
        self.stack[-1].children.append(n)
        if tag not in VOID:
            self.stack.append(n)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def same_domain(url, domains):
    p = urlsplit(url)
    return p.scheme == 'https' and not p.username and any(p.hostname == d or (p.hostname or '').endswith('.' + d) for d in domains)


def extract(html, source):
    page = Page(html)
    items = {}
    if source.get('telegram'):
        for n in page.root.walk():
            post = n.attrs.get('data-post', '')
            if not re.fullmatch(r'supernova_plus/\d+', post):
                continue
            texts = [x.text() for x in n.walk() if 'tgme_widget_message_text' in x.attrs.get('class', '').split()]
            dates = [x.attrs.get('datetime') for x in n.walk() if x.tag == 'time' and x.attrs.get('datetime')]
            text = ' '.join(' '.join(texts).split())
            ident = int(post.split('/')[1])
            items[str(ident)] = {'id': ident, 'url': 'https://t.me/' + post, 'published_at': dates[0] if dates else None, 'text': text}
    else:
        for n in page.root.walk():
            if n.tag != 'a' or not n.attrs.get('href'):
                continue
            url = urljoin(source['url'], n.attrs['href'])
            if not same_domain(url, source['domains']):
                continue
            p = urlsplit(url)
            url = urlunsplit((p.scheme, p.netloc, p.path, '', ''))
            text = ' '.join(n.text().split())
            if p.path.strip('/') and len(text) >= 15:
                items[url] = {'url': url, 'text': text, 'published_at': None}
    return list(items.values())


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not same_domain(newurl, self.domains):
            raise ValueError('cross-domain redirect refused')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, cached, source, timeout):
    headers = {'User-Agent': 'BingoSourceDiscovery/1.0', 'Accept': 'text/html', 'Accept-Encoding': 'identity'}
    if cached.get('etag'):
        headers['If-None-Match'] = cached['etag']
    if cached.get('last_modified'):
        headers['If-Modified-Since'] = cached['last_modified']
    redirect = SafeRedirect()
    redirect.domains = source['domains']
    try:
        with build_opener(redirect).open(Request(url, headers=headers), timeout=timeout) as response:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError('response exceeds size cap')
            if 'html' not in response.headers.get('Content-Type', '').lower():
                raise ValueError('response is not HTML')
            html = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
            return html, {'etag': response.headers.get('ETag'), 'last_modified': response.headers.get('Last-Modified')}
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and cached.get('html'):
            return cached['html'], cached
        raise


def facility_matches(text, facilities):
    """Conservative retrieval hints, not resolved identity; never operator alone."""
    hay = ' '.join(re.findall(r'[^\W_]+', text.casefold()))
    matches = []
    # Small explicit transliteration bridge, never a claim of exhaustive aliases.
    bridges = {'aleksin': 'алексин', 'rostov': 'ростов', 'taganrog': 'таганрог',
               'shushary': 'шушар', 'koledino': 'коледин', 'istra': 'истр',
               'pushkino': 'пушкин', 'kstovo': 'кстов', 'ukhta': 'ухт',
               'tuapse': 'туапс', 'ryazan': 'рязан', 'novoshakhtinsk': 'новошахтинск'}
    operators = {'yandex': ('яндекс',), 'ozon': ('озон',), 'wildberries': ('вайлдберриз', 'вб', 'wb')}
    expanded = text.casefold()
    for english, russian in bridges.items():
        if russian in expanded:
            hay += ' ' + english
    for english, aliases in operators.items():
        if any(re.search(r'(?<!\w)' + re.escape(alias) + r'(?!\w)', expanded) for alias in aliases):
            expanded += ' ' + english
    generic = {'refinery', 'warehouse', 'data', 'center', 'centre', 'group', 'oil', 'well', 'logistics', 'hub', 'military', 'facility', 'defence', 'defense', 'manufacturing', 'government', 'building', 'drone', 'robotics', 'industrial', 'plant', 'factory', 'production', 'wildberries', 'ozon', 'yandex', 'нефтезавод', 'склад', 'нпз', 'завод', 'объект', 'производство', 'военный', 'оборонный'}
    for facility in facilities:
        aliases = facility.get('aliases', [])
        if not isinstance(aliases, list):
            aliases = []
        names = [facility.get('name', '')] + [x for x in aliases if isinstance(x, str)]
        matched = None
        for name in names:
            tokens = re.findall(r'[^\W_]+', name.casefold())
            distinctive = [x for x in tokens if len(x) >= 5 and x not in generic]
            if distinctive and any(re.search(r'(?<!\w)' + re.escape(x) + r'(?!\w)', hay) for x in distinctive):
                matched = 'distinctive name/alias token: ' + next(x for x in distinctive if re.search(r'(?<!\w)' + re.escape(x) + r'(?!\w)', hay))
                break
        operator = facility.get('operator') or ''
        town = facility.get('town') or facility.get('city') or ''
        if not matched and len(operator) >= 3 and len(town) >= 4 and operator.casefold() in expanded and town.casefold() in hay:
            matched = 'operator and town both present'
        if matched:
            matches.append({'facility_id': facility['id'], 'reason': matched})
    return matches


def load_facilities(root):
    records = {}
    for filename in ('facilities.json', 'data/unreviewed-facilities.json', 'data/reviewed-facilities.json'):
        for row in read(root / filename, []):
            records[row['id']] = row
    return list(records.values())


def check(source, state, queue, fetcher=fetch, timeout=15, facilities=()):
    result = {'name': source['name'], 'url': source['url'], 'checked_at': now(), 'status': 'failed',
              'pages_checked': 0, 'items_observed': 0, 'new_leads': 0, 'matched_leads': 0, 'changed': False,
              'coverage': 'Bounded listing discovery only; completeness and event absence not established.'}
    old_cursor = state.get('cursor')
    result['cursor_before'] = old_cursor
    pages = state.setdefault('pages', {})
    all_items = []
    cursor = old_cursor
    try:
        for index in range(2 if source.get('telegram') and old_cursor else 1):
            url = source['url'] + ('?after=' + str(cursor) if source.get('telegram') and cursor else '')
            cached = pages.get(url, {})
            html, metadata = fetcher(url, cached, source, timeout)
            result['pages_checked'] += 1
            if BLOCKS.search(html[:100000]):
                result.update(status='blocked', error='Source returned an access challenge.')
                break
            digest = sha256(html.encode()).hexdigest()
            items = cached.get('items', []) if digest == cached.get('fingerprint') else extract(html, source)
            if not items:
                result.update(status='limited', error='No readable listing items; JS, markup, empty feed or access limitation possible.')
                break
            result['changed'] |= digest != cached.get('fingerprint')
            pages[url] = {k: metadata.get(k) for k in ('etag', 'last_modified')}
            pages[url].update(html=html, fingerprint=digest, items=items)
            all_items.extend(items)
            result['status'] = 'success'
            if not source.get('telegram'):
                break
            ids = [x['id'] for x in items]
            advancing = max(ids) > (cursor or 0)
            cursor = max(max(ids), cursor or 0)
            if not advancing:
                break
        state['last_check'] = result['checked_at']
    except Exception as exc:
        result['status'] = 'blocked' if isinstance(exc, urllib.error.HTTPError) and exc.code in (401, 403, 429) else 'failed'
        result['error'] = ('HTTP ' + str(exc.code)) if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__ + ': retrieval or parsing failed'
    # Retain successful earlier pages even if a later page failed.
    for item in all_items:
        matches = facility_matches(item['text'], facilities)
        if TERMS.search(item['text']) or matches:
            key = sha256((item['url'] + '\n' + item['text'] + '\n' + str(item.get('published_at'))).encode()).hexdigest()
            if key not in queue:
                queue[key] = dict(item, source=source['name'], discovered_at=now(), state='pending', approval='none',
                                  matched_facility_ids=[m['facility_id'] for m in matches], match_reasons=matches,
                                  routing='entity_match' if matches else 'unmatched_relevant')
                result['new_leads'] += 1
                if matches:
                    result['matched_leads'] += 1
    if cursor:
        state['cursor'] = cursor
    result['items_observed'] = len({x['url'] for x in all_items})
    if source.get('telegram'):
        result['coverage'] = 'At most two public pages; ?after support, contiguous history and full catch-up are unverified. Gaps, edits and deletions may be missed.'
        result['catchup_complete'] = False
    # Keep bounded page cache (one or two current request variants).
    state['pages'] = dict(list(pages.items())[-2:])
    result['cursor_after'] = state.get('cursor')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--timeout', type=float, default=15)
    args = parser.parse_args()
    if not 0 < args.timeout <= 60:
        parser.error('timeout must be between zero and 60 seconds')
    runtime = args.root / 'pipeline/runtime/source-checks'
    sources = read(args.root / 'data/trusted-sources.json', {})['sources']
    sources.append({'name': 'Supernova+', 'url': 'https://t.me/s/supernova_plus', 'domains': ['t.me'], 'telegram': True})
    state = read(runtime / 'checkpoints.json', {})
    queue = read(runtime / 'pending-leads.json', {})
    facilities = load_facilities(args.root)
    results = []
    for source in sources:
        results.append(check(source, state.setdefault(source['url'], {}), queue, timeout=args.timeout, facilities=facilities))
        # Queue first: a crash may replay discovery but must never skip unsaved leads.
        save(runtime / 'pending-leads.json', queue)
        save(runtime / 'checkpoints.json', state)
    public = {'schema_version': 1, 'checked_at': now(), 'purpose': 'Discovery only; no automatic approval',
              'changed_source_count': sum(r['changed'] for r in results),
              'new_lead_count': sum(r['new_leads'] for r in results),
              'new_matched_lead_count': sum(r['matched_leads'] for r in results),
              'pending_lead_count': sum(x.get('state') == 'pending' for x in queue.values()), 'sources': results}
    save(args.root / 'data/source-check-status.json', public)
    return 0 if all(r['status'] == 'success' for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
