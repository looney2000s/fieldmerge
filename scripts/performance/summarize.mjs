import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const dir = "output/performance",
  read = (f) => JSON.parse(readFileSync(dir + "/" + f, "utf8"));
const r = read("results.json"),
  e = read("environment.json"),
  v = read("verification.json");
assert.equal(v.status, "passed");
assert(v.cleanup_completed || v.kept_for_inspection);
const n = (x) => Number(x).toFixed(3),
  gib = (x) => (x / 1024 ** 3).toFixed(1),
  sql = r.sql_index_comparison,
  m = r.mongodb.record_lookup;
const rows = r.sql
  .map(
    (q) =>
      `| ${q.id} | ${q.row_count} | ${n(q.client.median_ms)} | ${n(q.client.p95_ms)} | ${n(q.server_explain.execution_ms)} |`,
  )
  .join("\n");
const mongoRows = r.mongodb.cases
  .map(
    (q) =>
      `| ${q.id} | ${q.row_count} | ${n(q.client.median_ms)} | ${n(q.client.p95_ms)} |`,
  )
  .join("\n");
writeFileSync(
  dir + "/README.md",
  `# FieldMerge measured database evidence

Recorded ${r.verified_at_utc}. The runner passed ${r.checks.length} evidence checks. The disposable project was ${v.cleanup_completed ? "removed after the run" : "explicitly kept for inspection"}. Development data and application migrations were unchanged.

## Data and machine

| Fixture quantity | Count |
|---|---:|
| Accepted records, including three original seed records | ${r.fixture.sql_counts.records} |
| Immutable accepted snapshots | ${r.fixture.sql_counts.versions} |
| SQL source submissions / sealed MongoDB envelopes | ${r.fixture.sql_counts.submissions} / ${r.fixture.mongo_source_documents} |
| Proposed field changes / currently pending fields | ${r.fixture.sql_counts.field_changes} / ${r.fixture.sql_counts.pending_fields} |
| Reviewer decisions | ${r.fixture.sql_counts.decisions} |
| Supporting observations | ${r.fixture.mongo_observations} |
| First-intake batches | ${r.fixture.first_intake_batches} |

The runner imports ${r.fixture.baseline_records} deterministic synthetic records and creates real workflow history on ${r.fixture.history_records} of them. Four bounded workers call normal guarded intake/review functions and store matching MongoDB evidence. Both forms, five surveyors, compatible merges, conflicts, decisions, evidence-only submissions, explicit unknown/false/zero, and a seven-version reversal are represented. Receipt times, generated request/decision IDs and execution timings vary. No production constraints, publication triggers or source verification were disabled. Synthetic records demonstrate functionality, not real-world prevalence or adoption.

Host: ${e.host.platform} ${e.host.release}, ${e.host.cpu}, ${e.host.logical_cpus} logical CPUs, ${gib(e.host.total_memory_bytes)} GiB usable host memory. Docker reports ${e.docker_engine.cpus} CPUs and ${gib(e.docker_engine.memory_bytes)} GiB memory. Containers share those resources without an individual CPU/memory quota. PostgreSQL ${r.runtime.postgresql}, MongoDB ${r.runtime.mongodb} (${r.runtime.mongodb_storage_engine}), Node ${e.node}. Full image digests, PostgreSQL settings and storage sizes are recorded in [environment.json](environment.json) and [results.json](results.json). These are local Docker measurements, not hosted-production results.

## Method

Each normal read case has ${r.method.warmups} untimed warm-ups and ${r.method.repetitions} measured executions from one client. SQL statistics were refreshed with ANALYZE; accepted_versions also received VACUUM ANALYZE. No cold-cache/reset experiment was conducted. SQL index modes are interleaved, with an additional untimed lookup after each index change. DDL/index construction time is excluded. MongoDB scan modes are also interleaved. Provenance variants run as separate warmed cases rather than randomized A/B trials.

Client times include Node/driver work, the loopback connection into Docker and result decoding. PostgreSQL server times below are one EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) sample; they are not the client median. EXPLAIN adds instrumentation, and root buffer counts include repeated accesses rather than a distinct count of physical pages. See [PostgreSQL's EXPLAIN guide](https://www.postgresql.org/docs/18/using-explain.html).

The displayed p95 is a nearest-rank descriptive statistic of only nine samples, so it equals the sample maximum here. It is not a reliable production-tail estimate. Values are rounded to three decimal places; raw samples remain in JSON. There was no HTTP/browser load test, throughput test, concurrent-user capacity measurement or statistical-significance claim.

## SQL demonstrations

The executable [SQL catalogue](../../database/demonstrations/postgres.sql) explains Q01–Q12. Every query's SQL, parameters, sample results, client samples and server-plan summary are in [results.json](results.json). Complete plans are in [plans](plans).

| Query | Returned rows | Client median ms | Sample p95 ms | One server EXPLAIN ms |
|---|---:|---:|---:|---:|
${rows}

## Existing SQL index comparison

Q03 retrieves one tree's submission history in receipt/reference order. Only the disposable copy of submissions_record_received was removed and restored; all other indexes and data remained. Both modes returned identical rows and the original index definition was restored.

| Mode | Client median ms | Sample p95 ms | One server EXPLAIN ms | Root shared buffer hits + reads |
|---|---:|---:|---:|---:|
| Existing record/receipt index | ${n(sql.with_index.median_ms)} | ${n(sql.with_index.p95_ms)} | ${n(sql.with_index_plan.execution_ms)} | ${sql.with_index_plan.shared_hit_blocks + sql.with_index_plan.shared_read_blocks} |
| Same query with that index absent | ${n(sql.without_index.median_ms)} | ${n(sql.without_index.p95_ms)} | ${n(sql.without_index_plan.execution_ms)} | ${sql.without_index_plan.shared_hit_blocks + sql.without_index_plan.shared_read_blocks} |

Read [present-index plan](plans/SQL-index-present.json) and [absent-index plan](plans/SQL-index-absent.json) for the actual access paths. The small client-time difference should not be advertised as a large website speedup; client/driver latency and timing variation are material at this scale. The plan and buffer changes explain the narrower access path more directly.

Q07 (existing provenance view) and Q08 (record-scoped CTE) returned exactly the same four fields, values, origins and decisions for the seven-version record. Their client medians were ${n(r.sql.find((x) => x.id === "Q07").client.median_ms)} and ${n(r.sql.find((x) => x.id === "Q08").client.median_ms)} ms. This single small fixture comparison does not justify replacing the application view on timing alone; the rewrite remains an inspection/demo alternative. No optimization migration was introduced.

## MongoDB evidence queries

M01 reads one record's source references; M02 groups documents by form; M03 unwinds repeated observations into category totals; M04 converts patch objects into field-presence/explicit-null counts. These operations inspect source evidence, not accepted SQL truth. [Executable queries](../../database/demonstrations/mongodb.mjs).

| Aggregate | Returned groups | Client median ms | Sample p95 ms |
|---|---:|---:|---:|
${mongoRows}

| M01 mode | Client median ms | Documents examined | Keys examined | Returned documents |
|---|---:|---:|---:|---:|
| Forced natural scan | ${n(m.natural.median_ms)} | ${m.plans.natural.documents_examined} | ${m.plans.natural.keys_examined} | ${m.plans.natural.returned} |
| Existing record/time index hint | ${n(m.indexed.median_ms)} | ${m.plans.indexed.documents_examined} | ${m.plans.indexed.keys_examined} | ${m.plans.indexed.returned} |
| Optimizer without a hint | Not separately timed | ${m.plans.optimizer.documents_examined} | ${m.plans.optimizer.keys_examined} | ${m.plans.optimizer.returned} |

Both timed modes returned identical source references. Hints deliberately establish scan alternatives; they are not application changes. The unhinted plan is saved separately to show what the optimizer actually selected. MongoDB explains use integer-millisecond server timing, so zero in that field is not zero work. Documents examined can include nonmatching documents; see [MongoDB explain results](https://www.mongodb.com/docs/v8.0/reference/explain-results/). Form/category/presence aggregates cover the whole evidence collection and are not claimed to benefit from the point-lookup index.

## Application read paths and mutation demonstrations

| Path | Operation | Client median ms |
|---|---|---:|
${r.application_paths.map((x) => `| ${x.id} | ${{ W01: "Restricted records-page SQL wrapper", W02: "Restricted history/provenance SQL wrapper", W03: "Restricted SQL summary wrapper", W04: "Application MongoDB facets function" }[x.id]} | ${n(x.client.median_ms)} |`).join("\n")}

W01–W03 include actual SQL session/role checks through the restricted API login. W04 invokes the application aggregate function using the fixture inspection connection. These are database-call measurements, not HTTP routes. Administrative SQL plans are shown for inspection because the API login cannot directly read business tables.

The [demonstration checks](demonstrations.json) also record owner-scoped MongoDB draft create/read/update/delete, wrong-owner denial, sealed-draft protection, compatible intake, duplicate retry, reversal conflict, SQL validation, immutability-trigger denial, and independent cross-store counts. The [staging DDL/DML script](../../database/demonstrations/sandbox-ddl.sql) executes CREATE, ALTER, INSERT, UPDATE, DELETE, index/view creation and DROP inside a rolled-back disposable sandbox. Negative diameter fails its CHECK. Business-table counts remain unchanged by that sandbox. No accepted history or sealed evidence was deleted for a CRUD demonstration.

## Reproduce and inspect

Run pnpm db:evidence followed by pnpm db:evidence:summary with Docker Desktop running and local fixtures/dependencies prepared. Use pnpm run db:evidence --keep to retain the unique project for interactive inspection; otherwise all measurement services are removed. [Query/viva guide](../../docs/FieldMerge_Query_Demonstrations.md) explains the catalogue, parameters and cleanup. A rerun replaces these outputs with new measurements. [Source hashes](source-checksums.json) and [verification](verification.json) identify the run; no performance guarantee is implied.
`,
);
const csv = [
  ["query", "layer", "returned_rows", "median_ms", "sample_p95_ms"],
  ...r.sql.map((q) => [
    q.id,
    "postgresql_client",
    q.row_count,
    n(q.client.median_ms),
    n(q.client.p95_ms),
  ]),
  ...r.mongodb.cases.map((q) => [
    q.id,
    "mongodb_client",
    q.row_count,
    n(q.client.median_ms),
    n(q.client.p95_ms),
  ]),
]
  .map((row) =>
    row.map((x) => '"' + String(x).replaceAll('"', '""') + '"').join(","),
  )
  .join("\r\n");
writeFileSync(dir + "/timings.csv", csv + "\r\n");
console.log(
  "Wrote output/performance/README.md and timings.csv from the recorded measurements.",
);
