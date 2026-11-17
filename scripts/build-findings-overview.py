#!/usr/bin/env python3
"""Regenerate the German read-only overview of reviewed and queued findings."""
from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "research/applied-findings/summary.json"
BASELINE = ROOT / "research/applied-findings/before.json"
CURRENT = ROOT / "data/reviewed-facilities.json"
QUEUE = ROOT / "pipeline/runtime/continuous-review/queue"


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "").casefold()
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def event_map(records):
    return {
        record["id"]: {event.get("id"): event for event in record.get("incidents", []) if event.get("id")}
        for record in records
    }


def main():
    before_doc = read(BASELINE)
    before_records = before_doc["records"]
    current_records = read(CURRENT)
    before = {record["id"]: record for record in before_records}
    current = {record["id"]: record for record in current_records}
    before_events, current_events = event_map(before_records), event_map(current_records)

    actual_incidents = []
    actual_status_changes = []
    for facility_id, record in current.items():
        prior = before.get(facility_id)
        for incident_id, incident in current_events.get(facility_id, {}).items():
            if incident_id not in before_events.get(facility_id, {}):
                actual_incidents.append({
                    "facilityId": facility_id, "facility": record.get("name", facility_id),
                    "category": record.get("facility_type", "Unbekannt"),
                    "date": incident.get("date"), "incidentId": incident_id,
                    "description": incident.get("description", ""),
                })
        if prior and (prior.get("operational_status"), prior.get("status_as_of")) != (
            record.get("operational_status"), record.get("status_as_of")
        ):
            actual_status_changes.append({
                "facilityId": facility_id, "facility": record.get("name", facility_id),
                "before": prior.get("operational_status"), "after": record.get("operational_status"),
                "beforeAsOf": prior.get("status_as_of"), "afterAsOf": record.get("status_as_of"),
            })

    candidates = []
    ready_versions = 0
    ready_envelopes = 0
    for envelope_path in sorted(QUEUE.glob("*.json")):
        envelope = read(envelope_path)
        if envelope.get("state") != "ready":
            continue
        ready_envelopes += 1
        for candidate_path in envelope.get("candidate_paths", []):
            path = ROOT / candidate_path
            if not path.exists():
                continue
            candidate = read(path)
            facility = candidate.get("facility", {})
            if not facility.get("id"):
                continue
            candidates.append({"path": candidate_path, "facility": facility, "evidence": candidate.get("evidence", [])})
            ready_versions += 1

    grouped = defaultdict(list)
    for item in candidates:
        grouped[item["facility"]["id"]].append(item)

    facilities = []
    proposed_incident_count = 0
    pending_incident_count = 0
    possible_duplicate_count = 0
    for facility_id, versions in sorted(grouped.items(), key=lambda pair: min(v["facility"].get("name", pair[0]) for v in pair[1]).casefold()):
        versions.sort(key=lambda v: v["path"])
        baseline = before.get(facility_id, {})
        canonical = current.get(facility_id, {})
        baseline_ids = set(before_events.get(facility_id, {}))
        canonical_ids = set(current_events.get(facility_id, {}))
        incident_by_id = {}
        sources = {}
        facility_sources = set()
        statuses = []
        for version in versions:
            facility = version["facility"]
            proposed_status = (facility.get("operational_status"), facility.get("status_as_of"))
            if proposed_status not in statuses:
                statuses.append(proposed_status)
            for incident in facility.get("incidents", []):
                incident_id = incident.get("id")
                if not incident_id:
                    continue
                incident_by_id.setdefault(incident_id, incident)
            for evidence in version["evidence"]:
                if evidence.get("url"):
                    source = (evidence.get("name") or evidence.get("id") or "Quelle", evidence["url"])
                    facility_sources.add(source)
                    for incident in facility.get("incidents", []):
                        incident_id = incident.get("id")
                        if incident_id and incident_id not in baseline_ids:
                            sources.setdefault(incident_id, set()).add(source)
        proposed_new = {key: value for key, value in incident_by_id.items() if key not in baseline_ids}
        proposed_incident_count += len(proposed_new)
        for incident_id in proposed_new:
            if incident_id not in canonical_ids:
                pending_incident_count += 1

        # Flag repeated descriptions under separate IDs as possible duplicates, never merge them.
        normalized_descriptions = defaultdict(list)
        for incident_id, incident in proposed_new.items():
            text = normalize(incident.get("description", ""))
            if len(text) >= 30:
                normalized_descriptions[text].append(incident_id)
        possible_duplicates = [ids for ids in normalized_descriptions.values() if len(ids) > 1]
        possible_duplicate_count += sum(len(ids) - 1 for ids in possible_duplicates)

        imported_statuses = []
        for status, as_of in statuses:
            if (status, as_of) != (baseline.get("operational_status"), baseline.get("status_as_of")) and (
                status, as_of
            ) == (canonical.get("operational_status"), canonical.get("status_as_of")):
                imported_statuses.append({"status": status, "asOf": as_of})
        has_imported = any(incident_id in canonical_ids for incident_id in proposed_new) or bool(imported_statuses)
        pending_incidents = [
            {"id": incident_id, "date": incident.get("date"), "description": incident.get("description", ""),
             "imported": incident_id in canonical_ids,
             "sources": [{"name": name, "url": url} for name, url in sorted(sources.get(incident_id, set()))]}
            for incident_id, incident in sorted(proposed_new.items(), key=lambda pair: (pair[1].get("date") or "9999", pair[0]))
        ]
        facilities.append({
            "id": facility_id,
            "name": versions[-1]["facility"].get("name") or canonical.get("name") or baseline.get("name") or facility_id,
            "category": versions[-1]["facility"].get("facility_type") or canonical.get("facility_type") or "Unbekannt",
            "region": versions[-1]["facility"].get("region") or canonical.get("region") or "Nicht angegeben",
            "baselineStatus": baseline.get("operational_status"),
            "currentStatus": canonical.get("operational_status"),
            "currentStatusAsOf": canonical.get("status_as_of"),
            "proposedStatuses": [{"status": status, "asOf": as_of} for status, as_of in statuses],
            "importedStatuses": imported_statuses,
            "incidents": pending_incidents,
            "sources": [{"name": name, "url": url} for name, url in sorted(facility_sources)],
            "versions": len(versions),
            "state": "imported" if has_imported else "pending",
            "possibleDuplicateIds": [ids for ids in possible_duplicates],
        })

    year_counts = defaultdict(Counter)
    category_counts = defaultdict(Counter)
    for incident in actual_incidents:
        date = incident.get("date") or ""
        year = date[:4] if re.match(r"^\d{4}", date) else "Datum unbekannt"
        year_counts[year]["actual"] += 1
        category_counts[incident.get("category") or "Unbekannt"]["actual"] += 1
    # Queue entries are proposals; deduplicate by facility + incident ID.
    # Imported IDs remain represented by actualIncidents even after queue removal.
    for facility in facilities:
        for incident in facility["incidents"]:
            if incident["imported"]:
                continue
            date = incident.get("date") or ""
            year = date[:4] if re.match(r"^\d{4}", date) else "Datum unbekannt"
            year_counts[year]["pending"] += 1
            category_counts[facility["category"] or "Unbekannt"]["pending"] += 1

    def chart_rows(counter):
        return [{"label": label, "actual": counts["actual"], "pending": counts["pending"]}
                for label, counts in sorted(counter.items())]

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "baselineCapturedAt": before_doc.get("captured_at"),
        "baselineSource": before_doc.get("source"),
        "currentSource": "data/reviewed-facilities.json",
        "queueSource": "pipeline/runtime/continuous-review/queue/*.json (state=ready)",
        "metrics": {
            "approvedBefore": len(before_records), "approvedNow": len(current_records),
            "actualNewIncidents": len(actual_incidents), "facilitiesWithActualNewIncidents": len({x["facilityId"] for x in actual_incidents}),
            "actualStatusChanges": len(actual_status_changes), "readyVersions": ready_versions,
            "readyEnvelopes": ready_envelopes, "proposedFacilities": len(facilities),
            "facilitiesWithVariants": sum(1 for group in facilities if group["versions"] > 1),
            "uniqueProposedIncidents": proposed_incident_count,
            "pendingProposedIncidents": pending_incident_count,
            "possibleDuplicateIncidentIds": possible_duplicate_count,
        },
        "actualIncidents": actual_incidents,
        "actualStatusChanges": actual_status_changes,
        "yearCounts": chart_rows(year_counts),
        "categoryCounts": chart_rows(category_counts),
        "facilities": facilities,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary["metrics"], ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
