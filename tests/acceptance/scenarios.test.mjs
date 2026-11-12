import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import pg from "pg";
import { MongoClient } from "mongodb";
import { submit } from "../../lib/intake.mjs";
import { parseExact, sha256, canonical } from "../../lib/canonical.mjs";
import { pool, call, closeConnections } from "../../lib/database.mjs";
assert(
  /^fieldmerge_test_[a-f0-9]{32}$/.test(process.env.FM_TEST_DATABASE ?? ""),
);
assert(
  /^fieldmerge-acceptance-[a-f0-9]{32}$/.test(
    process.env.FM_TEST_COMPOSE_PROJECT ?? "",
  ),
);
const base = process.env.API_BASE,
  accounts = JSON.parse(
    readFileSync("tmp/database-fixtures/demo-accounts.json", "utf8"),
  ),
  run = promisify(execFile);
const docker =
  process.env.DOCKER_EXE ??
  path.join(
    process.env.USERPROFILE,
    "AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe",
  );
const compose = [
  "compose",
  "--project-directory",
  process.cwd(),
  "-p",
  process.env.FM_TEST_COMPOSE_PROJECT,
  "-f",
  path.join(process.cwd(), "compose.yaml"),
  "-f",
  process.env.FM_TEST_COMPOSE_OVERRIDE,
];
const adminConfig = {
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.FM_TEST_DATABASE,
};
const admin = new pg.Client(adminConfig),
  mongoRoot = new MongoClient(
    `mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT}/?authSource=admin`,
    { serverSelectionTimeoutMS: 2000, socketTimeoutMS: 3000 },
  );
const results = [];
let surveyor, reviewer, otherSurveyor, otherReviewer, token, db;
async function cli(args) {
  return (
    await run(docker, args, { timeout: 90000, maxBuffer: 2 * 1024 * 1024 })
  ).stdout.trim();
}
async function request(
  route,
  { cookie = surveyor, method = "GET", value, raw } = {},
) {
  const r = await fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: base,
      "Content-Type": "application/json",
    },
    body: raw ?? (value === undefined ? undefined : JSON.stringify(value)),
    signal: AbortSignal.timeout(45000),
  });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function login(account) {
  const r = await request("/api/auth/login", {
    method: "POST",
    value: { email: account.email, password: account.password },
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
before(async () => {
  await admin.connect();
  await mongoRoot.connect();
  db = mongoRoot.db(process.env.MONGODB_DATABASE);
  surveyor = await login(accounts[0]);
  reviewer = await login(accounts[1]);
  token = sha256(surveyor.split("=")[1]);
  for (const role of ["surveyor", "reviewer"]) {
    const id = randomUUID(),
      email = id + "@acceptance.invalid",
      account = accounts.find((a) => a.role === role);
    await admin.query(
      "INSERT INTO fieldmerge.app_users(user_id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5)",
      [id, email, account.password_hash, "Other " + role, role],
    );
    const cookie = await login({ email, password: account.password });
    if (role === "surveyor") otherSurveyor = cookie;
    else otherReviewer = cookie;
  }
});
after(async () => {
  writeFileSync(
    "output/acceptance/scenarios.json",
    JSON.stringify(
      {
        verified_at_utc: new Date().toISOString(),
        total: results.length,
        passed: results.filter((x) => x.status === "passed").length,
        scenarios: results,
      },
      null,
      2,
    ) + "\n",
  );
  await closeConnections();
  await mongoRoot.close();
  await admin.end();
});
function scenario(id, title, layers, fn) {
  const result = { id, title, layers, status: "not_run" };
  results.push(result);
  test(id + " " + title, { timeout: 120000 }, async () => {
    const start = performance.now();
    try {
      await fn();
      result.status = "passed";
    } catch (e) {
      result.status = "failed";
      result.failure_type = e.name;
      throw e;
    } finally {
      result.duration_ms = Math.round(performance.now() - start);
    }
  });
}
async function tree() {
  const id = randomUUID();
  await admin.query("BEGIN");
  try {
    await admin.query(
      "INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) VALUES($1,$2,$3)",
      [id, "20000000-0000-4000-8000-000000000001", "AC-" + id],
    );
    await admin.query(
      "INSERT INTO fieldmerge.accepted_versions(record_id,version_no,species,health,diameter_cm,guard_damage,published_by) VALUES($1,1,'Demo species','Good',30,true,$2)",
      [id, accounts[1].user_id],
    );
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
  return id;
}
const envelope = (
  id,
  patch,
  { version = 1, form = "tree-v2", stamp = "2026-06-01T00:00:00Z" } = {},
) => ({
  client_submission_id: randomUUID(),
  record_id: id,
  base_version_no: version,
  form_version: form,
  observed_at: stamp,
  patch,
});
async function send(p) {
  const r = await request("/api/submissions", { method: "POST", value: p });
  assert.equal(r.status, 200);
  return r.body;
}
async function current(id) {
  return (
    await admin.query(
      "SELECT * FROM fieldmerge.latest_accepted_records WHERE record_id=$1",
      [id],
    )
  ).rows[0];
}
async function count(table, id, key = "record_id") {
  assert(
    [
      "accepted_versions",
      "submissions",
      "field_changes",
      "audit_events",
      "review_decisions",
    ].includes(table),
  );
  assert(["record_id", "submission_id", "change_id"].includes(key));
  return Number(
    (
      await admin.query(
        `SELECT count(*) AS n FROM fieldmerge.${table} WHERE ${key}=$1`,
        [id],
      )
    ).rows[0].n,
  );
}
async function history(id) {
  const r = await request("/api/records/" + id + "/history");
  assert.equal(r.status, 200);
  return r.body;
}
async function pending(id) {
  await send(envelope(id, { diameter_cm: 32 }));
  const p = envelope(id, { diameter_cm: 36 }),
    s = await send(p);
  assert.equal(s.state, "needs_review");
  const r = await request("/api/reviews?record_id=" + id, { cookie: reviewer });
  assert.equal(r.status, 200);
  return { p, s, c: r.body.changes[0] };
}
const command = (c, action = "accept_proposal") => ({
  client_decision_id: randomUUID(),
  expected_version_no: c.current_version_no,
  expected_change_revision: c.revision_no,
  action,
  reason: "Synthetic acceptance evidence reviewed.",
});
async function decide(c, body = command(c), cookie = reviewer) {
  return request("/api/reviews/" + c.change_id, {
    cookie,
    method: "POST",
    value: body,
  });
}
const obs = (note, stamp = "2026-06-01T00:00:00Z", category = "trunk") => ({
  category,
  note,
  observed_at: stamp,
});
async function sourceRow(p) {
  return (
    await admin.query(
      "SELECT * FROM fieldmerge.submissions WHERE author_id=$1 AND client_submission_id=$2",
      [accounts[0].user_id, p.client_submission_id],
    )
  ).rows[0];
}
async function onePublication(id, version = 2) {
  assert.equal((await current(id)).version_no, version);
  assert.equal(await count("accepted_versions", id), version);
}
async function race(id, requests) {
  const locker = new pg.Client(adminConfig);
  await locker.connect();
  await locker.query("BEGIN");
  await locker.query(
    "SELECT record_id FROM fieldmerge.tree_records WHERE record_id=$1 FOR UPDATE",
    [id],
  );
  const responses = Promise.all(requests.map((fn) => fn()));
  responses.catch(() => {});
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const n = Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1 AND usename='fieldmerge_api' AND wait_event_type='Lock'",
            [process.env.FM_TEST_DATABASE],
          )
        ).rows[0].n,
      );
      if (n >= requests.length) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert(
      waiting,
      "Both application transactions must reach the held SQL record lock",
    );
  } finally {
    await locker.query("ROLLBACK");
    await locker.end();
  }
  return responses;
}

scenario(
  "AC01",
  "Compatible diameter publishes one version",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      r = await send(envelope(id, { diameter_cm: 32 }));
    assert.equal(r.state, "applied");
    assert.equal((await current(id)).diameter_cm, "32");
    await onePublication(id);
  },
);
scenario(
  "AC02",
  "Independent stale-base changes preserve both values",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree();
    await send(envelope(id, { diameter_cm: 32 }));
    await send(envelope(id, { health: "Fair" }));
    const v = await current(id);
    assert.equal(v.diameter_cm, "32");
    assert.equal(v.health, "Fair");
    assert.equal(v.version_no, 3);
  },
);
scenario(
  "AC03",
  "Competing value remains pending",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      { s } = await pending(id);
    assert.equal((await current(id)).diameter_cm, "32");
    assert.equal(s.fields[0].state, "pending");
    await onePublication(id);
  },
);
scenario(
  "AC04",
  "Already represented does not steal provenance",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      first = await send(envelope(id, { diameter_cm: 32 }));
    const before = (await history(id)).provenance;
    const r = await send(envelope(id, { diameter_cm: 32 }));
    assert.equal(r.fields[0].state, "already_represented");
    assert.equal(r.version_no, null);
    assert.deepEqual((await history(id)).provenance, before);
    assert.equal(
      before.find((x) => x.field_name === "diameter_cm").origin_submission_id,
      first.submission_id,
    );
    await onePublication(id);
  },
);
scenario(
  "AC05",
  "Base-equal proposal does not revert current",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree();
    await send(envelope(id, { diameter_cm: 32 }));
    const r = await send(envelope(id, { diameter_cm: 30 }));
    assert.equal(r.fields[0].state, "no_change");
    assert.equal((await current(id)).diameter_cm, "32");
    await onePublication(id);
  },
);
scenario(
  "AC06",
  "Change then reversal still conflicts",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree();
    await send(envelope(id, { diameter_cm: 32 }));
    await send(envelope(id, { diameter_cm: 30 }, { version: 2 }));
    const r = await send(envelope(id, { diameter_cm: 36 }));
    assert.equal(r.state, "needs_review");
    assert.equal(r.fields[0].pending_reason, "intervening_edit");
    assert.equal((await current(id)).diameter_cm, "30");
    await onePublication(id, 3);
  },
);
scenario(
  "AC07",
  "Omitted diameter remains unchanged",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      r = await send(envelope(id, { health: "Poor" }));
    assert.equal(r.fields.length, 1);
    assert.equal(r.fields[0].field_name, "health");
    assert.equal((await current(id)).diameter_cm, "30");
  },
);
scenario(
  "AC08",
  "Explicit null clears a known guard value",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      p = envelope(id, { guard_damage: null }),
      r = await send(p);
    assert.equal((await current(id)).guard_damage, null);
    assert.equal(
      (
        await db
          .collection("submission_documents")
          .findOne({ _id: r.submission_id })
      ).payload.patch.guard_damage,
      null,
    );
    await onePublication(id);
  },
);
scenario(
  "AC09",
  "String boolean rejects the entire item",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      r = await request("/api/submissions", {
        method: "POST",
        value: envelope(id, { health: "Poor", guard_damage: "false" }),
      });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_boolean");
    assert.equal((await current(id)).health, "Good");
    assert.equal(await count("submissions", id), 0);
    await onePublication(id, 1);
  },
);
scenario(
  "AC10",
  "Numeric zero remains a known value",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree();
    await send(envelope(id, { diameter_cm: 0 }));
    assert.equal((await current(id)).diameter_cm, "0");
    await onePublication(id);
  },
);
scenario(
  "AC11",
  "One invalid field prevents every publication",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      r = await request("/api/submissions", {
        method: "POST",
        value: envelope(id, { health: "Poor", diameter_cm: -1 }),
      });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_diameter");
    assert.equal((await current(id)).health, "Good");
    assert.equal(await count("field_changes", id), 0);
    assert.equal(await count("submissions", id), 0);
    await onePublication(id, 1);
  },
);
scenario(
  "AC12",
  "Compatible health publishes while diameter waits",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree();
    await send(envelope(id, { diameter_cm: 32 }));
    const r = await send(envelope(id, { diameter_cm: 36, health: "Fair" }));
    assert.equal(r.state, "partially_applied");
    assert.equal(
      r.fields.find((x) => x.field_name === "diameter_cm").state,
      "pending",
    );
    assert.equal(
      r.fields.find((x) => x.field_name === "health").state,
      "applied",
    );
    const v = await current(id);
    assert.equal(v.health, "Fair");
    assert.equal(v.diameter_cm, "32");
    await onePublication(id, 3);
  },
);
scenario(
  "AC13",
  "Missing base, unknown patch field and unsupported form have distinct errors",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree();
    for (const [p, code] of [
      [
        envelope(id, { health: "Fair" }, { version: 999 }),
        "base_version_not_found",
      ],
      [envelope(id, { bogus: true }), "unknown_patch_field"],
      [
        envelope(id, { health: "Fair" }, { form: "tree-v99" }),
        "unsupported_form",
      ],
    ]) {
      const r = await request("/api/submissions", { method: "POST", value: p });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, code);
    }
    assert.equal(await count("submissions", id), 0);
    await onePublication(id, 1);
  },
);
scenario(
  "AC14",
  "Three identical uploads produce one source and effect",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      p = envelope(id, { diameter_cm: 32 }),
      first = await send(p);
    assert.deepEqual(await send(p), first);
    assert.deepEqual(await send(p), first);
    assert.equal(await count("submissions", id), 1);
    assert.equal(await count("audit_events", id), 1);
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ record_id: id }),
      1,
    );
    await onePublication(id);
  },
);
scenario(
  "AC15",
  "Changed patch, evidence or metadata cannot reuse an identity",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      p = {
        ...envelope(id, { diameter_cm: 32 }),
        observations: [obs("Original synthetic evidence")],
        client_metadata: { context: "original" },
      },
      first = await send(p);
    const docs = db.collection("submission_documents"),
      original = await docs.findOne({ _id: first.submission_id });
    for (const changed of [
      { ...p, patch: { diameter_cm: 33 } },
      { ...p, observations: [obs("Different synthetic evidence")] },
      { ...p, client_metadata: { context: "changed" } },
      { ...p, base_version_no: 999 },
    ])
      assert.equal(
        (await request("/api/submissions", { method: "POST", value: changed }))
          .status,
        409,
      );
    assert.deepEqual(
      await docs.findOne({ _id: first.submission_id }),
      original,
    );
    assert.equal(await count("submissions", id), 1);
    await onePublication(id);
  },
);
scenario(
  "AC16",
  "Racing proposals serialize at a real SQL lock",
  ["HTTP", "SQL concurrency"],
  async () => {
    const id = await tree(),
      a = envelope(id, { diameter_cm: 32 }),
      b = envelope(id, { diameter_cm: 36 }),
      r = await race(id, [
        () => request("/api/submissions", { method: "POST", value: a }),
        () => request("/api/submissions", { method: "POST", value: b }),
      ]);
    assert(r.every((x) => x.status === 200));
    assert.deepEqual(r.map((x) => x.body.state).sort(), [
      "applied",
      "needs_review",
    ]);
    assert(["32", "36"].includes((await current(id)).diameter_cm));
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM fieldmerge.field_changes WHERE record_id=$1 AND state='pending'",
            [id],
          )
        ).rows[0].n,
      ),
      1,
    );
    await onePublication(id);
  },
);
scenario(
  "AC17",
  "Stale reviewer version cannot silently rebase",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      { c } = await pending(id),
      body = command(c);
    await send(envelope(id, { health: "Fair" }, { version: 2 }));
    const r = await decide(c, body);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "stale_review_refresh_required");
    assert.equal(await count("review_decisions", id), 0);
    assert.equal((await current(id)).diameter_cm, "32");
    await onePublication(id, 3);
  },
);
scenario(
  "AC18",
  "Keep-current closes without a new accepted version",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      { c } = await pending(id),
      r = await decide(c, command(c, "keep_current"));
    assert.equal(r.status, 200);
    assert.equal(r.body.field_state, "rejected");
    assert.equal(r.body.state, "resolved");
    assert.equal(r.body.version_no, null);
    assert.equal(await count("review_decisions", id), 1);
    await onePublication(id);
  },
);
scenario(
  "AC19",
  "Accepted review commits decision, version, change and audit together",
  ["HTTP", "SQL"],
  async () => {
    const id = await tree(),
      { c } = await pending(id),
      r = await decide(c);
    assert.equal(r.status, 200);
    assert.equal(r.body.field_state, "applied");
    const v = await current(id);
    assert.equal(v.diameter_cm, "36");
    assert.equal(v.published_by, accounts[1].user_id);
    const d = (
      await admin.query(
        "SELECT * FROM fieldmerge.review_decisions WHERE change_id=$1",
        [c.change_id],
      )
    ).rows[0];
    assert.equal(d.result_version_no, 3);
    assert.equal(d.decision_id, r.body.decision_id);
    const change = (
      await admin.query(
        "SELECT * FROM fieldmerge.field_changes WHERE change_id=$1",
        [c.change_id],
      )
    ).rows[0];
    assert.equal(change.applied_version_no, 3);
    assert.equal(change.revision_no, c.revision_no + 1);
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='field_reviewed'",
            [c.submission_id],
          )
        ).rows[0].n,
      ),
      1,
    );
    assert.equal(
      (await history(id)).provenance.find((x) => x.field_name === "diameter_cm")
        .decision_id,
      d.decision_id,
    );
    await onePublication(id, 3);
  },
);
scenario(
  "AC20",
  "Two distinct reviewers cannot dispose of one revision twice",
  ["HTTP", "SQL concurrency"],
  async () => {
    const id = await tree(),
      { c } = await pending(id),
      r = await race(id, [
        () => decide(c, command(c), reviewer),
        () => decide(c, command(c), otherReviewer),
      ]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
    assert.equal(await count("review_decisions", id), 1);
    await onePublication(id, 3);
  },
);
scenario(
  "AC21",
  "Retry after a committed decision returns the original receipt",
  ["SQL commit", "HTTP retry"],
  async () => {
    const id = await tree(),
      { c } = await pending(id),
      body = command(c),
      hash = sha256(reviewer.split("=")[1]);
    const committed = await call("api_decide", [
      hash,
      body.client_decision_id,
      c.change_id,
      body.expected_version_no,
      body.expected_change_revision,
      body.action,
      null,
      body.reason,
    ]);
    const retried = await decide(c, body);
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body, committed);
    assert.equal(await count("review_decisions", id), 1);
    await onePublication(id, 3);
  },
);

scenario(
  "AC22",
  "Real MongoDB outage leaves reserved intake visible and SQL readable",
  ["Docker outage", "HTTP", "SQL", "MongoDB"],
  async () => {
    const container = await cli([...compose, "ps", "-q", "mongo-test"]);
    assert(/^[a-f0-9]{12,64}$/.test(container));
    const owner = await cli([
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}',
      container,
    ]);
    assert.equal(owner, process.env.FM_TEST_COMPOSE_PROJECT);
    const service = await cli([
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.service"}}',
      container,
    ]);
    assert.equal(service, "mongo-test");
    const id = await tree(),
      p = envelope(id, { diameter_cm: 32 });
    let reserved,
      paused = false;
    try {
      await assert.rejects(
        submit(token, parseExact(JSON.stringify(p)), {
          afterReserve: async (row) => {
            reserved = row;
            assert.equal(
              await db
                .collection("submission_documents")
                .countDocuments({ _id: row.submission_id }),
              0,
            );
            await cli(["pause", container]);
            paused = true;
            assert.equal(
              await cli([
                "inspect",
                "--format",
                "{{.State.Paused}}",
                container,
              ]),
              "true",
            );
          },
        }),
        (e) => /Mongo/.test(e.name),
      );
      assert(reserved);
      const detail = await request(
        "/api/submissions/" + reserved.submission_id,
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.submission.state, "awaiting_document");
      assert.equal((await request("/api/records/" + id)).status, 200);
      await onePublication(id, 1);
      const report = await request("/api/reports/summary", {
        cookie: reviewer,
      });
      assert.equal(report.status, 200);
      assert.equal(report.body.evidence.available, false);
      assert(report.body.sql.accepted_records > 0);
    } finally {
      if (paused) await cli(["unpause", container]);
    }
    const r = await send(p);
    assert.equal(r.state, "applied");
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ _id: r.submission_id }),
      1,
    );
    assert.equal(await count("submissions", id), 1);
    await onePublication(id);
  },
);
scenario(
  "AC23",
  "Interruption after document insert recovers stored evidence once",
  ["Intake failpoint", "HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      p = envelope(id, { diameter_cm: 32 });
    await assert.rejects(
      submit(token, parseExact(JSON.stringify(p)), {
        afterInsert: () => {
          throw new Error("AC23 simulated request death after insert");
        },
      }),
      /AC23/,
    );
    const row = await sourceRow(p);
    assert.equal(row.state, "awaiting_document");
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ _id: row.submission_id }),
      1,
    );
    await onePublication(id, 1);
    const r = await request(
      "/api/submissions/" + row.submission_id + "/recover",
      { method: "POST" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "applied");
    assert.deepEqual(await send(p), r.body);
    assert.equal(await count("audit_events", id), 1);
    await onePublication(id);
  },
);
scenario(
  "AC24",
  "Publication rollback and lost commit response both recover once",
  ["SQL failure injection", "Intake failpoint", "HTTP", "SQL"],
  async () => {
    const id = await tree(),
      p = envelope(id, { diameter_cm: 32 });
    await admin.query(
      `CREATE FUNCTION public.ac24_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.event_type='submission_reconciled' THEN RAISE EXCEPTION 'AC24 late publication failure';END IF;RETURN NEW;END $f$;CREATE TRIGGER ac24_fail_audit BEFORE INSERT ON fieldmerge.audit_events FOR EACH ROW EXECUTE FUNCTION public.ac24_fail_audit();`,
    );
    try {
      const failed = await request("/api/submissions", {
        method: "POST",
        value: p,
      });
      assert.equal(failed.status, 503);
      const row = await sourceRow(p);
      assert.equal(row.state, "awaiting_document");
      assert.equal(row.source_verified_at, null);
      assert.equal(await count("field_changes", id), 0);
      assert.equal(await count("audit_events", id), 0);
      await onePublication(id, 1);
    } finally {
      await admin.query(
        "DROP TRIGGER ac24_fail_audit ON fieldmerge.audit_events;DROP FUNCTION public.ac24_fail_audit();",
      );
    }
    await send(p);
    await onePublication(id);
    const second = await tree(),
      q = envelope(second, { diameter_cm: 32 });
    let saved;
    await assert.rejects(
      submit(token, parseExact(JSON.stringify(q)), {
        afterFinish: async (source) => {
          saved = (
            await admin.query(
              "SELECT reconciliation_result FROM fieldmerge.submissions WHERE submission_id=$1",
              [source.submission_id],
            )
          ).rows[0].reconciliation_result;
          throw new Error("AC24 lost response after commit");
        },
      }),
      /AC24 lost/,
    );
    assert.deepEqual(await send(q), saved);
    assert.equal(await count("audit_events", second), 1);
    await onePublication(second);
  },
);
scenario(
  "AC25",
  "Wrong-role review and another surveyor draft are denied",
  ["HTTP", "SQL permissions"],
  async () => {
    const id = await tree(),
      { c } = await pending(id);
    assert.equal((await decide(c, command(c), surveyor)).status, 403);
    await assert.rejects(
      call("api_decide", [
        token,
        randomUUID(),
        c.change_id,
        c.current_version_no,
        c.revision_no,
        "keep_current",
        null,
        "Forbidden surveyor decision",
      ]),
      (e) => e.code === "42501",
    );
    const created = await request("/api/drafts", {
      method: "POST",
      value: {
        record_id: id,
        base_version_no: 2,
        form_version: "tree-v2",
        payload: { patch: {} },
      },
    });
    assert.equal(created.status, 201);
    const route = "/api/drafts/" + created.body.draft.draft_id;
    for (const [method, value] of [
      ["GET", undefined],
      [
        "PUT",
        { expected_revision_no: 1, payload: { patch: { health: "Poor" } } },
      ],
      ["DELETE", { expected_revision_no: 1 }],
    ])
      assert.equal(
        (await request(route, { cookie: otherSurveyor, method, value })).status,
        404,
      );
    assert.equal(await count("review_decisions", id), 0);
  },
);
scenario(
  "AC26",
  "Application credentials cannot rewrite accepted history or sealed evidence",
  ["Restricted SQL", "Restricted MongoDB"],
  async () => {
    const id = await tree(),
      r = await send(envelope(id, { diameter_cm: 32 })),
      before = await history(id);
    for (const sql of [
      "UPDATE fieldmerge.accepted_versions SET diameter_cm=99 WHERE record_id=$1",
      "DELETE FROM fieldmerge.accepted_versions WHERE record_id=$1",
      "UPDATE fieldmerge.audit_events SET event_type='forged' WHERE record_id=$1",
    ])
      await assert.rejects(pool().query(sql, [id]), (e) => e.code === "42501");
    const limited = new MongoClient(process.env.MONGODB_URI);
    try {
      await limited.connect();
      const col = limited
        .db(process.env.MONGODB_DATABASE)
        .collection("submission_documents");
      await assert.rejects(
        col.updateOne(
          { _id: r.submission_id },
          { $set: { payload_hash: "b".repeat(64) } },
        ),
        (e) => e.code === 13,
      );
      await assert.rejects(
        col.deleteOne({ _id: r.submission_id }),
        (e) => e.code === 13,
      );
    } finally {
      await limited.close();
    }
    assert.deepEqual(await history(id), before);
  },
);
scenario(
  "AC27",
  "Two optional observations are retained and independently aggregated",
  ["HTTP", "SQL", "MongoDB aggregation"],
  async () => {
    const id = await tree(),
      prior = await request("/api/reports/summary", { cookie: reviewer }),
      p = {
        ...envelope(id, { health: "Fair" }),
        observations: [
          obs("Synthetic trunk evidence"),
          obs("Synthetic root evidence", "2026-06-01T00:01:00Z", "root"),
        ],
      },
      r = await send(p),
      stored = await db
        .collection("submission_documents")
        .findOne({ _id: r.submission_id });
    assert.equal(stored.payload.observations.length, 2);
    assert.deepEqual(
      JSON.parse(stored.canonical_payload_json).observations,
      p.observations,
    );
    const summary = await request("/api/reports/summary", { cookie: reviewer });
    assert.equal(
      summary.body.evidence.observation_count,
      prior.body.evidence.observation_count + 2,
    );
    assert.equal(
      summary.body.evidence.with_observations,
      prior.body.evidence.with_observations + 1,
    );
    assert.equal((await current(id)).diameter_cm, "30");
  },
);
scenario(
  "AC28",
  "Observation timestamps do not select the accepted truth",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    for (const [firstTime, secondTime] of [
      ["2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"],
      ["2026-06-02T00:00:00Z", "2026-06-01T00:00:00Z"],
    ]) {
      const id = await tree(),
        a = {
          ...envelope(id, { diameter_cm: 32 }, { stamp: firstTime }),
          observations: [obs("Synthetic measurement 32 cm", firstTime)],
        },
        b = {
          ...envelope(id, { diameter_cm: 36 }, { stamp: secondTime }),
          observations: [obs("Synthetic measurement 36 cm", secondTime)],
        };
      await send(a);
      const second = await send(b);
      assert.equal(second.state, "needs_review");
      assert.equal((await current(id)).diameter_cm, "32");
      const docs = await db
        .collection("submission_documents")
        .find({ record_id: id })
        .toArray();
      assert.equal(docs.length, 2);
      assert.deepEqual(
        docs
          .map((d) => JSON.parse(d.canonical_payload_json).observed_at)
          .sort(),
        [firstTime, secondTime].sort(),
      );
      assert.deepEqual(
        docs
          .map((d) => JSON.parse(d.canonical_payload_json).observations[0].note)
          .sort(),
        ["Synthetic measurement 32 cm", "Synthetic measurement 36 cm"],
      );
    }
  },
);
scenario(
  "AC29",
  "Ten-minute future observation warns and holds actual changes",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      serverNow = (await admin.query("SELECT clock_timestamp() AS now")).rows[0]
        .now,
      p = envelope(
        id,
        { diameter_cm: 32 },
        { stamp: new Date(serverNow.getTime() + 10 * 60 * 1000).toISOString() },
      ),
      r = await send(p);
    assert.equal(r.state, "needs_review");
    assert.equal(r.fields[0].pending_reason, "clock_warning");
    const row = await sourceRow(p);
    assert(row.warnings.includes("clock_warning"));
    assert.equal(
      (
        await request("/api/submissions/" + r.submission_id)
      ).body.submission.warnings.includes("clock_warning"),
      true,
    );
    assert.equal((await current(id)).diameter_cm, "30");
    await onePublication(id, 1);
  },
);
scenario(
  "AC30",
  "Mixed batch retains successful item across identical retry",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      good = envelope(id, { diameter_cm: 32 }),
      bad = envelope(id, { diameter_cm: -1 }),
      value = [bad, good],
      first = await request("/api/submissions/batch", {
        method: "POST",
        value,
      });
    assert.equal(first.status, 207);
    assert.equal(first.body.results[0].ok, false);
    assert.equal(first.body.results[0].error, "invalid_diameter");
    assert.equal(first.body.results[1].ok, true);
    const retry = await request("/api/submissions/batch", {
      method: "POST",
      value,
    });
    assert.equal(retry.status, 207);
    assert.deepEqual(retry.body.results, first.body.results);
    assert.equal(await count("submissions", id), 1);
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ record_id: id }),
      1,
    );
    await onePublication(id);
  },
);
scenario(
  "AC31",
  "Health-only publication preserves origins of carried values",
  ["HTTP", "SQL provenance"],
  async () => {
    const id = await tree(),
      diameter = await send(envelope(id, { diameter_cm: 32 })),
      before = (await history(id)).provenance;
    await send(envelope(id, { health: "Fair" }, { version: 2 }));
    const after = (await history(id)).provenance;
    for (const field of ["species", "diameter_cm", "guard_damage"]) {
      const a = after.find((x) => x.field_name === field),
        b = before.find((x) => x.field_name === field);
      for (const key of [
        "value",
        "origin_version_no",
        "origin_submission_id",
        "published_by",
        "decision_id",
      ])
        assert.deepEqual(a[key], b[key]);
    }
    assert.equal(
      after.find((x) => x.field_name === "diameter_cm").origin_submission_id,
      diameter.submission_id,
    );
    assert.equal(
      after.find((x) => x.field_name === "health").origin_version_no,
      3,
    );
  },
);
scenario(
  "AC32",
  "Evidence-only submission creates no scalar version",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const id = await tree(),
      p = {
        ...envelope(id, {}),
        observations: [obs("Synthetic evidence only")],
      },
      r = await send(p);
    assert.equal(r.state, "no_change");
    assert.deepEqual(r.fields, []);
    assert.equal(r.version_no, null);
    assert.equal(await count("field_changes", id), 0);
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ _id: r.submission_id }),
      1,
    );
    await onePublication(id, 1);
  },
);
scenario(
  "AC33",
  "Both controlled forms share canonical merge behavior",
  ["HTTP", "SQL", "MongoDB"],
  async () => {
    const snapshots = [],
      outcomes = [];
    for (const form of ["tree-v1", "tree-v2"]) {
      const id = await tree(),
        p = {
          ...envelope(
            id,
            { diameter_cm: 31.25, guard_damage: false },
            { form },
          ),
          client_metadata: { form_context: form },
        };
      if (form === "tree-v2") p.observations = [obs("V2 supporting evidence")];
      const r = await send(p),
        v = await current(id);
      snapshots.push([v.species, v.health, v.diameter_cm, v.guard_damage]);
      outcomes.push(
        r.fields.map((x) => [x.field_name, x.classification, x.state]),
      );
      const raw = (
        await request("/api/submissions/" + r.submission_id + "/source")
      ).body.canonical_payload_json;
      assert.deepEqual(JSON.parse(raw), p);
      await onePublication(id);
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(outcomes[0], outcomes[1]);
  },
);
scenario(
  "AC34",
  "Baseline re-import after accepted edits neither duplicates nor overwrites",
  ["HTTP", "SQL import"],
  async () => {
    const id = "30000000-0000-4000-8000-000000000001",
      beforeTrees = Number(
        (await admin.query("SELECT count(*) AS n FROM fieldmerge.tree_records"))
          .rows[0].n,
      );
    await send(envelope(id, { diameter_cm: 35, health: "Fair" }));
    const before = await history(id),
      versions = await count("accepted_versions", id);
    await cli([
      ...compose,
      "exec",
      "-T",
      "postgres-test",
      "psql",
      "-X",
      "-q",
      "-U",
      "fieldmerge_owner",
      "-d",
      process.env.FM_TEST_DATABASE,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "/fixtures/seed.sql",
    ]);
    assert.deepEqual(await history(id), before);
    assert.equal(await count("accepted_versions", id), versions);
    assert.equal(
      Number(
        (await admin.query("SELECT count(*) AS n FROM fieldmerge.tree_records"))
          .rows[0].n,
      ),
      beforeTrees,
    );
    assert.equal((await current(id)).diameter_cm, "35");
  },
);
scenario(
  "AC35",
  "Impossible history is rejected under a rolled-back administrative fault",
  ["SQL fault injection", "SQL rollback", "HTTP recovery"],
  async () => {
    const id = await tree();
    await send(envelope(id, { diameter_cm: 32 }));
    const p = envelope(id, { diameter_cm: 36 });
    await assert.rejects(
      submit(token, parseExact(JSON.stringify(p)), {
        afterInsert: () => {
          throw new Error("AC35 pause intake");
        },
      }),
      /AC35/,
    );
    const row = await sourceRow(p);
    await admin.query("BEGIN");
    try {
      const constraint = (
        await admin.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='fieldmerge.accepted_versions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%parent_version_no%'",
        )
      ).rows[0].conname;
      assert(/^[a-z_0-9]+$/.test(constraint));
      await admin.query(
        "ALTER TABLE fieldmerge.accepted_versions DISABLE TRIGGER immutable_versions",
      );
      await admin.query(
        'ALTER TABLE fieldmerge.accepted_versions DROP CONSTRAINT "' +
          constraint +
          '"',
      );
      await admin.query(
        "UPDATE fieldmerge.accepted_versions SET parent_version_no=NULL WHERE record_id=$1 AND version_no=2",
        [id],
      );
      await admin.query("SAVEPOINT faulty_history");
      await assert.rejects(
        admin.query(
          "SELECT fieldmerge.api_finish_submission($1,$2,$3,$4::jsonb)",
          [
            token,
            row.submission_id,
            row.payload_hash,
            canonical(parseExact(JSON.stringify(p.patch))),
          ],
        ),
        (e) =>
          e.code === "23514" &&
          e.message === "accepted history is inconsistent",
      );
      await admin.query("ROLLBACK TO SAVEPOINT faulty_history");
      assert.equal(
        (
          await admin.query(
            "SELECT state FROM fieldmerge.submissions WHERE submission_id=$1",
            [row.submission_id],
          )
        ).rows[0].state,
        "awaiting_document",
      );
      assert.equal(await count("field_changes", id, "record_id"), 1);
      await onePublication(id);
    } finally {
      await admin.query("ROLLBACK");
    }
    assert.equal(
      (
        await admin.query(
          "SELECT parent_version_no FROM fieldmerge.accepted_versions WHERE record_id=$1 AND version_no=2",
          [id],
        )
      ).rows[0].parent_version_no,
      1,
    );
    const retried = await send(p);
    assert.equal(retried.state, "needs_review");
    await onePublication(id);
  },
);

assert.equal(results.length, 35);
assert.equal(new Set(results.map((x) => x.id)).size, 35);
const requiredIds = Array.from(
  readFileSync("docs/FieldMerge_Requirements.md", "utf8").matchAll(
    /^\| (AC\d{2}) \|/gm,
  ),
  (m) => m[1],
);
assert.deepEqual(
  results.map((x) => x.id),
  requiredIds,
  "Every requirements-baseline scenario must have a registered test",
);
