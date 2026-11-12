# FieldMerge measured database evidence

Recorded 2026-11-12T06:06:57.102Z. The runner passed 21 evidence checks. The disposable project was removed after the run. Development data and application migrations were unchanged.

## Data and machine

| Fixture quantity | Count |
|---|---:|
| Accepted records, including three original seed records | 10003 |
| Immutable accepted snapshots | 14308 |
| SQL source submissions / sealed MongoDB envelopes | 4504 / 4504 |
| Proposed field changes / currently pending fields | 12006 / 3599 |
| Reviewer decisions | 402 |
| Supporting observations | 5501 |
| First-intake batches | 5 |

The runner imports 10000 deterministic synthetic records and creates real workflow history on 2000 of them. Four bounded workers call normal guarded intake/review functions and store matching MongoDB evidence. Both forms, five surveyors, compatible merges, conflicts, decisions, evidence-only submissions, explicit unknown/false/zero, and a seven-version reversal are represented. Receipt times, generated request/decision IDs and execution timings vary. No production constraints, publication triggers or source verification were disabled. Synthetic records demonstrate functionality, not real-world prevalence or adoption.

Host: win32 10.0.26200, 13th Gen Intel(R) Core(TM) i5-13450HX, 16 logical CPUs, 23.7 GiB usable host memory. Docker reports 16 CPUs and 11.5 GiB memory. Containers share those resources without an individual CPU/memory quota. PostgreSQL 18.6, MongoDB 8.0.34 (wiredTiger), Node v26.13.0. Full image digests, PostgreSQL settings and storage sizes are recorded in [environment.json](environment.json) and [results.json](results.json). These are local Docker measurements, not hosted-production results.

## Method

Each normal read case has 2 untimed warm-ups and 9 measured executions from one client. SQL statistics were refreshed with ANALYZE; accepted_versions also received VACUUM ANALYZE. No cold-cache/reset experiment was conducted. SQL index modes are interleaved, with an additional untimed lookup after each index change. DDL/index construction time is excluded. MongoDB scan modes are also interleaved. Provenance variants run as separate warmed cases rather than randomized A/B trials.

Client times include Node/driver work, the loopback connection into Docker and result decoding. PostgreSQL server times below are one EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) sample; they are not the client median. EXPLAIN adds instrumentation, and root buffer counts include repeated accesses rather than a distinct count of physical pages. See [PostgreSQL's EXPLAIN guide](https://www.postgresql.org/docs/18/using-explain.html).

The displayed p95 is a nearest-rank descriptive statistic of only nine samples, so it equals the sample maximum here. It is not a reliable production-tail estimate. Values are rounded to three decimal places; raw samples remain in JSON. There was no HTTP/browser load test, throughput test, concurrent-user capacity measurement or statistical-significance claim.

## SQL demonstrations

The executable [SQL catalogue](../../database/demonstrations/postgres.sql) explains Q01–Q12. Every query's SQL, parameters, sample results, client samples and server-plan summary are in [results.json](results.json). Complete plans are in [plans](plans).

| Query | Returned rows | Client median ms | Sample p95 ms | One server EXPLAIN ms |
|---|---:|---:|---:|---:|
| Q01 | 20 | 10.447 | 10.996 | 8.366 |
| Q02 | 2 | 1.770 | 1.900 | 0.119 |
| Q03 | 3 | 1.178 | 1.435 | 0.049 |
| Q04 | 20 | 3.178 | 3.939 | 1.857 |
| Q05 | 20 | 9.462 | 10.624 | 7.632 |
| Q06 | 7 | 1.319 | 2.048 | 0.108 |
| Q07 | 4 | 2.410 | 2.676 | 0.295 |
| Q08 | 4 | 1.989 | 2.998 | 0.253 |
| Q09 | 7 | 1.005 | 1.354 | 0.063 |
| Q10 | 1 | 9.251 | 12.121 | 8.255 |
| Q11 | 3 | 9.705 | 12.503 | 8.474 |
| Q12 | 1 | 0.782 | 0.878 | 0.003 |

## Existing SQL index comparison

Q03 retrieves one tree's submission history in receipt/reference order. Only the disposable copy of submissions_record_received was removed and restored; all other indexes and data remained. Both modes returned identical rows and the original index definition was restored.

| Mode | Client median ms | Sample p95 ms | One server EXPLAIN ms | Root shared buffer hits + reads |
|---|---:|---:|---:|---:|
| Existing record/receipt index | 0.932 | 1.189 | 0.046 | 5 |
| Same query with that index absent | 1.063 | 1.727 | 0.163 | 79 |

Read [present-index plan](plans/SQL-index-present.json) and [absent-index plan](plans/SQL-index-absent.json) for the actual access paths. The small client-time difference should not be advertised as a large website speedup; client/driver latency and timing variation are material at this scale. The plan and buffer changes explain the narrower access path more directly.

Q07 (existing provenance view) and Q08 (record-scoped CTE) returned exactly the same four fields, values, origins and decisions for the seven-version record. Their client medians were 2.410 and 1.989 ms. This single small fixture comparison does not justify replacing the application view on timing alone; the rewrite remains an inspection/demo alternative. No optimization migration was introduced.

## MongoDB evidence queries

M01 reads one record's source references; M02 groups documents by form; M03 unwinds repeated observations into category totals; M04 converts patch objects into field-presence/explicit-null counts. These operations inspect source evidence, not accepted SQL truth. [Executable queries](../../database/demonstrations/mongodb.mjs).

| Aggregate | Returned groups | Client median ms | Sample p95 ms |
|---|---:|---:|---:|
| M02 | 2 | 9.637 | 10.900 |
| M03 | 4 | 10.150 | 11.180 |
| M04 | 4 | 16.527 | 18.109 |

| M01 mode | Client median ms | Documents examined | Keys examined | Returned documents |
|---|---:|---:|---:|---:|
| Forced natural scan | 2.975 | 4504 | 0 | 3 |
| Existing record/time index hint | 1.414 | 3 | 3 | 3 |
| Optimizer without a hint | Not separately timed | 3 | 3 | 3 |

Both timed modes returned identical source references. Hints deliberately establish scan alternatives; they are not application changes. The unhinted plan is saved separately to show what the optimizer actually selected. MongoDB explains use integer-millisecond server timing, so zero in that field is not zero work. Documents examined can include nonmatching documents; see [MongoDB explain results](https://www.mongodb.com/docs/v8.0/reference/explain-results/). Form/category/presence aggregates cover the whole evidence collection and are not claimed to benefit from the point-lookup index.

## Application read paths and mutation demonstrations

| Path | Operation | Client median ms |
|---|---|---:|
| W01 | Restricted records-page SQL wrapper | 11.435 |
| W02 | Restricted history/provenance SQL wrapper | 2.642 |
| W03 | Restricted SQL summary wrapper | 17.582 |
| W04 | Application MongoDB facets function | 27.900 |

W01–W03 include actual SQL session/role checks through the restricted API login. W04 invokes the application aggregate function using the fixture inspection connection. These are database-call measurements, not HTTP routes. Administrative SQL plans are shown for inspection because the API login cannot directly read business tables.

The [demonstration checks](demonstrations.json) also record owner-scoped MongoDB draft create/read/update/delete, wrong-owner denial, sealed-draft protection, compatible intake, duplicate retry, reversal conflict, SQL validation, immutability-trigger denial, and independent cross-store counts. The [staging DDL/DML script](../../database/demonstrations/sandbox-ddl.sql) executes CREATE, ALTER, INSERT, UPDATE, DELETE, index/view creation and DROP inside a rolled-back disposable sandbox. Negative diameter fails its CHECK. Business-table counts remain unchanged by that sandbox. No accepted history or sealed evidence was deleted for a CRUD demonstration.

## Reproduce and inspect

Run pnpm db:evidence followed by pnpm db:evidence:summary with Docker Desktop running and local fixtures/dependencies prepared. Use pnpm run db:evidence --keep to retain the unique project for interactive inspection; otherwise all measurement services are removed. [Query/viva guide](../../docs/FieldMerge_Query_Demonstrations.md) explains the catalogue, parameters and cleanup. A rerun replaces these outputs with new measurements. [Source hashes](source-checksums.json) and [verification](verification.json) identify the run; no performance guarantee is implied.
