# Local evidence and review gate

This dependency-free Python/SQLite component stages proposals and imports AI review artifacts. It does **not** fetch websites, call a model, schedule work, deploy a site, or establish source truth. Its only network-related data are source URLs. An external authorized worker must collect and read sources, create a candidate, perform the actual AI review, and import the resulting artifact. An `approved` artifact is a recorded assessment, not independent verification.

Run from the repository root:

```sh
python3 -m pipeline init
python3 -m pipeline status
python3 -m pipeline pending
python3 -m pipeline inspect PROPOSAL_ID
python3 -m pipeline stage /path/to/candidate.json
python3 -m pipeline stage-correction /path/to/candidate.json /path/to/correction.json
python3 -m pipeline review /path/to/review.json
python3 -m pipeline export data/reviewed-facilities.json
python3 -m unittest discover -s tests -p test_pipeline.py -v
```

Default database: `pipeline/runtime/facilities.sqlite3` (ignored by Git). `--db /path/to/database.sqlite3` before the command selects a different database. Keep candidate/review working files in `pipeline/runtime/` too. Back up the database for durable operation; Git history alone does not contain this local audit trail. Export refuses an empty database to avoid erasing an existing published file. Export writes atomically; adding its path to the static data catalog is a separate explicit integration step.

`status` returns table counts, approved-facility and pending-proposal counts, and the latest publication (or null). `pending` lists unreviewed proposals and proposals whose latest effective decision is `needs_review`; published proposals are excluded. `inspect PROPOSAL_ID` returns the exact candidate, hash/base version, current published version, and latest review artifact/hold reasons. These commands let a worker inspect the queue without direct SQL.

## Candidate format (schema_version 1)

A candidate is a **complete proposed snapshot**, not a patch. `base_version` is zero for a new stable facility ID; otherwise it must equal the last published version. Use one stable ID for a physical facility and retain it after renaming/reopening. Entity matching is the collector/reviewer's job; different IDs for the same facility are not automatically deduplicated.

Exact top-level keys:

- `schema_version`: integer `1`.
- `base_version`: nonnegative integer.
- `facility`: exactly `id`, `name`, `facility_type`, `operator`, `region`, `country`, `footprint_m2`, `incidents`, `operational_status`, `status_as_of`.
- `evidence`: a nonempty list of evidence objects.
- `assertions`: a nonempty list of field assertions.

Facility IDs accept letters, numbers, underscores, and hyphens, up to 100 characters. Name, operator, region and country are nonempty strings; use an explicit textual unknown if necessary, and do not invent geographic details. Supported types: `warehouse`, `logistics_hub`, `bridge`, `refinery`, `oil_well`, `data_center`, `military_facility`, `defence_manufacturing`, `government_building`, `drone_facility`, `robotics_facility`, `industrial_facility`. A field is not a well: do not label an aggregate oil field as an individual well. Record named physical facilities/sites only; do not substitute a parent company when its factory/site is unknown. Drone and robotics sites do not imply a defence connection. Use `industrial_facility` for sourced civilian or dual-use production, including materials plants, unless an actual defence link is established. Keep government buildings distinct from military facilities. Do not collect or publish military operational intelligence, exact facility locations, readiness/capacity, vulnerabilities or unit details; incident summaries remain town-level. Footprint is a positive finite number in square metres or null. Incident objects have exactly `id`, `date` (`YYYY-MM-DD`), and `description`. Incident IDs are stable within a facility.

Operational statuses: `unknown`, `operating`, `disrupted`, `temporarily_closed`, `partially_reopened`, `reopened`, `permanently_closed`. `unknown` requires `status_as_of: null`; any other state requires a valid date. Do not infer operation or closure merely from an incident, directory listing, unchanged website, or silence.

Evidence objects require the following fields:

```json
{
  "id": "source-1",
  "name": "Publisher and document title",
  "url": "https://example.com/source",
  "observed_at": "2026-01-10T12:00:00Z",
  "published_on": "2026-01-09",
  "excerpt": "A short source passage relevant to the asserted fact."
}
```

Optional evidence fields are `access_method` (`full_page`, `search_index`, or `document`) and `excerpt_kind` (`paraphrase` or `quote`). These are retained in exported source objects. Never describe a search-index excerpt as a full-page access.

This is a schema illustration, not a real source or observation. Replace placeholders with evidence actually accessed. `observed_at` means when the worker read it; it is never a reopening date. `published_on` can be null when unknown, but reopening approval requires dated publication evidence. Keep excerpts short and comply with source terms. HTTP(S) URLs with no embedded credentials are accepted. The gate does not retrieve or authenticate them.

Assertions have exactly `field`, `value`, `evidence_ids`, and optional `effective_on`. Example shape:

```json
{
  "field": "operational_status",
  "value": "partially_reopened",
  "evidence_ids": ["source-1"],
  "effective_on": "2026-01-08"
}
```

`value` must match the proposed field value. All positive fields, including unchanged carried-forward facts, require evidence assertions; null footprint, empty incident history and unknown status do not assert positive facts. Clearing a previously known field still needs evidence and historical incident deletion is held. Retain supporting evidence for carried-forward facts. Every status assertion requires `effective_on` matching `status_as_of`. Conflicting assertions remain staged and force `needs_review`, even if a review says approved. The incident-list assertion uses the whole incidents array as its value.

## Review import format

`stage` returns `proposal_id`, `candidate_hash`, and `base_version`. Copy these exact values into the review, along with:

```json
{
  "proposal_id": "sha256-returned-by-stage",
  "candidate_hash": "same-sha256",
  "base_version": 0,
  "reviewer": "Actual reviewing agent or worker identity",
  "model": "Actual model identifier, if exposed by the runtime",
  "reviewed_at": "2026-01-11T12:00:00Z",
  "decision": "needs_review",
  "rationale": "Explain which assertions the source supports and what remains uncertain.",
  "evidence_ids": ["source-1"],
  "conflicts": ["Describe unresolved contradictory evidence, if present"]
}
```

Decisions are `approved`, `rejected`, or `needs_review`. For `stage-correction`, add the optional `correction_hash` field described below to bind the review to its sidecar. An approving reviewer must cover **all** evidence IDs used by assertions, read evidence for semantic support, check identity and duplicates, distinguish an incident from current operation, and disclose conflicts. Do not fabricate model identity if unavailable: explicitly record `runtime model not exposed` and identify the actual worker. The import gate stores provenance but cannot authenticate who generated an artifact. Artifact signing/worker authentication is not implemented. Treat database and review-file write access as trusted.

A correct hash does not prove factual correctness. It ensures the review applies to exactly that candidate. A changed candidate requires staging and a fresh review. Repeated identical staging/import is idempotent. Competing proposals based on an older version are held; their approval cannot overwrite newer published facts. Rejected or held revisions do not remove the latest approved version.

For a changed status, its effective date must advance beyond the previous status date. For partial or full reopening, every cited status source must have a known publication date at least as recent as the claimed reopening and newer than the previous status date. Missing news is never sufficient. Earlier incident records remain in the exported history. Ordinary `stage` continues to hold every edit or removal of an already-published incident.

### Dedicated incident-description correction

Use `stage-correction` only for a source-backed correction to the wording of one existing incident. It does not authorize changing or deleting an incident ID/date, adding or removing any other incident, changing facility identity or operating status, or bypassing the ordinary exact-base and review checks. The candidate must be a complete snapshot based on the exact current publication. The correction sidecar has exactly this shape:

```json
{
  "incident_id": "stable-existing-incident-id",
  "previous_incident": {"id": "stable-existing-incident-id", "date": "2026-01-01", "description": "Exact currently published description"},
  "previous_incident_hash": "sha256-of-canonical-previous_incident-object",
  "replacement_incident": {"id": "stable-existing-incident-id", "date": "2026-01-01", "description": "Source-supported corrected description"},
  "reason": "Explain the specific correction and why it is needed.",
  "source_evidence_ids": ["new-source"]
}
```

The hash is SHA-256 over the pipeline's canonical JSON serialization (sorted keys, compact separators, UTF-8). The supplied previous incident must match the exact current published object; the replacement must retain the same ID and date and change its description. The candidate's only facility-data difference from the current publication may be that one description. Each correction evidence ID must exist in the candidate and be included in its exact full incident-list assertion. The reason and sidecar are stored append-only with the proposal. The independent review artifact must add `correction_hash`, set to the SHA-256 digest of the exact correction sidecar, and cover all asserted evidence; this binds the review to the correction request as well as the candidate hash. The sidecar itself is not a review or source verification. Invalid sidecars are rejected at staging and the review gate rechecks them against the then-current publication. No deletion, unrelated change, status update, or reopening can use this exception.

## Storage and export

Proposals, review decisions and publications are append-only SQLite tables enforced by triggers. Review records preserve both the worker's requested decision and the effective decision/reasons produced by the gate. A transaction prevents concurrent publication races. Candidate hashes deduplicate equivalent JSON object serialization; semantically duplicate facilities or differently ordered arrays still require review.

Exports are a JSON array compatible with `facilities-v1` catalog datasets, with source objects, original evidence, status evidence IDs, version, and `verification: {status: "ai_reviewed", reviewed_on, reviewed_by, scope: "candidate assertions"}`. The export also includes `provenance_note` copied from the reviewer rationale so review limits remain visible. AI review is not ground-truth verification, and the review date is not a current-operation observation date. This initial schema does not capture coordinates, capacity or vulnerability data. Existing inherited records are not automatically marked reviewed or imported.

## Current limits

No live ingestion, recurrent scheduling, independent verification service, URL fetching, completeness measurement, entity resolution, source archiving, cryptographic provenance, DB backup service, or publication automation is supplied here. The parent workflow can add an authorized Mac worker later; execution reliability then depends on the Mac, Codex availability, and source access. Tests use isolated synthetic fixtures and make no network or AI calls.
