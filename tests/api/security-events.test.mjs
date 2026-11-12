import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  truncate,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  requestContext,
  withSecurityContext,
  identifySecurityActor,
  recordSecurityEvent,
  appendSecurityFallback,
} from "../../lib/security-events.mjs";
import { handled, body } from "../../lib/http.mjs";
import { ApiError } from "../../lib/canonical.mjs";
const root = path.join(process.cwd(), "tmp", "security-unit");
test("request context discards raw paths, queries, spoofed correlation IDs and headers", () => {
  const marker = "SECRET-CANARY",
    supplied = randomUUID(),
    id = randomUUID();
  const a = requestContext(
    new Request("http://local/api/reviews/" + id + "?password=" + marker, {
      headers: { "x-request-id": supplied, authorization: marker },
    }),
  );
  assert.equal(a.route_template, "/api/reviews/:id");
  assert.equal(a.target_id, id);
  assert.notEqual(a.request_id, supplied);
  assert(!JSON.stringify(a).includes(marker));
  assert.equal(
    requestContext(new Request("http://local/api/" + marker)).route_template,
    "/api/unknown",
  );
});
test("parallel handled requests retain their own actor and failure context", async () => {
  const logged = [],
    ids = [randomUUID(), randomUUID()];
  await Promise.all(
    ids.map((id, i) =>
      handled(
        async () => {
          identifySecurityActor({
            user_id: id,
            role: i ? "reviewer" : "surveyor",
          });
          await new Promise((r) => setTimeout(r, i ? 1 : 10));
          throw new ApiError(403, "role_denied");
        },
        {
          logFailure: async (c, status) =>
            logged.push({
              actor: c.actor_id,
              role: c.actor_role,
              route: c.route_template,
              status,
            }),
        },
      )(new Request("http://local/api/" + (i ? "reports/summary" : "reviews"))),
    ),
  );
  assert.deepEqual(logged.map((x) => x.actor).sort(), [...ids].sort());
  assert(logged.every((x) => x.status === 403));
  assert.equal(logged.find((x) => x.actor === ids[0]).route, "/api/reviews");
});
test("SQL failure maps to a safe response and an independently supplied event writer", async () => {
  const entries = [],
    id = randomUUID(),
    res = await handled(
      async () => {
        const e = new Error("SECRET-CANARY in SQL details");
        e.code = "40001";
        throw e;
      },
      {
        logFailure: async (c, status, code, state) =>
          entries.push({
            id: c.request_id,
            status,
            code,
            state,
            route: c.route_template,
          }),
      },
    )(new Request("http://local/api/reviews/" + id));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "stale_review_refresh_required");
  assert.equal(res.headers.get("x-request-id"), entries[0].id);
  assert.equal(entries[0].state, "40001");
  assert(!JSON.stringify(entries).includes("SECRET-CANARY"));
});
test("failure of the logging boundary never changes the original denial", async () => {
  const old = console.error,
    diagnostics = [];
  console.error = (x) => diagnostics.push(x);
  try {
    const res = await handled(
      async () => {
        throw new ApiError(403, "role_denied");
      },
      {
        logFailure: () => {
          throw new Error("SECRET-CANARY");
        },
      },
    )(new Request("http://local/api/reviews"));
    assert.equal(res.status, 403);
    assert.equal(diagnostics.length, 1);
    assert(!diagnostics[0].includes("SECRET-CANARY"));
  } finally {
    console.error = old;
  }
});
test("fallback uses closed fields and safe JSON encoding without input or session material", async () => {
  const dir = path.join(root, randomUUID()),
    id = randomUUID();
  await appendSecurityFallback(
    {
      request_id: id,
      route_template: "/api/secret-canary",
      method: "POST\r\nFORGED",
      error_code: "bad\r\nSECRET-CANARY",
      http_status: 403,
      session_hash: "SECRET-CANARY",
      password: "SECRET-CANARY",
      sqlstate: ";DROP",
    },
    dir,
  );
  const file = (await readdir(dir))[0],
    raw = await readFile(path.join(dir, file), "utf8"),
    entry = JSON.parse(raw);
  assert.equal(raw.trim().split("\n").length, 1);
  assert.equal(entry.route_template, "/api/unknown");
  assert.equal(entry.method, "OTHER");
  assert.equal(entry.error_code, "unclassified_failure");
  assert.equal(entry.sqlstate, null);
  assert(!raw.includes("SECRET-CANARY"));
  assert(!raw.includes("secret-canary"));
});
test("concurrent SQL-writer failures produce complete persistent fallback records", async () => {
  const dir = path.join(root, randomUUID()),
    ids = Array.from({ length: 12 }, () => randomUUID());
  await Promise.all(
    ids.map((id) =>
      recordSecurityEvent(
        {
          ...requestContext(new Request("http://local/api/reviews")),
          request_id: id,
          session_hash: "SECRET-CANARY",
        },
        403,
        "role_denied",
        null,
        {
          writer: () => {
            throw new Error("SQL unavailable SECRET-CANARY");
          },
          directory: dir,
        },
      ),
    ),
  );
  const text = (
    await Promise.all(
      (await readdir(dir)).map((f) => readFile(path.join(dir, f), "utf8")),
    )
  ).join("");
  const entries = text.trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 12);
  assert.deepEqual(entries.map((x) => x.request_id).sort(), [...ids].sort());
  assert(!text.includes("SECRET-CANARY"));
});
test("fallback capacity is bounded without overwriting earlier records", async () => {
  const dir = path.join(root, randomUUID());
  await mkdir(dir, { recursive: true });
  const stem =
      "security-" + new Date().toISOString().slice(0, 10) + "-" + process.pid,
    files = [0, 1, 2].map((i) => path.join(dir, stem + "-" + i + ".jsonl"));
  try {
    for (const f of files) {
      await writeFile(f, "");
      await truncate(f, 5 * 1024 * 1024);
    }
    await assert.rejects(
      appendSecurityFallback(
        {
          request_id: randomUUID(),
          route_template: "/api/reviews",
          method: "GET",
          http_status: 403,
          error_code: "role_denied",
        },
        dir,
      ),
      /capacity/,
    );
  } finally {
    await Promise.all(files.map((f) => unlink(f)));
  }
});
test("stream reader counts actual UTF-8 bytes despite false content length and chunk boundaries", async () => {
  const bytes = Buffer.from('{"value":"é"}'),
    make = () =>
      new Request("http://local/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1" },
        duplex: "half",
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes.subarray(0, 11));
            c.enqueue(bytes.subarray(11));
            c.close();
          },
        }),
      });
  assert.equal((await body(make(), bytes.length)).value, "é");
  await assert.rejects(body(make(), bytes.length - 1), (e) => e.status === 413);
});
