import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { MongoClient } from "mongodb";
import { configureBackend } from "../configure-backend.mjs";
import { parseExact, canonical, sha256 } from "../../lib/canonical.mjs";
import { call, closeConnections } from "../../lib/database.mjs";
import { submit } from "../../lib/intake.mjs";
import {
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  finalizeDraft,
} from "../../lib/drafts.mjs";
import { evidenceSummary } from "../../lib/reports.mjs";
import {
  byRecord,
  categoryPipeline,
  formPipeline,
  presencePipeline,
} from "../../database/demonstrations/mongodb.mjs";

assert(
  /^fieldmerge-performance-[a-f0-9]{32}$/.test(
    process.env.FM_PERF_PROJECT ?? "",
  ),
);
assert(
  /^fieldmerge_test_[a-f0-9]{32}$/.test(process.env.FM_TEST_DATABASE ?? ""),
);
const RECORDS = 10000,
  HISTORY_RECORDS = 2000,
  REPETITIONS = 9,
  WARMUPS = 2;
const root = process.cwd(),
  out = "output/performance",
  run = promisify(execFile);
const compose = [
  "compose",
  "--project-directory",
  root,
  "-p",
  process.env.FM_PERF_PROJECT,
  "-f",
  path.join(root, "compose.yaml"),
  "-f",
  process.env.FM_PERF_OVERRIDE,
];
const admin = new pg.Client({
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.FM_TEST_DATABASE,
});
const mongoRoot = new MongoClient(
  `mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT}/?authSource=admin`,
);
const uuid = (prefix, n) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const record = (i) => uuid("51000000", i),
  exact = (value) => parseExact(JSON.stringify(value));
const note = (category, n) => ({
  category,
  note: "Synthetic benchmark observation " + n,
  observed_at: "2026-06-01T00:00:00Z",
});
const checks = [],
  demos = [],
  seen = new Set();
let expectedObservations = 0,
  db,
  authors,
  reviewer;
function check(label, value) {
  assert(value, label);
  checks.push(label);
}
function save(file, value) {
  writeFileSync(out + "/" + file, JSON.stringify(value, null, 2) + "\n");
}
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples_ms: samples,
    min_ms: sorted[0],
    median_ms: sorted[Math.floor(sorted.length / 2)],
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max_ms: sorted.at(-1),
  };
}
async function timed(fn) {
  const start = performance.now(),
    value = await fn();
  return { value, ms: performance.now() - start };
}
async function measure(fn) {
  for (let i = 0; i < WARMUPS; i++) await fn();
  const samples = [];
  let value;
  for (let i = 0; i < REPETITIONS; i++) {
    const r = await timed(fn);
    value = r.value;
    samples.push(r.ms);
  }
  return { ...stats(samples), value };
}
function track(p) {
  if (!seen.has(p.client_submission_id)) {
    seen.add(p.client_submission_id);
    expectedObservations += p.observations?.length ?? 0;
  }
}
async function send(token, p, options) {
  const receipt = await submit(token, exact(p), options);
  track(p);
  return receipt;
}
async function mint(user) {
  const token = sha256(randomBytes(32).toString("hex"));
  await admin.query("SELECT fieldmerge.api_create_session($1,$2)", [
    user,
    token,
  ]);
  return token;
}
function proposal(
  i,
  part,
  patch,
  { form = "tree-v2", version = 1, observations } = {},
) {
  return {
    client_submission_id: uuid("52000000", i * 10 + part),
    record_id: record(i),
    base_version_no: version,
    form_version: form,
    observed_at: "2026-06-01T00:00:00Z",
    patch,
    ...(observations ? { observations } : {}),
    client_metadata: { synthetic_fixture: "performance-v1" },
  };
}
const first = (i) =>
  proposal(
    i,
    1,
    {
      diameter_cm: 31,
      species: "Observed species " + (i % 20),
      guard_damage: false,
    },
    {
      form: i % 2 === 0 ? "tree-v1" : "tree-v2",
      ...(i % 2 ? { observations: [note("trunk", i)] } : {}),
    },
  );
async function review(id, field, action, chosen) {
  const c = (
    await admin.query(
      "SELECT change_id FROM fieldmerge.field_changes WHERE record_id=$1 AND field_name=$2 AND state='pending'",
      [id, field],
    )
  ).rows[0];
  assert(c);
  const comparison = await call("api_review_comparison", [
    reviewer,
    c.change_id,
  ]);
  return call("api_decide", [
    reviewer,
    crypto.randomUUID(),
    c.change_id,
    comparison.current_version_no,
    comparison.revision_no,
    action,
    action === "replace" ? canonical(chosen) : null,
    "Synthetic performance fixture review",
  ]);
}
async function counts() {
  return (
    await admin.query(`SELECT
 (SELECT count(*) FROM fieldmerge.tree_records)::int AS records,
 (SELECT count(*) FROM fieldmerge.accepted_versions)::int AS versions,
 (SELECT count(*) FROM fieldmerge.submissions)::int AS submissions,
 (SELECT count(*) FROM fieldmerge.field_changes)::int AS field_changes,
 (SELECT count(*) FROM fieldmerge.field_changes WHERE state='pending')::int AS pending_fields,
 (SELECT count(*) FROM fieldmerge.review_decisions)::int AS decisions,
 (SELECT count(*) FROM fieldmerge.audit_events)::int AS audit_events`)
  ).rows[0];
}
async function plan(id, sql, values = []) {
  const r = await admin.query(
      "EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) " + sql,
      values,
    ),
    p = r.rows[0]["QUERY PLAN"][0];
  save("plans/" + id + ".json", p);
  return {
    execution_ms: p["Execution Time"],
    planning_ms: p["Planning Time"],
    root_node: p.Plan["Node Type"],
    actual_rows: p.Plan["Actual Rows"],
    shared_hit_blocks: p.Plan["Shared Hit Blocks"] ?? 0,
    shared_read_blocks: p.Plan["Shared Read Blocks"] ?? 0,
  };
}
function sample(value) {
  return { row_count: value.length, sample: value.slice(0, 6) };
}
try {
  await admin.connect();
  await mongoRoot.connect();
  db = mongoRoot.db(process.env.FM_TEST_DATABASE);
  const config = await configureBackend({
    pgDatabase: process.env.FM_TEST_DATABASE,
    mongoDatabase: process.env.FM_TEST_DATABASE,
    save: false,
  });
  Object.assign(process.env, config);
  const start = performance.now();
  console.log("Importing 10,000 deterministic synthetic baseline records.");
  await admin.query(
    `WITH imported AS (
 INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id)
 SELECT ('51000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 '20000000-0000-4000-8000-000000000001','BENCH-'||lpad(i::text,6,'0')
 FROM generate_series(1,$1::int) i RETURNING record_id,source_record_id
 ) INSERT INTO fieldmerge.accepted_versions(record_id,version_no,species,health,diameter_cm,guard_damage,published_by)
 SELECT record_id,1,'Bench species '||(right(source_record_id,6)::int%20),'Good',30,NULL,
 '10000000-0000-4000-8000-000000000002' FROM imported`,
    [RECORDS],
  );
  const fixtureAccounts = JSON.parse(
    readFileSync("tmp/database-fixtures/demo-accounts.json", "utf8"),
  );
  authors = [await mint(fixtureAccounts[0].user_id)];
  reviewer = await mint(fixtureAccounts[1].user_id);
  for (let i = 1; i < 5; i++) {
    const id = uuid("53000000", i);
    await admin.query(
      "INSERT INTO fieldmerge.app_users(user_id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        "benchmark-" + i + "@test.invalid",
        fixtureAccounts[0].password_hash,
        "Benchmark surveyor " + i,
        "surveyor",
      ],
    );
    authors.push(await mint(id));
  }
  const batches = new Map();
  for (let author = 0; author < 5; author++) {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1).filter(
        (i) => i % 5 === author,
      ),
      hashes = ids.map((i) => sha256(canonical(exact(first(i)))));
    const b = await call("api_register_batch", [
      authors[author],
      uuid("54000000", author + 1),
      JSON.stringify(hashes),
    ]);
    ids.forEach((i, index) => batches.set(i, { id: b.batch_id, index }));
  }
  let cursor = 1,
    completed = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor <= HISTORY_RECORDS) {
        const i = cursor++,
          author = authors[i % 5],
          a = first(i);
        await send(
          author,
          a,
          batches.has(i) ? { batch: batches.get(i) } : undefined,
        );
        const b = proposal(
          i,
          2,
          {
            diameter_cm: 32,
            species: "Competing species " + (i % 20),
            health: "Fair",
          },
          { observations: [note("guard", i), note("root", i)] },
        );
        const r = await send(author, b);
        assert.equal(r.state, "partially_applied");
        if (i % 4 === 0)
          await send(
            author,
            proposal(
              i,
              3,
              {},
              { version: 3, observations: [note("other", i)] },
            ),
          );
        if (i % 10 === 0) {
          await review(
            record(i),
            "diameter_cm",
            i % 20 === 0 ? "accept_proposal" : "keep_current",
          );
          await review(
            record(i),
            "species",
            "replace",
            "Reviewed species " + (i % 20),
          );
        }
        completed++;
        if (completed % 200 === 0)
          console.log(
            "Prepared workflow history for " +
              completed +
              " / " +
              HISTORY_RECORDS +
              " records.",
          );
      }
    }),
  );
  // An actual seven-version lineage, with a health edit reversed and then challenged.
  await review(record(1), "diameter_cm", "accept_proposal");
  await review(record(1), "species", "replace", "Reviewed species 1");
  await send(authors[1], proposal(1, 4, { health: "Poor" }, { version: 5 }));
  await send(authors[1], proposal(1, 5, { health: "Fair" }, { version: 6 }));
  const reversal = await send(
    authors[1],
    proposal(1, 6, { health: "Good" }, { version: 5 }),
  );
  check(
    "Reversal creates an intervening-edit conflict",
    reversal.fields[0].pending_reason === "intervening_edit",
  );
  const duplicate = await send(authors[1], first(1), { batch: batches.get(1) });
  check(
    "Duplicate intake returns its original receipt",
    duplicate.version_no === 2,
  );
  // Real owner-scoped MongoDB draft CRUD; sealed source evidence is never deleted.
  const input = {
    record_id: record(RECORDS),
    base_version_no: 1,
    form_version: "tree-v2",
    payload: { patch: {} },
  };
  const draft = await createDraft(authors[0], exact(input));
  check(
    "Draft read returns owner document",
    (await getDraft(authors[0], draft.draft_id)).draft_id === draft.draft_id,
  );
  await assert.rejects(
    getDraft(authors[1], draft.draft_id),
    (e) => e.status === 404,
  );
  checks.push("Another surveyor cannot read the draft");
  const edited = await updateDraft(
    authors[0],
    draft.draft_id,
    exact({
      expected_revision_no: 1,
      payload: {
        observed_at: "2026-06-01T00:00:00Z",
        patch: { health: "Fair" },
      },
    }),
  );
  check("Draft update increments its revision", edited.revision_no === 2);
  const deleted = await deleteDraft(
    authors[0],
    draft.draft_id,
    exact({ expected_revision_no: 2 }),
  );
  check(
    "Only the editable draft is deleted",
    deleted.deleted === true &&
      (await db
        .collection("submission_drafts")
        .countDocuments({ _id: draft.draft_id })) === 0,
  );
  const sealed = await createDraft(
    authors[0],
    exact({
      ...input,
      payload: {
        observed_at: "2026-06-01T00:00:00Z",
        patch: { diameter_cm: 0, guard_damage: false, health: null },
        observations: [note("root", "draft")],
      },
    }),
  );
  const finalized = await finalizeDraft(
    authors[0],
    sealed.draft_id,
    exact({ expected_revision_no: 1 }),
  );
  track(JSON.parse(finalized.draft.canonical_payload_json));
  await assert.rejects(
    updateDraft(
      authors[0],
      sealed.draft_id,
      exact({
        expected_revision_no: 1,
        payload: { patch: { health: "Poor" } },
      }),
    ),
    (e) => e.code === "draft_is_sealed",
  );
  checks.push("Finalized draft cannot be edited");
  demos.push({
    id: "MCRUD",
    created: true,
    read: true,
    owner_denial: true,
    updated_revision: edited.revision_no,
    editable_deleted: true,
    sealed_source_preserved: true,
  });
  await assert.rejects(
    admin.query(
      "UPDATE fieldmerge.accepted_versions SET health='Poor' WHERE record_id=$1 AND version_no=1",
      [record(1)],
    ),
    (e) => e.code === "42501",
  );
  checks.push("History immutability trigger denies an UPDATE");
  const beforeDdl = await counts();
  const ddl = (
    await run(
      process.env.DOCKER_EXE,
      [
        ...compose,
        "exec",
        "-T",
        "postgres-test",
        "psql",
        "-X",
        "-qAt",
        "-U",
        "fieldmerge_owner",
        "-d",
        process.env.FM_TEST_DATABASE,
        "-f",
        "/database/demonstrations/sandbox-ddl.sql",
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    )
  ).stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  check(
    "DDL staging INSERT/UPDATE retains zero and false",
    ddl[0].inserted === 2 &&
      ddl[0].zero_false_rows === 1 &&
      ddl[0].updated_rows === 1,
  );
  check(
    "DDL staging DELETE affects one disposable row",
    ddl[1].remaining === 1,
  );
  assert.deepEqual(await counts(), beforeDdl);
  checks.push("CREATE/ALTER/DROP sandbox leaves business counts unchanged");
  demos.push(...ddl);
  const seedDuration = performance.now() - start,
    sqlCounts = await counts(),
    evidence = await evidenceSummary(db);
  check(
    "SQL source count equals sealed MongoDB source count",
    sqlCounts.submissions === evidence.source_count &&
      evidence.source_count === seen.size,
  );
  check(
    "Independent observation count matches MongoDB aggregate",
    evidence.observation_count === expectedObservations,
  );
  check(
    "Both controlled forms and first-intake batches are represented",
    evidence.by_form.length === 2 &&
      evidence.by_first_batch.filter((x) => x.batch_id !== null).length === 5,
  );
  check(
    "Baseline population includes the three existing synthetic seed records",
    sqlCounts.records === RECORDS + 3,
  );
  await admin.query("VACUUM (ANALYZE) fieldmerge.accepted_versions");
  await admin.query("ANALYZE fieldmerge.tree_records");
  await admin.query("ANALYZE fieldmerge.submissions");
  await admin.query("ANALYZE fieldmerge.field_changes");
  await admin.query("ANALYZE fieldmerge.review_decisions");
  await admin.query("ANALYZE fieldmerge.audit_events");
  const sqlCases = readFileSync("database/demonstrations/postgres.sql", "utf8")
    .split("-- @query ")
    .slice(1)
    .map((block) => {
      const end = block.indexOf("\n"),
        [id, ...title] = block.slice(0, end).trim().split(" ");
      return { id, title: title.join(" "), sql: block.slice(end + 1).trim() };
    });
  const sqlResults = [];
  let provenanceA, provenanceB, lineage;
  for (const q of sqlCases) {
    const values = q.sql.includes("$1")
      ? [q.id === "Q02" ? record(2) : q.id === "Q03" ? record(1000) : record(1)]
      : [];
    console.log("Measuring " + q.id + " " + q.title);
    const measured = await measure(
      async () => (await admin.query(q.sql, values)).rows,
    );
    const { value, ...timings } = measured;
    const p = await plan(q.id, q.sql, values);
    sqlResults.push({
      ...q,
      parameters: values,
      client: timings,
      server_explain: p,
      ...sample(value),
    });
    if (q.id === "Q07") provenanceA = value;
    if (q.id === "Q08") provenanceB = value;
    if (q.id === "Q06") lineage = value;
    if (q.id === "Q12")
      check(
        "SQL function validates typed zero/false and rejects string false",
        value[0].zero_valid &&
          value[0].false_valid &&
          !value[0].string_boolean_valid,
      );
  }
  assert.deepEqual(provenanceA, provenanceB);
  checks.push(
    "Scoped provenance rewrite equals the implemented view for all four fields",
  );
  check(
    "Recursive query reaches the seven-version baseline",
    lineage.length === 7 && lineage.at(-1).version_no === 1,
  );
  // Counterfactual removal/restoration of one deployed index, only in this disposable DB.
  const indexName = "submissions_record_received",
    indexDef = (
      await admin.query("SELECT pg_get_indexdef($1::regclass) AS sql", [
        "fieldmerge." + indexName,
      ])
    ).rows[0].sql;
  const submissionQuery = sqlCases.find((x) => x.id === "Q03").sql,
    submissionValues = [record(1000)],
    expected = (await admin.query(submissionQuery, submissionValues)).rows;
  const indexSamples = { with_index: [], without_index: [] };
  let indexPresent = true;
  async function mode(enabled) {
    let changed = false;
    if (enabled && !indexPresent) {
      await admin.query(indexDef);
      indexPresent = true;
      changed = true;
    }
    if (!enabled && indexPresent) {
      await admin.query("DROP INDEX fieldmerge." + indexName);
      indexPresent = false;
      changed = true;
    }
    // Index creation populates new pages: exclude the first lookup from timing.
    if (changed) await admin.query(submissionQuery, submissionValues);
  }
  try {
    for (const enabled of [false, true]) {
      await mode(enabled);
      for (let i = 0; i < WARMUPS; i++)
        await admin.query(submissionQuery, submissionValues);
    }
    for (let i = 0; i < REPETITIONS; i++)
      for (const enabled of i % 2 ? [true, false] : [false, true]) {
        await mode(enabled);
        const r = await timed(() =>
          admin.query(submissionQuery, submissionValues),
        );
        assert.deepEqual(r.value.rows, expected);
        indexSamples[enabled ? "with_index" : "without_index"].push(r.ms);
      }
    await mode(false);
    var noIndexPlan = await plan(
      "SQL-index-absent",
      submissionQuery,
      submissionValues,
    );
    await mode(true);
    var indexPlan = await plan(
      "SQL-index-present",
      submissionQuery,
      submissionValues,
    );
  } finally {
    await mode(true);
  }
  checks.push(
    "SQL index A/B returns identical rows and restores the original index",
  );
  const sqlIndex = {
    query: "Q03",
    index_definition: indexDef,
    with_index: stats(indexSamples.with_index),
    without_index: stats(indexSamples.without_index),
    with_index_plan: indexPlan,
    without_index_plan: noIndexPlan,
  };
  const mongoCases = [];
  for (const [id, pipeline] of [
    ["M02", formPipeline],
    ["M03", categoryPipeline],
    ["M04", presencePipeline],
  ]) {
    console.log("Measuring " + id + " MongoDB aggregation.");
    const r = await measure(() =>
      db
        .collection("submission_documents")
        .aggregate(pipeline, { maxTimeMS: 15000 })
        .toArray(),
    );
    const { value, ...client } = r;
    save(
      "plans/" + id + ".json",
      await db
        .collection("submission_documents")
        .aggregate(pipeline, { maxTimeMS: 15000 })
        .explain("executionStats"),
    );
    mongoCases.push({ id, pipeline, client, ...sample(value) });
  }
  const natural = [],
    indexed = [],
    target = record(1000),
    reference = await byRecord(db, target).toArray();
  for (const hint of [{ $natural: 1 }, { record_id: 1, received_at: 1 }])
    for (let i = 0; i < WARMUPS; i++)
      await byRecord(db, target, hint).toArray();
  for (let i = 0; i < REPETITIONS; i++)
    for (const scan of i % 2
      ? ["indexed", "natural"]
      : ["natural", "indexed"]) {
      const r = await timed(() =>
        byRecord(
          db,
          target,
          scan === "natural"
            ? { $natural: 1 }
            : { record_id: 1, received_at: 1 },
        ).toArray(),
      );
      assert.deepEqual(r.value, reference);
      (scan === "natural" ? natural : indexed).push(r.ms);
    }
  const mongoPlans = {};
  for (const [id, hint] of [
    ["natural", { $natural: 1 }],
    ["indexed", { record_id: 1, received_at: 1 }],
    ["optimizer", undefined],
  ]) {
    const p = await byRecord(db, target, hint).explain("executionStats");
    save("plans/M01-" + id + ".json", p);
    mongoPlans[id] = {
      returned: p.executionStats.nReturned,
      documents_examined: p.executionStats.totalDocsExamined,
      keys_examined: p.executionStats.totalKeysExamined,
      execution_time_ms: p.executionStats.executionTimeMillis,
    };
  }
  check(
    "MongoDB index and natural scans return identical source references",
    reference.length === 3 &&
      mongoPlans.indexed.returned === mongoPlans.natural.returned,
  );
  checks.push(
    "MongoDB A/B uses the existing record/time index; no production index changed",
  );
  const wrapped = [];
  for (const [id, fn] of [
    [
      "W01",
      () =>
        call("api_records_page", [
          authors[0],
          null,
          null,
          null,
          true,
          null,
          20,
        ]),
    ],
    ["W02", () => call("api_history", [authors[0], record(1)])],
    ["W03", () => call("api_sql_summary", [reviewer])],
    ["W04", () => evidenceSummary(db)],
  ]) {
    console.log("Measuring " + id + " application query path.");
    const { value, ...client } = await measure(fn);
    wrapped.push({
      id,
      client,
      result_hash: digest(value),
      meaning: id === "W04" ? "MongoDB facets" : "Restricted SQL wrapper",
    });
  }
  // Independent read-only storage/runtime metadata, without secrets or machine hostname.
  const pgVersion = (await admin.query("SHOW server_version")).rows[0]
      .server_version,
    settings = {};
  for (const setting of [
    "shared_buffers",
    "effective_cache_size",
    "random_page_cost",
    "max_parallel_workers_per_gather",
    "jit",
    "default_statistics_target",
  ])
    settings[setting] = (await admin.query("SHOW " + setting)).rows[0][setting];
  const build = await db.admin().command({ buildInfo: 1 }),
    server = await db.admin().command({ serverStatus: 1 }),
    collection = await db.command({ collStats: "submission_documents" });
  const storage = (
    await admin.query(
      "SELECT relname,pg_table_size(relid) AS table_bytes,pg_indexes_size(relid) AS index_bytes FROM pg_stat_user_tables WHERE schemaname='fieldmerge' ORDER BY relname",
    )
  ).rows;
  save("results.json", {
    verified_at_utc: new Date().toISOString(),
    fixture: {
      version: "performance-v1",
      synthetic: true,
      baseline_records: RECORDS,
      history_records: HISTORY_RECORDS,
      seeding_parallelism: 4,
      seed_wall_ms: seedDuration,
      sql_counts: sqlCounts,
      mongo_source_documents: evidence.source_count,
      mongo_observations: evidence.observation_count,
      first_intake_batches: 5,
      meaning:
        "Synthetic data demonstrates behavior; it is not evidence of real-world problem prevalence.",
    },
    method: {
      repetitions: REPETITIONS,
      warmups: WARMUPS,
      cache:
        "Warmed runs after fixture generation and ANALYZE; no cache flush or cold-start claim.",
      clients: "Single measurement client; seeding used four workers.",
      latency:
        "Client timings include loopback database calls/decoding; SQL EXPLAIN times measure instrumented server execution. No HTTP/browser latency or production SLA is claimed.",
      ab: "Index A/B modes are interleaved; MongoDB hints are counterfactual controls. Provenance queries run as separately warmed sequential cases.",
    },
    runtime: {
      postgresql: pgVersion,
      postgresql_settings: settings,
      mongodb: build.version,
      mongodb_storage_engine: server.storageEngine.name,
    },
    storage: {
      postgresql: storage,
      mongo: {
        documents: collection.count,
        data_bytes: collection.size,
        storage_bytes: collection.storageSize,
        total_index_bytes: collection.totalIndexSize,
      },
    },
    sql: sqlResults,
    sql_index_comparison: sqlIndex,
    mongodb: {
      cases: mongoCases,
      record_lookup: {
        target,
        natural: stats(natural),
        indexed: stats(indexed),
        plans: mongoPlans,
      },
    },
    application_paths: wrapped,
    checks,
  });
  save("demonstrations.json", {
    checks,
    dml: demos,
    source_evidence_counts: evidence,
  });
  console.log(
    "Passed " +
      checks.length +
      " evidence checks. Read measurements and full plans are saved.",
  );
} finally {
  await closeConnections();
  await mongoRoot.close();
  await admin.end();
}
