#!/usr/bin/env python3
"""Build an explicit public-only Cloudflare Pages directory; never upload repo root."""
import hashlib
import json
import re
import shutil
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'pipeline/runtime/pages-site'
FILES = ['img/flags/sources.json', 'img/flags/ATTRIBUTION.txt', *[f'img/flags/{name}.svg' for name in ['tatarstan','dagestan','bashkortostan','udmurtia','mari-el','russia','ukraine']], 'img/brands/ozon.svg', 'img/brands/wildberries.svg', 'img/brands/README.md', 'latest-update.js', 'status.js', 'index.html', 'app.js', 'display.js', 'facility-status.js', 'incident-groups.js', 'card-design.css', 'data.js', 'reports.js', 'gallery.js', 'preferences.js', 'overview-map.js', 'third_party/leaflet/leaflet.js', 'third_party/leaflet/leaflet.css', 'third_party/leaflet/LICENSE', 'styles.css',
         'project-status.html', 'project-status.js', 'project-status.css', 'LICENSE']
DATA = ['data/status-claims.json', 'data/map-locations.json', 'data/catalog.json', 'data/reviewed-facilities.json', 'data/unreviewed-facilities.json',
        'data/unapproved-reports.json', 'data/report-approvals.json', 'data/report-media.json', 'data/trusted-sources.json', 'data/photo-thumbnails.json', 'data/source-check-status.json', 'data/update-status.json', 'project-status.json']

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

def public_projection(value):
    if isinstance(value, list):
        return [public_projection(item) for item in value]
    if isinstance(value, dict):
        return {key: public_projection(item) for key, item in value.items()
                if key not in {'coordinates', 'distance_border_km', 'latitude', 'longitude', 'lat', 'lon'}}
    return value

def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for name in FILES:
        (OUT / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, OUT / name)
    for name in DATA:
        write_json(OUT / name, public_projection(json.loads((ROOT / name).read_text())))
    legacy = public_projection(json.loads((ROOT / 'facilities.json').read_text()))
    for record in legacy:
        # Upstream imagery/precise map URLs are not part of the town-only public edition.
        record.pop('image_url', None)
        record['sources'] = [source for source in record.get('sources', [])
                             if not any(term in (source.get('url') or '').lower()
                                        for term in ['lat=', 'lng=', 'lon=', 'google.com/maps', 'openstreetmap.org', 'browser.dataspace.copernicus.eu'])]
    write_json(OUT / 'facilities.json', legacy)
    reports = json.loads((OUT / 'data/unapproved-reports.json').read_text())
    photos = {}
    for incident in reports['incidents']:
        for update in incident['updates']:
            for photo in update.get('photos', []):
                name = photo['path']
                if not re.fullmatch(r'img/reports/tg-[1-9][0-9]*-[a-f0-9]{12}\.jpg', name):
                    raise ValueError('Unexpected report asset path')
                content = (ROOT / name).read_bytes()
                if hashlib.sha256(content).hexdigest() != photo['sha256']:
                    raise ValueError('Report asset hash mismatch')
                photos[name] = content
    thumbnails = json.loads((ROOT / 'data/photo-thumbnails.json').read_text())
    for original, item in thumbnails['photos'].items():
        if original not in photos or hashlib.sha256(photos[original]).hexdigest() != item['source_photo_sha256']:
            raise ValueError('Thumbnail original mismatch')
        if not re.fullmatch(r'img/reports/thumb-[a-f0-9]{16}\.jpg', item['path']):
            raise ValueError('Unsafe thumbnail path')
        content = (ROOT / item['path']).read_bytes()
        if hashlib.sha256(content).hexdigest() != item['sha256']:
            raise ValueError('Thumbnail hash mismatch')
        photos[item['path']] = content
    media = json.loads((ROOT / 'data/report-media.json').read_text())
    items = [item for group in media['by_post'].values() for item in group] + [item for group in media.get('facility_photos', {}).values() for item in group]
    for item in items:
        for key, hash_key in [('src', 'sha256'), ('thumbnail', 'thumbnail_sha256')]:
            name = item.get(key)
            if not name: continue
            if not re.fullmatch(r'(?:img/reports/[A-Za-z0-9_-]+\.jpg|media/reports/[A-Za-z0-9_-]+\.(?:mp4|webm))', name):
                raise ValueError('Unsafe gallery asset path')
            content = (ROOT / name).read_bytes()
            if hashlib.sha256(content).hexdigest() != item.get(hash_key):
                raise ValueError('Gallery asset hash mismatch')
            if len(content) > 20_000_000:
                raise ValueError('Gallery asset exceeds this build size budget')
            photos[name] = content
    for name, content in photos.items():
        target = OUT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (OUT / '_headers').write_text('/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n/*.json\n  Cache-Control: no-cache\n/data/*.json\n  Cache-Control: no-cache\n')
    published = [path for path in OUT.rglob('*') if path.is_file()]
    assert not any(path.name.startswith('.') or path.suffix in {'.sqlite3', '.py', '.toml'} for path in published)
    print(f'Built {len(published)} public files, {len(photos)} photo assets (including thumbnails), {sum(p.stat().st_size for p in published):,} bytes at {OUT}')

if __name__ == '__main__':
    main()
