# Bounded discovery collectors

The Climate TRACE identity collector reuses the official repository's selected
`get_sources`, `_get` and `_to_csv` functions at commit
`e1d200828051f537945c235ae26b98d50d0ea5ea`, rather than installing the entire
analysis/LFS package. The pinned upstream Python source and LICENSE were read
before the adapted subset was executed. Attribution, upstream hashes, exact
source URLs and modifications are in `third_party/climate_trace/PROVENANCE.json`.
The upstream code licence is CC BY 4.0, with its notice preserved beside it.

From the repository root, explicitly request one discovery page:

```sh
python3 -m pipeline.collectors.climate_trace --country RUS --year 2025 --limit 50 --offset 0 --output data/discovery/climate-trace-rus-refining-2025-page-0.json
```

Requires the already available `requests` package. No account, token, paid API,
new framework or package installation is used. The command makes exactly one
public GET to `/v7/sources`, with a 30 second timeout, no redirects, retries,
automatic pagination, definition lookups or detail requests. `limit` must be
1–50 and `offset` 0–10000. Only RUS, refining, point-source rows are accepted.
A subsequent page requires a separate explicit command with its own offset.
`--year` is mandatory and selects source data; it never means current operation.

Only `id`, `name`, `country`, `sector`, `subsector`, `sourceType` survive the
projection. The list endpoint intrinsically returns emissions-sorted data;
metrics, ranking/order, coordinates, capacities and other extra fields are
immediately discarded before persistence or display. Surviving rows are sorted
by numeric source ID. This is a bounded upstream-selected page, not a random or
representative sample or a national coverage claim. Malformed rows, wrong filters,
duplicate IDs, unexpected response shape and oversized pages reject the entire
fetch. HTML delimiters/control characters are rejected in identity text; other
source text remains untrusted data and must be escaped by any renderer, never
interpreted as instructions.

The explicit output path must be a `.json` file directly in `data/discovery`.
A fully projected, validated document replaces it atomically. Network, response,
validation and write failures preserve the previous output and show fixed error
text, never raw upstream payloads. An ID-sorted projection hash is replayable
offline. No raw response is retained or claimed replayable. Saved metadata records
the URL, fetch time, requested source-data year, route version v7 and pinned code
provenance. Current API schema version, data release and per-row revisions remain
unknown; the old pilot's OpenAPI 7.2.0 observation is not promoted to current fact.

Output is discovery-only. It does not touch SQLite, the catalogue, reviewed export,
local facility IDs, incidents or approval state. Any later import requires the
existing exact candidate-version AI source-review gate. Inventory names cannot
verify operating status, reopening, incident completeness or precise identity.

Data attribution links Climate TRACE and its terms. The software licence and the
previous terms assessment do not settle the refining data's RMI methodology and
external source-chain terms. Review those before production redistribution.

Offline tests reuse the four identity rows cached in the previous pilot. They
mock HTTP rather than claiming to replay discarded raw bytes or a live request:

```sh
python3 -m unittest discover -s tests -p test_collectors.py -v
```
