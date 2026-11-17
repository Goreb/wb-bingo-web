# Audited report approvals

## Current user policy — 2026-10-20

This supersedes stricter source-confidence wording below. One clear dated
trusted-source report counts as verified reporting unless a later trusted-source
correction/revocation invalidates the relevant claim. Do not seek an additional
independent truth-check, second outlet or photograph. Actual source extraction
still matches the stated facility, date and assertion; unstated damage or present
operation must not be invented. Preserve the quoted actor and later corrections.
Use `data/trusted-sources.json` policy version 2.

Russian government/operator assertions of reopening or current running remain
unverified claims, including when quoted by Reuters or another trusted outlet.
Record the actor, date and source; display 🇷🇺 Russian claimed through the
separate status-claims overlay, without silently replacing supported canonical
status. A source's own reporting differs from merely relaying that assertion.
Flags describe a documented claim origin, not inferred publisher nationality.

Exact hashes, source-extraction provenance and gate integrity remain required;
these are identity/version checks, not a demand for independent corroboration.
Sol remains stopped and queued proposals are not automatically imported by this
policy edit. Incident approval does not establish image authenticity, outage or
present operation. A facility with no recorded incident is not known to be safe
or running; one reported hit does not itself establish closure.

The source collection `data/unapproved-reports.json` remains immutable and unapproved. Approval is a narrow derived overlay; source photos, captions and channel updates remain unverified. Approval covers only the basic incident, date and town described by `approved_summary`.

An actual AI source reviewer writes one JSON object per report in `data/report-reviews/*.json` after checking the exact raw report and gate-approved facility version. Required fields:

```json
{
  "schema_version": 1,
  "report_id": "REPORT-ID",
  "report_sha256": "64 lowercase hexadecimal characters",
  "facility_id": "FACILITY-ID",
  "facility_version": 1,
  "incident_id": "existing-approved-incident-id",
  "event_date": "2026-10-19",
  "decision": "approved",
  "scope": "incident_date_town",
  "reviewed_by": "reviewer identity",
  "model": "actual reviewer model",
  "reviewed_at": "2026-10-19T20:00:00Z",
  "approved_summary": "Only source-supported basic incident, date and town.",
  "evidence_urls": ["https://example.org/approved-incident-source"]
}
```

`report_sha256` hashes the entire exact raw report encoded as UTF-8 JSON with sorted keys, compact separators and unescaped Unicode (`json.dumps(report, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)`). Do not hash the containing collection or a display projection. Use actual reviewer metadata; the example is not a review artifact.

Run `python3 scripts/build-report-approvals.py`. The builder checks identity, exact hash, reviewed facility version, matching existing incident ID/date (an explicit reviewed date may fill a raw null date, but cannot contradict a known raw date or follow every source post), reviewer metadata and evidence URLs listed as supporting incidents on the approved facility. Invalid or stale artifacts are excluded with diagnostics. It adds `facility_sha256` binding the exact approved facility object and writes `data/report-approvals.json`. Review summaries require human/AI source assessment; mechanical checks do not verify prose truth.

The browser optionally loads this overlay and the raw reviewed facilities. WebCrypto verifies both hashes and repeats provenance checks before exposing `approval_status: approved` with `approval.approved_summary`. Missing files, unavailable WebCrypto or stale bindings leave raw reports unapproved and visible outside approved-only mode. Public packaging must preserve exact reviewed facility objects for their hashes to match. Merely attaching photos never establishes approval; visually reviewed matching media may qualify under the policy.

## Proportionate approval policy — 2026-10-19

Use `data/trusted-sources.json` as the shared trusted-source list and decision policy. One clear dated trusted-source news report, direct first-party confirmation, or actual AI-reviewed matching media is sufficient for the basic event/date/town. No mandatory second outlet, primary confirmation or damage/operation proof. Read the actual evidence; preserve attribution for unconfirmed allegations. For media, record the specific identity match and timing evidence; shared footage is one evidence chain. Generic smoke or attachment presence alone is insufficient. Keep exact-version review artifacts and the SQLite gate. Do not downgrade a supported basic incident merely because other claims remain unknown. This supersedes earlier wording implying a mandatory independent-source count.

## Explicit identity binding for previously unmatched reports

A raw report with `facility_id: null` may be linked only by an actual AI review
of that exact raw report and the gate-approved incident. Add this optional field
to the review artifact, alongside the existing exact hashes, versions and evidence:

```json
"identity_binding": {
  "raw_facility_id": null,
  "facility_id": "EXACT-APPROVED-ID",
  "rationale": "Specific source-backed identity and same-event matching reasons.",
  "evidence_urls": ["https://example.org/approved-incident-source"]
}
```

Binding evidence URLs must be a nonempty subset of that review's approved
incident evidence URLs. The reviewer must inspect captions, town, operator,
dates and corrections; a matching keyword or photo presence alone is insufficient.
Do not generate a binding merely because the new schema accepts it. An existing
non-null raw identity cannot be redirected through this field. Report/approved
facility hashes, existing incident/date and all normal review checks still apply.
Only the derived approved display projection receives the matched facility ID;
the original report, source timestamps/media labels and audit hash stay unchanged.
Missing, malformed or stale bindings leave reports visible and unapproved.

## Explicit event timezone for cross-midnight source posts

Posting date in the export's timezone may differ from the event's local date.
When actual source review establishes both the same incident and the event's
local timezone, an exact review may add `event_timezone` (IANA name, for example
`Europe/Moscow`) and nonempty `timing_rationale` explaining the source sequence,
conversion and identity match. Do not fill these fields automatically from a town
name or use them to approve unrelated next-day events. All usual exact hashes,
approved incident/date and source checks still apply.

Use case-correct IANA region/name identifiers (or UTC). Bare abbreviations and
offset-style strings such as `+03:00` are not accepted.
Both validators convert the original offset-bearing posted timestamps to the
reviewed timezone before testing whether the event date follows every post.
Absent both fields, existing behavior is unchanged. Missing rationale, an unknown
timezone or an event still later than all converted posts fails closed. Original
source timestamps, source JSON and media uncertainty remain unchanged. This is a
timing consistency check; the actual reviewer still determines same-event linkage.

## Skip unchanged completed report work

Run `python3 scripts/report-review-preflight.py REPORT_ID [MORE_IDS...]` before
report-only source research. It verifies the existing local overlay against the
exact raw report, current approved facility hash/version and approved incident.
`already_approved_current` permits skipping unchanged work, not ignoring newly
reported corrections or changed evidence. `needs_review`/`unknown_report` does
not approve anything; `unavailable` signals an unreadable state. The helper has
no network access, source-truth verification, AI decision or write operation.
