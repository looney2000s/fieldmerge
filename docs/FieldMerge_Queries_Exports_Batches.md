# Filtered queries, downloads, summaries, exports, and batches

Implemented 10 November 2026 in migration 008 and the Next.js API. These endpoints supply the data operations required by the upcoming interface. All require an active session; read handlers are noncached and use guarded SQL functions.

## Accepted records and snapshots

GET /api/records accepts source_record_id and species as case-insensitive literal substrings, health as Good/Fair/Poor/unknown, active as true/false/all, limit from 1–100 (default 50), and after as the previous next_cursor. unknown selects SQL NULL health; an omitted health filter selects every health value. The default active scope is all, preserving access to retired records/history. Search percent/underscore characters have no wildcard semantics.

Results contain records and next_cursor. Ordering is ascending record UUID. Continue with the same filters and the returned cursor until it is null. Pagination reads live accepted state; separate pages are not a frozen cross-request snapshot. Unknown/duplicate filters and malformed bounds are rejected.

GET /api/records/:id/snapshot downloads a JSON attachment containing format, exported_at, campaign/reference window, an explicit record/version with accepted values, and supported form identifiers. Add ?version=1 for a historical immutable version; omit it for latest. A missing record/version returns 404. Both roles may download snapshots. Preserve record_id and version_no as the proposal's base; do not upload a snapshot itself as a patch envelope.

```powershell
$records = Invoke-RestMethod "$base/api/records?health=unknown&active=true&limit=10" -WebSession $surveyorSession
$records.records
$id = '30000000-0000-4000-8000-000000000001'
Invoke-WebRequest "$base/api/records/$id/snapshot?version=1" -WebSession $surveyorSession -OutFile .\tmp\tree-snapshot.json
```

These examples reuse the URL/session variables from [the API guide](FieldMerge_API.md). Keep downloaded working files in the ignored tmp directory when they contain local/user data.

## Reviewer queue

GET /api/reviews supports record_id, field, author_id, from, to, after, and limit (1–100, default 100). field is one of the four canonical scalar names. Receipt times use inclusive from and exclusive to; filter timestamps require explicit offsets and at most millisecond precision. Source evidence timestamps retain the broader precision contract.

The queue orders by change UUID and returns changes/next_cursor. It shows actual current accepted values/version tokens in addition to the original comparison. Filtering does not refresh an approval's intent: continue to submit the current version/revision and reconsider a stale response. Surveyors cannot read this queue.

## Accepted exports

Reviewer-only GET /api/reports/accepted.json and /api/reports/accepted.csv accept the four record filters (source_record_id, species, health, active). They export all matching latest records in one SQL statement, with a maximum of 5,000 rows. More matches return 413 export_too_large_use_filters; no successful truncated export is produced. Paging parameters are intentionally rejected on exports.

JSON preserves exact diameter text as a decimal string and represents missing values as null. CSV uses UTF-8, quoted/escaped cells and CRLF, with empty cells for null, explicit false/zero values, and an apostrophe prefix on formula-like text. That spreadsheet-display protection changes the CSV spelling of such strings; use JSON when exact original strings are required. Export filenames are fixed server values. Neither export includes password/session data.

```powershell
Invoke-WebRequest "$base/api/reports/accepted.csv?active=true" -WebSession $reviewerSession -OutFile .\tmp\accepted-records.csv
```

## SQL and evidence summaries

Reviewer-only GET /api/reports/summary returns sql and evidence sections with consistency: independent_database_reads. SQL owns accepted-record/version totals, submission states, field dispositions/classifications, review actions, and unresolved-record workload. Independent grouped subqueries avoid multiplying counts through joins. A CTE with GROUP BY/HAVING identifies unresolved records; the response includes their total and the ten oldest workload groups.

MongoDB uses one bounded-output aggregation with facets for stored source count, form counts, first-intake batch counts, optional-observation coverage, observation categories, and patch-field presence/explicit-null counts. At most 100 first-batch groups are returned; batch_groups_truncated signals additional groups. Null/missing first batch is an explicit unbatched group, not a fabricated batch ID. An empty evidence store has null coverage percentage rather than a fabricated denominator.

Stored source counts include evidence awaiting verification or held in quarantine. They are not counts of accepted observations or resolved conflicts. Omitted patch fields are not a measure of accepted-record completeness, and differing observation times do not identify factual truth.

The SQL and MongoDB reads are independent, not a distributed snapshot. If evidence aggregation is unavailable, successful SQL totals remain in the response and evidence.available is false with evidence_unavailable; no zero evidence counts are substituted. A SQL failure remains an HTTP error. The aggregate has a five-second MongoDB query bound, not a measured capacity guarantee.

## Durable batch transport identities

POST /api/submissions/batch still accepts an array of 1–100 envelopes and returns HTTP 207 with independent results. Supply X-FieldMerge-Batch-Id with a lowercase UUID generated before the first attempt. The response contains the server batch_id and client_batch_id. Reuse the header plus the same ordered array on retry. Without a header, the server generates a client transport identity and echoes it; logical submission keys still prevent duplicate effects if that response is lost.

Registration seals a manifest of exact canonical per-item hashes. A retry can change object-key order/numeric spelling without changing logical content, but changed items or array order under the same batch key return 409. Use a new batch identity for a changed manifest. Corrections to already reserved source content require a new logical client_submission_id too.

Each source stores its first-intake batch_id in SQL and MongoDB, outside the logical envelope fingerprint. Later uploads can include the same logical submission in another batch; that creates another transport membership, not another source document/version or rewritten attribution. A source first submitted singly stays unbatched even when later retried in a batch. MongoDB batch aggregates describe first attribution; SQL batch inspection describes transport memberships. Repeated positions can therefore refer to one logical source.

GET /api/batches/:batchId is available to the owner and reviewers; other surveyors receive 404. It returns ordered item positions, linked submission IDs/live states, durable validation/retry errors, processed flags, and first-intake attribution. A worker-completed item can show processed true even if an earlier transport attempt had an error. Missing original content still needs re-upload under the same original identities; hashes are not evidence reconstruction.

```powershell
$batchKey = [guid]::NewGuid().ToString()
$batchHeaders = @{ Origin = $base; 'X-FieldMerge-Batch-Id' = $batchKey }
# $envelopes contains the original envelope objects; preserve this body for retry.
$batchBody = ConvertTo-Json -InputObject @($envelopes) -Depth 20
$batch = Invoke-RestMethod "$base/api/submissions/batch" -Method Post -Headers $batchHeaders -ContentType 'application/json' -WebSession $surveyorSession -Body $batchBody
Invoke-RestMethod "$base/api/batches/$($batch.batch_id)" -WebSession $surveyorSession
```

Transport limits remain 5 MiB per batch and 256 KiB per logical submission. A malformed whole JSON body fails before registration. If an operational failure prevents storing an item error, the request returns an error rather than claiming a complete durable item report; unchanged retry remains safe.

## Schema and verification

Migration 008 adds fieldmerge_ops.intake_batches (PK batch_id; author/client-key UQ; immutable manifest/count/time) and batch_items (PK batch/position; immutable content hash; optional immutable source link; latest safe error/time). Source batch_id references a registered batch. Deferred checks validate manifest cardinality/hash, source author/fingerprint, and first-attribution membership. Ordinary API accounts have no direct table privileges. There are now 16 SQL tables: nine business, two authentication, four operational/transport, and the migration registry. MongoDB still has three collections.

The verified suite has 231 database assertions (including 22 query/export/batch checks), four actual COMMIT scenarios, six concurrent SQL scenarios, ten unit groups, and 32 production API/worker groups. Integration tests independently count SQL states and MongoDB form/batch/observation groups, verify read/export permissions and literal searches, preserve historical snapshots and null/false/zero, exercise concurrent batch replay/cross-batch membership, and recover interrupted batched intake. Real 5,001-row/5,000-row fixtures verify export refusal/success at the boundary; this is not a performance benchmark.

Run .\scripts\database.ps1 Verify, pnpm test:unit, pnpm build, and pnpm test:api. Setup applies verified migrations without resetting development records. Restart an already running API/worker process after updating this code, so both use the new batch-metadata verification. The graphical interface, full acceptance/browser mapping, and measured query-performance evidence remain pending.

References: [PostgreSQL CTEs](https://www.postgresql.org/docs/current/queries-with.html), [MongoDB facets and output limits](https://www.mongodb.com/docs/manual/reference/operator/aggregation/facet/), and [OWASP CSV injection](https://owasp.org/www-community/attacks/CSV_Injection). FieldMerge's bounds, source/transport distinction, and count definitions are project design choices.
