#!/usr/bin/env python3
"""Import first official 3data facility gallery images as attributed card media."""
import hashlib
import html
import json
import argparse
import os
import re
import tempfile
import urllib.request
from datetime import date
from pathlib import Path

from PIL import Image
from io import BytesIO

ROOT = Path(__file__).resolve().parents[1]
FACILITIES = {
    "RU-DC-002": "s21", "RU-DC-003": "a35", "RU-DC-004": "bp54",
    "RU-DC-005": "e2", "RU-DC-006": "u8", "RU-DC-007": "n10",
    "RU-DC-008": "nr26", "RU-DC-009": "sk19", "RU-DC-010": "mr4",
    "RU-DC-011": "b17", "RU-DC-012": "m8", "RU-DC-013": "la107",
    "RU-DC-014": "bm1", "RU-DC-015": "sa107", "RU-DC-016": "nsk",
    "RU-DC-017": "n37", "RU-DC-026": "z8", "RU-DC-027": "hsm",
}
HEADERS = {"User-Agent": "Bingo facility media importer/1.0"}


def write_json_atomic(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=path.name + ".", suffix=".tmp",
                                     delete=False) as temp:
        temp.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        temp_path = Path(temp.name)
    os.replace(temp_path, path)


def get(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def store_jpeg(image_url, lead_only=False):
    """Download, normalize and hash an official image; also build its card thumbnail."""
    raw = get(image_url)
    image = Image.open(BytesIO(raw)).convert("RGB")
    main_bytes = BytesIO()
    image.save(main_bytes, format="JPEG", quality=92, optimize=True)
    data = main_bytes.getvalue()
    digest = hashlib.sha256(data).hexdigest()
    prefix = "lead" if lead_only else "facility"
    rel = f"img/reports/{prefix}-{digest[:16]}.jpg"
    target = ROOT / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data)
    thumb_img = image.copy()
    thumb_img.thumbnail((480, 300), Image.Resampling.LANCZOS)
    thumb_bytes = BytesIO()
    thumb_img.save(thumb_bytes, format="JPEG", quality=85, optimize=True)
    thumb_data = thumb_bytes.getvalue()
    thumb_hash = hashlib.sha256(thumb_data).hexdigest()
    thumb_rel = f"img/reports/thumb-{thumb_hash[:16]}.jpg"
    thumb_path = ROOT / thumb_rel
    if not thumb_path.exists():
        thumb_path.write_bytes(thumb_data)
    return image, rel, digest, thumb_rel, thumb_hash


def add_facility_photo(manifest, facility_id, facility_name, page_url, image_url,
                       operator, label, caption=None):
    image, rel, digest, thumb, thumb_hash = store_jpeg(image_url)
    entry = {
        "kind": "image", "src": rel, "sha256": digest,
        "thumbnail": thumb, "thumbnail_sha256": thumb_hash,
        "source_url": page_url, "source_image_url": image_url,
        "source_label": label,
        "caption": caption or f"Operator source photo · {facility_name}",
        "media_verification": "source_attributed",
        "credit": f"{operator} — official facility page",
    }
    old = manifest.get("facility_photos", {}).get(facility_id, [])
    preserved = [item for item in old if item.get("sha256") != digest]
    manifest.setdefault("facility_photos", {})[facility_id] = [entry, *preserved]
    return image, {"facility_id": facility_id, "facility_name": facility_name,
                   "page_url": page_url, "selected_image_url": image_url,
                   "sha256": digest, "dimensions": list(image.size),
                   "asset": rel, "thumbnail": thumb, "status": "imported"}


class ImageTags:
    """Small stdlib-only HTML image-tag parser for public operator pages."""
    from html.parser import HTMLParser as _HTMLParser
    class Parser(_HTMLParser):
        def __init__(self):
            super().__init__()
            self.items = []
        def handle_starttag(self, tag, attrs):
            if tag.lower() == "img":
                self.items.append(dict(attrs))


def parse_images(page):
    parser = ImageTags.Parser()
    parser.feed(page)
    return parser.items


def import_keypoint(manifest, facilities):
    """Discover Key Point facility pages from catalogue sources and its official index."""
    known_pages = {
        "RU-DC-016": "https://keypoint-group.ru/cod/novosibirsk/",
        "RU-DC-017": "https://keypoint-group.ru/cod/vladivostok/",
    }
    for facility in facilities:
        fid = facility["id"]
        for source in facility.get("sources", []):
            url = source.get("url", "")
            if "keypoint-group.ru/cod/" in url and url.rstrip("/").split("/")[-1] != "cod":
                known_pages.setdefault(fid, url if url.endswith("/") else url + "/")
    index_url = "https://keypoint-group.ru/cod/"
    index = get(index_url).decode("utf-8", "replace")
    discovered = sorted(set(re.findall(r'href=["\'](/cod/[a-z0-9-]+/)["\']', index, re.I)))
    slug_pages = {path.rstrip("/").split("/")[-1]: "https://keypoint-group.ru" + path for path in discovered}
    results = []
    for facility in facilities:
        fid = facility["id"]
        page_url = known_pages.get(fid)
        if not page_url:
            continue
        slug = page_url.rstrip("/").split("/")[-1]
        # Require that the official Key Point index actually links the selected page.
        if slug not in slug_pages:
            results.append({"facility_id": fid, "page_url": page_url, "status": "page_not_in_official_index"})
            continue
        page_url = slug_pages[slug]
        page = get(page_url).decode("utf-8", "replace")
        image_url = None
        # Prefer the first slide in the facility image carousel. Pages such as Vladivostok
        # also show an award badge before the carousel, so document-wide order is unsafe.
        slider = re.search(r'<div\s+class="slider"[^>]*>(.*?)</div>\s*<div\s+class="slider-nav"', page, re.I | re.S)
        image_attrs = parse_images(slider.group(1)) if slider else parse_images(page)
        # If there is no carousel, use the first operator-uploaded image, skipping logos/icons.
        for attrs in image_attrs:
            src = attrs.get("src", "") or attrs.get("data-src", "")
            if "/upload/" in src and not re.search(r"logo|icon|banner", src, re.I):
                image_url = urllib.request.urljoin(page_url, html.unescape(src))
                break
        if not image_url:
            results.append({"facility_id": fid, "page_url": page_url, "status": "facility_image_missing"})
            continue
        planned = "planned" in facility["name"].lower()
        caption = f"Operator source image · {facility['name']}"
        source_label = "Key Point official facility page ↗"
        if planned:
            caption = f"Planned facility design render · {facility['name']}"
            source_label = "Project render from Key Point official page ↗"
        # The first document image on this page is a 150px award badge, not campus media.
        # It was introduced by the earlier import attempt; remove only that exact item.
        if fid == "RU-DC-017":
            prior = manifest.get("facility_photos", {}).get(fid, [])
            manifest["facility_photos"][fid] = [item for item in prior if item.get("sha256") != "2508ad918218546b88832c7312720800666f78506535e6c9029166516443f09c"]
        image, result = add_facility_photo(
            manifest, fid, facility["name"], page_url, image_url, "Key Point",
            source_label, caption)
        result.update({"provider": "Key Point", "selection_method": "first image in official campus slider; otherwise first non-logo /upload/ image", "planned": planned})
        results.append(result)
    return {"index_url": index_url, "discovered_pages": discovered, "results": results}


def import_ixcellerate(manifest, facilities):
    """Map campus image alt text on IXcellerate's official listing to exact site IDs."""
    page_url = "https://ixcellerate.ru/data-centers/"
    page = get(page_url).decode("utf-8", "replace")
    ids = {"north": "RU-DC-020", "south": "RU-DC-021"}
    names = {f["id"]: f["name"] for f in facilities}
    found = {}
    unassigned = None
    for attrs in parse_images(page):
        alt = attrs.get("alt", "")
        if "Кампус IXcellerate" not in alt:
            continue
        src = attrs.get("src", "")
        srcset = attrs.get("srcset", "")
        choices = []
        for item in srcset.split(","):
            pieces = item.strip().split()
            if not pieces:
                continue
            width = int(pieces[1][:-1]) if len(pieces) > 1 and pieces[1].endswith("w") and pieces[1][:-1].isdigit() else 0
            choices.append((width, pieces[0]))
        if choices:
            src = max(choices)[1]
        direct = urllib.request.urljoin(page_url, html.unescape(src))
        lowered = alt.lower()
        campus = "north" if "north" in lowered else "south" if "south" in lowered else "veshki" if "vёshki" in lowered or "veshki" in lowered else None
        if campus in ids:
            found[campus] = (direct, alt)
        elif campus == "veshki":
            unassigned = (direct, alt)
    results = []
    for campus in ("north", "south"):
        fid = ids[campus]
        if campus not in found:
            results.append({"facility_id": fid, "page_url": page_url, "status": "campus_image_missing"})
            continue
        direct, alt = found[campus]
        _, result = add_facility_photo(
            manifest, fid, names[fid], page_url, direct, "IXcellerate",
            "IXcellerate campus listing ↗", f"Operator campus image · {names[fid]}")
        result.update({"provider": "IXcellerate", "campus_alt": alt,
                       "selection_method": "campus-specific image alt text and matching listing card link"})
        results.append(result)
    # Veshki now has a separate unreviewed discovery ID, confirmed outside this importer.
    lead = None
    if unassigned:
        direct, alt = unassigned
        veshki_id = "DISC-IX-VESHKI-001"
        veshki_page = "https://ixcellerate.ru/data-centers/moscow-veshki-campus/"
        discovery_rows = json.loads((ROOT / "data/unreviewed-facilities.json").read_text())
        discovery = next((f for f in discovery_rows if f.get("id") == veshki_id), None)
        if not discovery or not any(s.get("url") == veshki_page for s in discovery.get("sources", [])):
            raise ValueError("Confirmed Veshki discovery record/source is not present; refusing to attach media")
        veshki_page_content = get(veshki_page).decode("utf-8", "replace")
        # Prefer a full-size campus image on the detail page when present, otherwise
        # retain the exact campus image from the operator listing card.
        detail_image = None
        for attrs in parse_images(veshki_page_content):
            src = attrs.get("src", "") or attrs.get("data-src", "")
            alt_text = attrs.get("alt", "") + " " + attrs.get("title", "")
            if ("wp-content/uploads" in src and
                    re.search(r"\.(?:jpe?g|png|webp)(?:\?|$)", src, re.I) and
                    re.search(r"vёshki|veshki|кампус", alt_text, re.I)):
                candidates = []
                for item in attrs.get("srcset", "").split(","):
                    pieces = item.strip().split()
                    if pieces:
                        width = int(pieces[1][:-1]) if len(pieces) > 1 and pieces[1].endswith("w") and pieces[1][:-1].isdigit() else 0
                        candidates.append((width, pieces[0]))
                detail_image = urllib.request.urljoin(veshki_page, max(candidates)[1] if candidates else src)
                break
        direct = detail_image or direct
        _, result = add_facility_photo(
            manifest, veshki_id, discovery["name"], veshki_page, direct,
            "IXcellerate", "Project render from IXcellerate official campus page ↗",
            "Planned campus project render · Vёshki · unreviewed discovery record")
        result.update({"status": "attached_to_unreviewed_discovery_id",
                       "provider": "IXcellerate", "campus_alt": alt,
                       "selection_method": "Vёshki detail-page campus image, cross-checked against official campus listing card"})
        lead = result
    return {"page_url": page_url, "results": results, "unassigned_lead": lead}


def main_operators(operator="all"):
    facilities = json.loads((ROOT / "data/reviewed-facilities.json").read_text())
    manifest_path = ROOT / "data/report-media.json"
    manifest = json.loads(manifest_path.read_text())
    keypoint = import_keypoint(manifest, facilities) if operator in ("all", "keypoint") else None
    ixcellerate = import_ixcellerate(manifest, facilities) if operator in ("all", "ixcellerate") else None
    write_json_atomic(manifest_path, manifest)
    out = ROOT / "data/import-assessments/operator-photo-import-20261020.json"
    if out.exists():
        assessment = json.loads(out.read_text())
    else:
        assessment = {"scope": "Key Point and IXcellerate facility photo integration"}
    assessment["checked_at"] = date.today().isoformat()
    if keypoint is not None:
        assessment["keypoint"] = keypoint
    if ixcellerate is not None:
        assessment["ixcellerate"] = ixcellerate
    write_json_atomic(out, assessment)
    print(json.dumps({"keypoint": keypoint, "ixcellerate": ixcellerate, "assessment": str(out.relative_to(ROOT))}, ensure_ascii=False, indent=2))


def main_3data():
    facilities = json.loads((ROOT / "data/reviewed-facilities.json").read_text())
    names = {f["id"]: f["name"] for f in facilities}
    manifest_path = ROOT / "data/report-media.json"
    manifest = json.loads(manifest_path.read_text())
    assessment = {"checked_at": date.today().isoformat(), "operator": "3data", "selection_rule": "first linked image in the official page's .photos gallery following its Photos heading", "results": []}
    for facility_id, slug in FACILITIES.items():
        page_url = f"https://3data.ru/en/dc/{slug}"
        page = get(page_url).decode("utf-8", "replace")
        heading = re.search(r'<div\s+class="dc-h2">\s*(?:Photos of data center|Virtual tour and photos of the data center)[^<]*</div>', page, re.I)
        if not heading:
            assessment["results"].append({"facility_id": facility_id, "page_url": page_url, "status": "gallery_heading_missing"})
            continue
        gallery_start = page.find('<div class="photos"', heading.end())
        gallery_end = page.find("</div>", gallery_start)
        # Gallery contains nested divs; end at the next explicit boundary before the next section.
        later = re.search(r"</div>\s*(?:<br|<div class=\"c-back\")", page[gallery_start:])
        gallery = page[gallery_start:gallery_start + later.end()] if gallery_start >= 0 and later else ""
        if not gallery:
            assessment["results"].append({"facility_id": facility_id, "page_url": page_url, "status": "gallery_markup_missing"})
            continue
        first = re.search(r'<a\b[^>]*class="[^"]*fancybox[^"]*"[^>]*href="([^"]+)"', gallery, re.I)
        if not first:
            assessment["results"].append({"facility_id": facility_id, "page_url": page_url, "status": "gallery_image_missing"})
            continue
        image_url = "https://3data.ru" + html.unescape(first.group(1))
        raw = get(image_url)
        image = Image.open(BytesIO(raw)).convert("RGB")
        # Store normalized JPEG bytes for deterministic file/hash metadata.
        main_bytes = BytesIO()
        image.save(main_bytes, format="JPEG", quality=92, optimize=True)
        data = main_bytes.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        rel = f"img/reports/facility-{digest[:16]}.jpg"
        target = ROOT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(data)
        thumb_img = image.copy()
        thumb_img.thumbnail((480, 300), Image.Resampling.LANCZOS)
        thumb_bytes = BytesIO()
        thumb_img.save(thumb_bytes, format="JPEG", quality=85, optimize=True)
        thumb_data = thumb_bytes.getvalue()
        thumb_hash = hashlib.sha256(thumb_data).hexdigest()
        thumb_rel = f"img/reports/thumb-{thumb_hash[:16]}.jpg"
        thumb_path = ROOT / thumb_rel
        if not thumb_path.exists():
            thumb_path.write_bytes(thumb_data)
        name = names[facility_id]
        entry = {"kind": "image", "src": rel, "sha256": digest, "thumbnail": thumb_rel, "thumbnail_sha256": thumb_hash, "source_url": page_url, "source_image_url": image_url, "caption": f"Operator source photo · {name}", "media_verification": "source_attributed", "credit": "3data — official facility gallery"}
        old = manifest.get("facility_photos", {}).get(facility_id, [])
        # Put the gallery's first image first (card preview); preserve every distinct prior image.
        preserved = [item for item in old if item.get("sha256") != digest]
        manifest.setdefault("facility_photos", {})[facility_id] = [entry, *preserved]
        assessment["results"].append({"facility_id": facility_id, "facility_name": name, "page_url": page_url, "gallery_first_image_url": image_url, "sha256": digest, "dimensions": list(image.size), "asset": rel, "thumbnail": thumb_rel, "status": "imported"})
    write_json_atomic(manifest_path, manifest)
    (ROOT / "data/import-assessments/3data-photo-import-20261020.json").write_text(json.dumps(assessment, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"imported": sum(x["status"] == "imported" for x in assessment["results"]), "exceptions": [x for x in assessment["results"] if x["status"] != "imported"], "results": assessment["results"]}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operator", choices=("all", "3data", "keypoint", "ixcellerate"), default="all")
    args = parser.parse_args()
    if args.operator in ("all", "3data"):
        main_3data()
    if args.operator in ("all", "keypoint", "ixcellerate"):
        main_operators(args.operator)


if __name__ == "__main__":
    main()
