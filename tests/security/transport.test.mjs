import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import { MongoClient } from "mongodb";
import { closeConnections, pool, call } from "../../lib/database.mjs";
import { parseExact, canonical, sha256 } from "../../lib/canonical.mjs";
assert(
  /^fieldmerge_test_[a-f0-9]{32}$/.test(process.env.FM_TEST_DATABASE ?? ""),
);
const base = process.env.API_BASE,
  accounts = JSON.parse(
    readFileSync("tmp/database-fixtures/demo-accounts.json", "utf8"),
  ),
  run = promisify(execFile);
const admin = new pg.Client({
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.FM_TEST_DATABASE,
});
const rootMongo = new MongoClient(
  `mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT}/?authSource=admin`,
);
const results = [],
  canary = "SECURITY-CANARY-DO-NOT-LOG";
let surveyor, reviewer, other, db;
function group(id, title, fn) {
  const item = { id, title, status: "not_run" };
  results.push(item);
  test(id + " " + title, { timeout: 120000 }, async () => {
    try {
      await fn();
      item.status = "passed";
    } catch (e) {
      item.status = "failed";
      throw e;
    }
  });
}
async function request(
  route,
  {
    cookie = surveyor,
    method = "GET",
    value,
    raw,
    origin = base,
    type = "application/json",
    headers = {},
  } = {},
) {
  const r = await fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(type ? { "Content-Type": type } : {}),
      ...headers,
    },
    body: raw ?? (value === undefined ? undefined : JSON.stringify(value)),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  return {
    status: r.status,
    body: r.headers.get("content-type")?.includes("application/json")
      ? JSON.parse(text)
      : { non_json: true },
    headers: r.headers,
  };
}
async function login(a) {
  const r = await request("/api/auth/login", {
    method: "POST",
    value: { email: a.email, password: a.password },
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
before(async () => {
  await admin.connect();
  await rootMongo.connect();
  db = rootMongo.db(process.env.MONGODB_DATABASE);
  surveyor = await login(accounts[0]);
  reviewer = await login(accounts[1]);
  const id = randomUUID(),
    email = id + "@security.invalid";
  await admin.query(
    "INSERT INTO fieldmerge.app_users(user_id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5)",
    [
      id,
      email,
      accounts[0].password_hash,
      "Other security fixture",
      "surveyor",
    ],
  );
  other = await login({ email, password: accounts[0].password });
});
after(async () => {
  mkdirSync("output/security", { recursive: true });
  writeFileSync(
    "output/security/checks.json",
    JSON.stringify(
      {
        verified_at_utc: new Date().toISOString(),
        groups: results.length,
        passed: results.filter((x) => x.status === "passed").length,
        checks: results,
      },
      null,
      2,
    ) + "\n",
  );
  await closeConnections();
  await admin.end();
  await rootMongo.close();
});
async function tree() {
  const id = randomUUID();
  await admin.query("BEGIN");
  try {
    await admin.query(
      "INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) VALUES($1,$2,$3)",
      [id, "20000000-0000-4000-8000-000000000001", "SEC-" + id],
    );
    await admin.query(
      "INSERT INTO fieldmerge.accepted_versions(record_id,version_no,species,health,diameter_cm,published_by) VALUES($1,1,'Security fixture','Good',30,$2)",
      [id, accounts[1].user_id],
    );
    await admin.query("COMMIT");
  } catch (e) {
    await admin.query("ROLLBACK");
    throw e;
  }
  return id;
}
const envelope = (id, patch = { health: "Fair" }) => ({
  client_submission_id: randomUUID(),
  record_id: id,
  base_version_no: 1,
  form_version: "tree-v2",
  observed_at: "2026-06-01T00:00:00Z",
  patch,
});
async function unchanged(id) {
  assert.equal(
    Number(
      (
        await admin.query(
          "SELECT count(*) FROM fieldmerge.accepted_versions WHERE record_id=$1",
          [id],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await admin.query(
          "SELECT count(*) FROM fieldmerge.submissions WHERE record_id=$1",
          [id],
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    await db
      .collection("submission_documents")
      .countDocuments({ record_id: id }),
    0,
  );
}
function padded(p, bytes, multibyte = false) {
  const item = { ...p, client_metadata: { padding: "" } },
    empty = JSON.stringify(item),
    delta = bytes - Buffer.byteLength(empty);
  assert(delta >= 0);
  item.client_metadata.padding = multibyte
    ? "é".repeat(Math.floor(delta / 2)) + (delta % 2 ? "x" : "")
    : "x".repeat(delta);
  const raw = JSON.stringify(item);
  assert.equal(Buffer.byteLength(raw), bytes);
  return raw;
}
async function event(response) {
  const id = response.headers.get("x-request-id");
  assert(/^[a-f0-9-]{36}$/.test(id ?? ""));
  const row = (
    await admin.query(
      "SELECT * FROM fieldmerge_ops.security_events WHERE request_id=$1",
      [id],
    )
  ).rows[0];
  assert(row, "Failure event must be committed before returning the response");
  return row;
}

group(
  "S01",
  "Single-body ASCII and UTF-8 requests are accepted at exactly 256 KiB",
  async () => {
    for (const multi of [false, true]) {
      const id = await tree(),
        raw = padded(envelope(id), 262144, multi),
        r = await request("/api/submissions", { method: "POST", raw });
      assert.equal(r.status, 200);
      assert.equal(r.body.state, "applied");
      const stored = await db
        .collection("submission_documents")
        .findOne({ _id: r.body.submission_id });
      assert.equal(Buffer.byteLength(stored.canonical_payload_json), 262144);
    }
  },
);
group(
  "S02",
  "Single bodies one byte over the cap and oversized whitespace publish nothing",
  async () => {
    for (const rawFor of [
      (p) => padded(p, 262145),
      (p) =>
        JSON.stringify(p) +
        " ".repeat(262145 - Buffer.byteLength(JSON.stringify(p))),
    ]) {
      const id = await tree(),
        r = await request("/api/submissions", {
          method: "POST",
          raw: rawFor(envelope(id)),
        });
      assert.equal(r.status, 413);
      assert.equal(r.body.error, "body_too_large");
      await unchanged(id);
      assert.equal((await event(r)).error_code, "body_too_large");
    }
  },
);
group(
  "S03",
  "Chunked transfer is bounded without relying on Content-Length",
  async () => {
    const id = await tree(),
      raw = padded(envelope(id), 262145);
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        base + "/api/submissions",
        {
          method: "POST",
          headers: {
            Cookie: surveyor,
            Origin: base,
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (x) => (data += x));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(data) }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(15000, () =>
        req.destroy(new Error("Chunked request timeout")),
      );
      for (let i = 0; i < raw.length; i += 8192)
        req.write(raw.slice(i, i + 8192));
      req.end();
    });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, "body_too_large");
    await unchanged(id);
  },
);
group(
  "S04",
  "A 100-item batch at exactly 5 MiB returns independent durable receipts",
  async () => {
    const id = await tree(),
      p = envelope(id),
      json = JSON.stringify(Array(100).fill(p)),
      raw = json + " ".repeat(5 * 1024 * 1024 - Buffer.byteLength(json)),
      r = await request("/api/submissions/batch", { method: "POST", raw });
    assert.equal(Buffer.byteLength(raw), 5 * 1024 * 1024);
    assert.equal(r.status, 207);
    assert.equal(r.body.results.length, 100);
    assert(
      r.body.results.every(
        (x) =>
          x.ok &&
          x.result.submission_id === r.body.results[0].result.submission_id,
      ),
    );
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ record_id: id }),
      1,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM fieldmerge.submissions WHERE record_id=$1",
            [id],
          )
        ).rows[0].count,
      ),
      1,
    );
  },
);
group(
  "S05",
  "Batch body one byte over 5 MiB is rejected before manifest registration",
  async () => {
    const before = Number(
        (
          await admin.query(
            "SELECT count(*) FROM fieldmerge_ops.intake_batches",
          )
        ).rows[0].count,
      ),
      id = await tree(),
      json = JSON.stringify([envelope(id)]),
      r = await request("/api/submissions/batch", {
        method: "POST",
        raw: json + " ".repeat(5 * 1024 * 1024 + 1 - Buffer.byteLength(json)),
      });
    assert.equal(r.status, 413);
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM fieldmerge_ops.intake_batches",
          )
        ).rows[0].count,
      ),
      before,
    );
    await unchanged(id);
  },
);
group(
  "S06",
  "Batch enforces its separate canonical 256 KiB item cap",
  async () => {
    const id = await tree(),
      good = JSON.parse(padded(envelope(id), 262144)),
      bad = JSON.parse(padded(envelope(id), 262145));
    assert.equal(
      Buffer.byteLength(canonical(parseExact(JSON.stringify(good)))),
      262144,
    );
    const r = await request("/api/submissions/batch", {
      method: "POST",
      value: [bad, good],
    });
    assert.equal(r.status, 207);
    assert.equal(r.body.results[0].error, "submission_too_large");
    assert.equal(r.body.results[1].ok, true);
    const retry = await request("/api/submissions/batch", {
      method: "POST",
      value: [bad, good],
    });
    assert.deepEqual(retry.body.results, r.body.results);
    assert.equal(
      await db
        .collection("submission_documents")
        .countDocuments({ record_id: id }),
      1,
    );
  },
);
group(
  "S07",
  "Batch cardinality and top-level shape are validated before intake",
  async () => {
    const id = await tree();
    for (const value of [
      [],
      Array(101).fill(envelope(id)),
      { items: [envelope(id)] },
    ]) {
      const r = await request("/api/submissions/batch", {
        method: "POST",
        value,
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "batch_requires_1_to_100_items");
    }
    await unchanged(id);
  },
);
group(
  "S08",
  "Malformed JSON, duplicate keys, invalid UTF-8 and excessive depth do not publish",
  async () => {
    const id = await tree();
    for (const [raw, code] of [
      ['{"patch":1,}', "invalid_json"],
      ['{"a":1,"a":2}', "duplicate_json_key"],
      ['{"p":{"a":1,"a":2}}', "duplicate_json_key"],
      [Buffer.from([0xc3, 0x28]), "invalid_utf8"],
      ["[".repeat(40) + "0" + "]".repeat(40), "json_too_deep"],
      ["[".repeat(5000) + "0" + "]".repeat(5000), "json_too_deep"],
      ['{"\\u0000":1}', "invalid_json_key"],
    ]) {
      const r = await request("/api/submissions", { method: "POST", raw });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, code);
    }
    await unchanged(id);
  },
);
group(
  "S09",
  "Missing bodies and unsupported content types have bounded errors",
  async () => {
    const id = await tree();
    for (const type of ["text/plain", "multipart/form-data", null]) {
      const r = await request("/api/submissions", {
        method: "POST",
        value: envelope(id),
        type,
      });
      assert.equal(r.status, 415);
      assert.equal(r.body.error, "json_required");
    }
    const empty = await request("/api/submissions", { method: "POST" });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "body_required");
    await unchanged(id);
  },
);
group(
  "S10",
  "Eight-KiB control endpoints reject oversized bodies before mutation",
  async () => {
    const id = randomUUID();
    for (const route of [
      "/api/auth/login",
      "/api/reviews/" + id,
      "/api/drafts/" + id + "/finalize",
      "/api/operations/recovery/" + id + "/retry",
    ]) {
      const r = await request(route, {
        cookie:
          route.includes("/reviews/") || route.includes("/operations/")
            ? reviewer
            : surveyor,
        method: "POST",
        raw: " ".repeat(8193),
      });
      assert.equal(r.status, 413);
      assert.equal(r.body.error, "body_too_large");
    }
  },
);
group(
  "S11",
  "Every write handler rejects a foreign or missing Origin",
  async () => {
    const id = randomUUID(),
      routes = [
        ["POST", "/api/auth/login"],
        ["POST", "/api/auth/logout"],
        ["POST", "/api/drafts"],
        ["PUT", "/api/drafts/" + id],
        ["DELETE", "/api/drafts/" + id],
        ["POST", "/api/drafts/" + id + "/finalize"],
        ["POST", "/api/submissions"],
        ["POST", "/api/submissions/batch"],
        ["POST", "/api/submissions/" + id + "/recover"],
        ["POST", "/api/reviews/" + id],
        ["POST", "/api/operations/recovery/" + id + "/retry"],
      ];
    for (const [method, route] of routes)
      for (const origin of [null, "https://attacker.invalid"]) {
        const r = await request(route, { method, value: {}, origin });
        assert.equal(r.status, 403);
        assert.equal(r.body.error, "origin_denied");
      }
  },
);
group(
  "S12",
  "Protected read endpoints consistently reject unauthenticated requests",
  async () => {
    const id = randomUUID();
    for (const route of [
      "/api/records",
      "/api/records/" + id,
      "/api/records/" + id + "/snapshot",
      "/api/records/" + id + "/history",
      "/api/drafts",
      "/api/drafts/" + id,
      "/api/submissions",
      "/api/submissions/" + id,
      "/api/submissions/" + id + "/source",
      "/api/reviews",
      "/api/reviews/" + id,
      "/api/reviews/authors",
      "/api/batches",
      "/api/batches/" + id,
      "/api/reports/summary",
      "/api/reports/accepted.json",
      "/api/reports/accepted.csv",
      "/api/operations/recovery",
      "/api/operations/recovery/" + id,
      "/api/operations/security-events",
    ]) {
      const r = await request(route, { cookie: "" });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
  },
);
group(
  "S13",
  "Wrong roles and another draft owner cannot bypass server checks",
  async () => {
    for (const route of [
      "/api/reviews",
      "/api/reviews/authors",
      "/api/reports/summary",
      "/api/operations/recovery",
      "/api/operations/security-events",
    ])
      assert.equal((await request(route)).status, 403);
    for (const route of [
      "/api/drafts",
      "/api/submissions",
      "/api/submissions/batch",
    ])
      assert.equal(
        (await request(route, { cookie: reviewer, method: "POST", value: {} }))
          .status,
        403,
      );
    const id = await tree(),
      created = await request("/api/drafts", {
        method: "POST",
        value: {
          record_id: id,
          base_version_no: 1,
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
        (await request(route, { cookie: other, method, value })).status,
        404,
      );
  },
);
group(
  "S14",
  "Forged identities, document operators and injected query syntax do not gain access",
  async () => {
    const id = await tree();
    for (const extra of [
      { author_id: accounts[1].user_id },
      { record_id: { $ne: null } },
      { base_version_no: { $gt: 0 } },
      { received_at: "2026-01-01T00:00:00Z" },
    ])
      assert.equal(
        (
          await request("/api/submissions", {
            method: "POST",
            value: { ...envelope(id), ...extra },
          })
        ).status,
        400,
      );
    const literal = await request(
      "/api/records?species=" + encodeURIComponent("' OR 1=1 --"),
    );
    assert.equal(literal.status, 200);
    assert.deepEqual(literal.body.records, []);
    assert.equal((await request("/api/records?limit=1&limit=2")).status, 400);
    assert.equal((await request("/api/records?species[$ne]=x")).status, 400);
    assert.equal(
      (
        await request("/api/records", {
          cookie: "fieldmerge_session=' OR 1=1 --",
        })
      ).status,
      401,
    );
    await unchanged(id);
  },
);
group(
  "S15",
  "Decimal, boolean, enumeration and observation boundaries are enforced through intake",
  async () => {
    const id = await tree();
    for (const patch of [
      { diameter_cm: "1" },
      { diameter_cm: 1000000 },
      { diameter_cm: -0.01 },
      { diameter_cm: 0.001 },
      { guard_damage: "false" },
      { health: "Excellent" },
      { species: "" },
    ])
      assert.equal(
        (
          await request("/api/submissions", {
            method: "POST",
            value: envelope(id, patch),
          })
        ).status,
        400,
      );
    const observation = {
      category: "root",
      note: "x".repeat(500),
      observed_at: "2026-06-01T00:00:00Z",
    };
    const p = {
      ...envelope(id, { diameter_cm: 999999.99, guard_damage: false }),
      observations: Array(20).fill(observation),
    };
    assert.equal(
      (await request("/api/submissions", { method: "POST", value: p })).status,
      200,
    );
    for (const observations of [
      Array(21).fill(observation),
      [{ ...observation, note: "x".repeat(501) }],
      [{ ...observation, category: "unknown" }],
    ])
      assert.equal(
        (
          await request("/api/submissions", {
            method: "POST",
            value: { ...p, client_submission_id: randomUUID(), observations },
          })
        ).status,
        400,
      );
  },
);
group(
  "S16",
  "Offset and high-precision timestamps retain their original source spelling",
  async () => {
    const id = await tree(),
      p = {
        ...envelope(id),
        observed_at: "2026-06-01T05:30:00.123456789+05:30",
      },
      r = await request("/api/submissions", { method: "POST", value: p });
    assert.equal(r.status, 200);
    const source = await db
      .collection("submission_documents")
      .findOne({ _id: r.body.submission_id });
    assert.equal(
      JSON.parse(source.canonical_payload_json).observed_at,
      p.observed_at,
    );
    assert.equal(
      source.payload.observed_at.toISOString(),
      "2026-06-01T00:00:00.123Z",
    );
    for (const observed_at of [
      "2026-02-30T00:00:00Z",
      "2026-06-01T24:00:00Z",
      "2026-06-01T00:00:00",
    ])
      assert.equal(
        (
          await request("/api/submissions", {
            method: "POST",
            value: { ...p, client_submission_id: randomUUID(), observed_at },
          })
        ).status,
        400,
      );
  },
);
group(
  "S17",
  "Prototype-shaped metadata remains data and cannot change an authenticated actor",
  async () => {
    const id = await tree(),
      p = envelope(id);
    p.client_metadata = JSON.parse(
      '{"__proto__":{"admin":true},"constructor":{"role":"reviewer"},"$where":"SECRET-CANARY"}',
    );
    const r = await request("/api/submissions", { method: "POST", value: p });
    assert.equal(r.status, 200);
    const raw = (
      await request("/api/submissions/" + r.body.submission_id + "/source")
    ).body.canonical_payload_json;
    assert.deepEqual(JSON.parse(raw).client_metadata, p.client_metadata);
    assert.equal({}.admin, undefined);
    assert.equal((await request("/api/auth/me")).body.user.role, "surveyor");
  },
);
group(
  "S18",
  "Failure events contain server correlation, safe identity and no raw secrets",
  async () => {
    const supplied = randomUUID(),
      r = await request("/api/reviews?password=" + canary, {
        headers: {
          "x-request-id": supplied,
          "x-forwarded-for": canary,
          authorization: canary,
        },
      });
    assert.equal(r.status, 403);
    const row = await event(r);
    assert.notEqual(row.request_id, supplied);
    assert.equal(row.actor_id, accounts[0].user_id);
    assert.equal(row.actor_role, "surveyor");
    assert.equal(row.route_template, "/api/reviews");
    assert.equal(row.http_status, 403);
    const text = JSON.stringify(row);
    for (const secret of [
      canary,
      accounts[0].password,
      accounts[0].password_hash,
      surveyor.split("=")[1],
      sha256(surveyor.split("=")[1]),
    ])
      assert(
        !text.includes(secret),
        "Secret must not be present in stored events",
      );
  },
);
group(
  "S19",
  "Stale decision rolls back while its independent security event commits",
  async () => {
    const id = await tree();
    await request("/api/submissions", {
      method: "POST",
      value: envelope(id, { diameter_cm: 32 }),
    });
    const conflict = await request("/api/submissions", {
        method: "POST",
        value: envelope(id, { diameter_cm: 36 }),
      }),
      queue = await request("/api/reviews?record_id=" + id, {
        cookie: reviewer,
      }),
      c = queue.body.changes[0],
      r = await request("/api/reviews/" + c.change_id, {
        cookie: reviewer,
        method: "POST",
        value: {
          client_decision_id: randomUUID(),
          expected_version_no: 1,
          expected_change_revision: c.revision_no,
          action: "accept_proposal",
          reason: canary,
        },
      });
    assert.equal(r.status, 409);
    const row = await event(r);
    assert.equal(row.error_code, "stale_review_refresh_required");
    assert.equal(row.sqlstate, "40001");
    assert.equal(row.target_id, c.change_id);
    assert.equal(row.actor_id, accounts[1].user_id);
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM fieldmerge.review_decisions WHERE record_id=$1",
            [id],
          )
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1",
            [id],
          )
        ).rows[0].n,
      ),
      2,
    );
    assert(!JSON.stringify(row).includes(canary));
    const independent = new pg.Client({
      connectionString: process.env.DATABASE_URL,
    });
    try {
      await independent.connect();
      const events = (
        await independent.query(
          "SELECT fieldmerge.api_security_events($1,100) AS events",
          [sha256(reviewer.split("=")[1])],
        )
      ).rows[0].events;
      assert(events.some((x) => x.request_id === row.request_id));
    } finally {
      await independent.end();
    }
  },
);
group(
  "S20",
  "Only reviewers can read bounded events; database writers cannot rewrite them",
  async () => {
    const response = await request("/api/operations/security-events?limit=2", {
      cookie: reviewer,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.events.length, 2);
    for (const q of ["limit=0", "limit=101", "limit=1&limit=2", "unknown=1"])
      assert.equal(
        (
          await request("/api/operations/security-events?" + q, {
            cookie: reviewer,
          })
        ).status,
        400,
      );
    await assert.rejects(
      pool().query("SELECT * FROM fieldmerge_ops.security_events"),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      call("api_security_events", [sha256(surveyor.split("=")[1]), 10]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      admin.query(
        "UPDATE fieldmerge_ops.security_events SET error_code='forged' WHERE request_id=$1",
        [response.body.events[0].request_id],
      ),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      admin.query(
        "DELETE FROM fieldmerge_ops.security_events WHERE request_id=$1",
        [response.body.events[0].request_id],
      ),
      (e) => e.code === "42501",
    );
  },
);
group(
  "S21",
  "Logging SQL failure falls back to persistent files without changing denial",
  async () => {
    await admin.query(
      "CREATE FUNCTION public.security_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SECURITY-CANARY SQL event failure';END $$;CREATE TRIGGER security_test_fail BEFORE INSERT ON fieldmerge_ops.security_events FOR EACH ROW EXECUTE FUNCTION public.security_test_fail();",
    );
    let response;
    try {
      response = await request("/api/reviews?secret=" + canary);
      assert.equal(response.status, 403);
      assert.equal(response.body.error, "role_denied");
    } finally {
      await admin.query(
        "DROP TRIGGER security_test_fail ON fieldmerge_ops.security_events;DROP FUNCTION public.security_test_fail();",
      );
    }
    const files = await readdir(process.env.SECURITY_LOG_DIR),
      text = (
        await Promise.all(
          files.map((f) =>
            readFile(path.join(process.env.SECURITY_LOG_DIR, f), "utf8"),
          ),
        )
      ).join(""),
      rows = text.trim().split("\n").map(JSON.parse),
      match = rows.find(
        (x) => x.request_id === response.headers.get("x-request-id"),
      );
    assert(match);
    assert.equal(match.actor_id, accounts[0].user_id);
    assert.equal(match.route_template, "/api/reviews");
    for (const secret of [
      canary,
      accounts[0].password,
      surveyor.split("=")[1],
      sha256(surveyor.split("=")[1]),
    ])
      assert(!text.includes(secret));
    const child = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {readdir,readFile} from 'node:fs/promises'; import path from 'node:path'; const files=await readdir(process.env.SECURITY_LOG_DIR); let n=0;for(const f of files)n+=(await readFile(path.join(process.env.SECURITY_LOG_DIR,f),'utf8')).trim().split('\\n').length;console.log(n);",
      ],
      { env: process.env },
    );
    assert(Number(child.stdout.trim()) >= 1);
    assert.equal(
      (await event(await request("/api/reviews"))).error_code,
      "role_denied",
    );
  },
);
group(
  "S22",
  "Authentication failures and rate limiting do not expose password material",
  async () => {
    const email = randomUUID() + "@security.invalid";
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await request("/api/auth/login", {
            method: "POST",
            value: { email, password: canary },
          })
        ).status,
        401,
      );
    const r = await request("/api/auth/login", {
      method: "POST",
      value: { email, password: canary },
    });
    assert.equal(r.status, 429);
    const row = await event(r);
    assert.equal(row.actor_id, null);
    assert.equal(row.error_code, "login_rate_limited");
    assert(!JSON.stringify(row).includes(email));
    assert(!JSON.stringify(row).includes(canary));
  },
);
group(
  "S23",
  "The exact maximum diameter survives draft storage and finalization",
  async () => {
    const id = await tree(),
      created = await request("/api/drafts", {
        method: "POST",
        value: {
          record_id: id,
          base_version_no: 1,
          form_version: "tree-v2",
          payload: {
            patch: { diameter_cm: 999999.99 },
            observed_at: "2026-06-01T00:00:00Z",
          },
        },
      });
    assert.equal(created.status, 201);
    const draft = created.body.draft;
    const finalized = await request(
      "/api/drafts/" + draft.draft_id + "/finalize",
      { method: "POST", value: { expected_revision_no: 1 } },
    );
    assert.equal(finalized.status, 200);
    const current = (
      await admin.query(
        "SELECT diameter_cm FROM fieldmerge.latest_accepted_records WHERE record_id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(current.diameter_cm, "999999.99");
    const source = await db
      .collection("submission_documents")
      .findOne({ _id: finalized.body.receipt.submission_id });
    assert.equal(source.payload.patch.diameter_cm.toString(), "999999.99");
  },
);
