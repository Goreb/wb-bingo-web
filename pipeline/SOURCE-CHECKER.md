# Bounded live source discovery

Run from the project root:

```sh
python3 scripts/check-incident-sources.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_source_checker.py -v
```

Standard Python only. No account, paid model, browser bypass, approval, facility
write or deployment. The scheduled worker owns `pipeline/runtime/worker.lock`;
run this checker inside that lock, never concurrently. CLI `--root PATH` permits
an isolated fixture/project directory; `--timeout` defaults to 15 seconds and is
capped at 60 seconds per request. Nonzero exit means at least one limited,
blocked or failed source and is compatible with partial discovery success.

The checker reads all six entries in `data/trusted-sources.json` and the public
`https://t.me/s/supernova_plus` listing. It fetches one HTML listing per news
source, at most two public Telegram pages after a saved cursor. Each request is
capped at 2 MB; redirects outside the declared source domains are refused. It
uses normal urllib requests and conditional ETag/Last-Modified headers when
available. Unchanged bodies are hashed, and URL/text/date lead hashes avoid
re-queuing unchanged material. A changed caption or date is a separate private
revision, preserving corrections. No linked news articles or media are fetched.

Private checkpoints and the persistent lead queue live under ignored
`pipeline/runtime/source-checks/`. Checkpoints contain cached raw HTML, response
fingerprints and the latest observed Telegram ID. Queue entries retain source
URL, publication timestamp when present, private source text and matching
reasons. Do not publish this directory: source content can contain precise
locations. Queue persistence precedes checkpoint persistence so interrupted
writes replay rather than discard leads. Previously pending items are never
automatically cleared, even after cursor advancement or retrieval failures.
A second-page failure still preserves the successful first-page leads.

`data/source-check-status.json` is a compact public status projection containing
only fixed source names/URLs, actual request outcome, check time, counts,
change flags and cursors. It contains no raw HTML, titles, excerpts, article
URLs or facility locations. `success` means readable listing items were found;
`limited` means no recognizable items, `blocked` means an HTTP access refusal
or recognizable challenge, and `failed` means another retrieval/parsing error.
These states do not establish source accuracy or incident verification.
If every source fails with a DNS/URLError in a network-restricted execution
environment, diagnose one request before treating that as an upstream outage.
Use the tool's regular per-command network approval path when available and
authorized; do not change permission settings or work around a site's access
refusal. A verified execution-environment fix can justify one repair retry of
the same due cycle. Preserve the failed attempt and record the retry separately.

Matching loads legacy, discovery and approved facility identities, with approved
records preferred for duplicate stable IDs. It uses name/alias tokens and
operator plus town when both are recorded, never a company alone. A small
explicit Russian/English bridge covers selected known towns and operator names;
it is incomplete, may produce false positives, and does not resolve identity.
Matching leads carry stable IDs and reasons privately. Broad English/Russian
facility and correction/reopening terms also enter `unmatched_relevant`, so an
unmatched title is not discarded merely because identity is unresolved. This
is a retrieval heuristic, not a classification or review decision. Russian
captions with unknown aliases, terse titles and non-text media can be missed.

On the first run Telegram starts at the latest public page. It does **not**
claim to bridge the imported archive: the maximum retained report ID is not a
complete-export cursor. Later requests try `?after=ID`, but server support and
contiguous history are unverified. Two pages never establish full catch-up;
`catchup_complete` is always false. Posts hidden between windows, revised older
posts and deletions may be missed. News homepages are similarly incomplete,
unrotated listing windows; successful extraction is not a full article check.

The scheduled AI worker should inspect pending relevant items, resolve identity,
open the strongest article/post evidence through available normal browser or
search tools, and record access limitations. Stronger translated aliases can
be derived during real review; do not manufacture a comprehensive mapping.
Follow AUTOMATION.md and the exact candidate/version review gate. A readable
listing, source trust-list membership or matching keyword never approves an
incident. Reopening requires explicit newer dated evidence; preserve historical
incidents and later corrections. Never infer no incidents from unchanged pages.

Seven offline fixture tests exercise domain filtering, Telegram parsing,
deduplication/corrections, blocked/empty/error results, capped incremental
retrieval with partial failure, entity versus generic-company matching, and
public/private content separation. These tests do not establish live access,
Telegram parameter support or completeness. Live executions must record their
actual source-by-source results separately.
