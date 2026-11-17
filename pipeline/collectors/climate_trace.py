"""Fetch one identity-only Climate TRACE inventory page for human/AI review."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlencode

import requests
from third_party.climate_trace import client

ROOT = Path(__file__).resolve().parents[2]
DISCOVERY = ROOT / "data" / "discovery"
FIELDS = ("id", "name", "country", "sector", "subsector", "sourceType")
SUBSECTOR = "oil-and-gas-refining"
SECTOR = "fossil-fuel-operations"
COMMIT = "e1d200828051f537945c235ae26b98d50d0ea5ea"


class CollectorError(ValueError):
    """Safe, fixed-text validation error; never include upstream payloads."""


def validate_options(limit, offset, country, year):
    if type(limit) is not int or not 1 <= limit <= 50:
        raise CollectorError("limit must be between 1 and 50")
    if type(offset) is not int or not 0 <= offset <= 10000:
        raise CollectorError("offset must be between 0 and 10000")
    if country != "RUS":
        raise CollectorError("this collector is limited to country RUS")
    if type(year) is not int or not 2021 <= year <= datetime.now(timezone.utc).year:
        raise CollectorError("year must be from 2021 through the current year")


def project_rows(payload, limit):
    """Fail the whole page on invalid identity/filter shape; strip other fields."""
    if not isinstance(payload, list) or len(payload) > limit:
        raise CollectorError("unexpected inventory response shape or page size")
    rows, ids = [], set()
    for raw in payload:
        if not isinstance(raw, dict) or any(key not in raw for key in FIELDS):
            raise CollectorError("inventory row is missing identity fields")
        row = {key: raw[key] for key in FIELDS}
        if type(row["id"]) is not int or row["id"] <= 0 or row["id"] in ids:
            raise CollectorError("inventory source IDs must be unique positive integers")
        for key in FIELDS[1:]:
            value = row[key]
            if (not isinstance(value, str) or not value.strip() or len(value) > 500
                    or any(ord(char) < 32 for char in value)
                    or any(char in value for char in '<>')):
                raise CollectorError("invalid inventory identity text")
        if (row["country"] != "RUS" or row["sector"] != SECTOR
                or row["subsector"] != SUBSECTOR or row["sourceType"] != "point-source"):
            raise CollectorError("inventory row does not match the required identity filters")
        ids.add(row["id"])
        rows.append(row)
    return sorted(rows, key=lambda row: row["id"])


def output_path(value):
    path = Path(value).resolve()
    if path.parent != DISCOVERY.resolve() or path.suffix != ".json":
        raise CollectorError("output must be a JSON file directly inside data/discovery")
    # Existing data can be replaced only atomically after a fully validated fetch.
    return path


def collect(*, limit, offset, country, year):
    validate_options(limit, offset, country, year)
    params = {"year": year, "subsectors": SUBSECTOR, "gadmId": country,
              "limit": limit, "offset": offset}
    try:
        # The official selected helper performs exactly one GET, no redirects/retries.
        rows = project_rows(client.get_sources(
            year=year, subsectors=SUBSECTOR, gadm_id=country,
            limit=limit, offset=offset, timeout=30), limit)
    except (requests.RequestException, ValueError, TypeError):
        # Do not log URLs, upstream error bodies, metric payloads or injected strings.
        raise CollectorError("inventory request or validation failed; output preserved") from None
    encoded = json.dumps(rows, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return {
        "schema_version": 1,
        "dataset": "Climate TRACE",
        "approval_status": "discovery_only_needs_review",
        "request": {"url": client.BASE_URL + "/sources?" + urlencode(params),
                    "country": country, "subsector": SUBSECTOR,
                    "limit": limit, "offset": offset, "year": year},
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "api_route_version": "v7",
        "source_api_version": "unknown",
        "dataset_release_version": "unknown",
        "code_provenance": {"commit": COMMIT,
                            "artifact": "third_party/climate_trace/PROVENANCE.json",
                            "source_url": "https://github.com/climatetracecoalition/climate-trace-tools/blob/" + COMMIT + "/climate_trace_tools/api/client.py"},
        "projection_fields": list(FIELDS),
        "projected_rows_sha256": hashlib.sha256(encoded).hexdigest(),
        "projected_hash_encoding": "UTF-8 JSON, numeric ID sorted rows, sorted keys, comma/colon separators, ensure_ascii=false, no trailing newline",
        "raw_response_retained": False,
        "records": rows,
        "licence": {"attribution": "Source: Climate TRACE, https://climatetrace.org/. Changes: identity fields only; sorted by source ID.",
                    "terms_url": "https://climatetrace.org/terms",
                    "license_url": "https://creativecommons.org/licenses/by/4.0/",
                    "source_chain_status": "RMI methodology/source-chain terms still need review before production redistribution"},
        "limitations": ["One bounded page; upstream pagination selects by emissions internally. Original order and all metrics discarded. No completeness or representative-sample claim.",
                        "year selects source data; it does not verify current operation or incident status.",
                        "No per-row revision or current API schema version fetched; unknown remains unknown.",
                        "Source identity/category assertions need an exact candidate-version AI review before approval. No automatic local ID matching."],
    }


def atomic_write(path, document):
    data = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=".climate-trace-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--country", required=True, choices=["RUS"])
    parser.add_argument("--year", type=int, required=True,
                        help="source-data year, never an operating-status date")
    parser.add_argument("--output", required=True, help="JSON path directly inside data/discovery")
    args = parser.parse_args(argv)
    try:
        path = output_path(args.output)
        document = collect(limit=args.limit, offset=args.offset, country=args.country, year=args.year)
        atomic_write(path, document)
    except (CollectorError, OSError):
        print("Collection failed; no discovery output replaced.", file=sys.stderr)
        return 1
    print("Saved %d unapproved identity records." % len(document["records"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
