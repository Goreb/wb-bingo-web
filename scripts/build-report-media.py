#!/usr/bin/env python3
"""Build galleries from exact-post media previously inspected in the supplied export."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KNOWN_PHOTOS = {}

def read(name):
    return json.loads((ROOT / name).read_text())

def clean_jpeg(data):
    if data[:2] != b'\xff\xd8':
        raise ValueError('Not JPEG')
    out = bytearray(data[:2]); pos = 2
    while pos < len(data):
        start = pos
        if data[pos] != 255: raise ValueError('Invalid JPEG marker')
        while data[pos] == 255: pos += 1
        marker = data[pos]; pos += 1
        if marker in (0xda, 0xd9):
            out.extend(data[start:]); return bytes(out)
        if marker in (0x01, *range(0xd0, 0xd8)):
            out.extend(data[start:pos]); continue
        length = int.from_bytes(data[pos:pos+2], 'big'); end = pos + length
        if length < 2 or end > len(data): raise ValueError('Invalid JPEG length')
        if marker not in (0xe1, 0xed, 0xfe): out.extend(data[start:end])
        pos = end
    raise ValueError('Incomplete JPEG')

def asset(data, prefix):
    data = clean_jpeg(data)
    digest = hashlib.sha256(data).hexdigest()
    if prefix == 'gallery' and digest in KNOWN_PHOTOS:
        return KNOWN_PHOTOS[digest], digest
    name = f'img/reports/{prefix}-{digest[:16]}.jpg'
    (ROOT / name).write_bytes(data)
    return name, digest

def main():
    reports = read('data/unapproved-reports.json')['incidents']
    updates = {u['post_id']: (r,u) for r in reports for u in r['updates']}
    KNOWN_PHOTOS.update({p['sha256']:p['path'] for r in reports for u in r['updates'] for p in u.get('photos',[])})
    decisions = {x['index']: x for x in read('data/import-assessments/telegram-photo-selection-20261019.json')['selection_decisions']}
    manifest = {'schema_version': 1, 'by_post': {}, 'facility_photos': read('data/report-media.json').get('facility_photos', {}) if (ROOT/'data/report-media.json').exists() else {}}
    for item in read('pipeline/runtime/telegram-export/photo-candidates.json'):
        decision = decisions[item['index']]
        # Prior AI visual inspection excluded maps, unrelated images and memes.
        if decision['decision'] != 'selected' and not decision.get('reason','').startswith('alternate image for same incident'):
            continue
        if item['post_id'] not in updates: continue
        report, update = updates[item['post_id']]
        source = Path(item['path']); raw = source.read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']: raise ValueError('Source changed')
        src, digest = asset(raw, 'gallery')
        thumb_source = source.parent.parent / 'Thumbmails' / (source.stem + '_thumb.jpg')
        thumb, thumb_digest = asset(thumb_source.read_bytes(), 'thumb') if thumb_source.exists() else (src, digest)
        media = {'kind':'image','src':src,'sha256':digest,'thumbnail':thumb,'thumbnail_sha256':thumb_digest,'source_url':update['source_url'],'caption':f"Source photo · {report['facility_name']} · posted {update['posted_at'][:10]}",'media_verification':'unverified'}
        manifest['by_post'].setdefault(str(item['post_id']),[]).append(media)
    original = {p['id']:p for p in read('pipeline/runtime/telegram-export/messages.json')}
    for pid,(report,update) in updates.items():
        if any(m['kind']=='video' for m in original.get(pid,{}).get('media',[])):
            manifest['by_post'].setdefault(str(pid),[]).append({'kind':'telegram_video','source_url':update['source_url'],'caption':f"Telegram video · {report['facility_name']} · posted {update['posted_at'][:10]}",'media_verification':'unverified'})
    (ROOT/'data/report-media.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    all_items=[m for items in manifest['by_post'].values() for m in items]
    print('Gallery media:',sum(m['kind']=='image' for m in all_items),'images;',sum(m['kind']=='telegram_video' for m in all_items),'Telegram video source posts; no local video files present.')

if __name__ == '__main__': main()
