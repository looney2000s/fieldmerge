import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
const state = (globalThis.__fieldmergeSecurity ??= {
  context: new AsyncLocalStorage(),
  fallback: Promise.resolve(),
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const routes = [
  "auth/login",
  "auth/logout",
  "auth/me",
  "records",
  "drafts",
  "submissions",
  "submissions/batch",
  "reviews",
  "reviews/authors",
  "batches",
  "reports/summary",
  "reports/accepted.csv",
  "reports/accepted.json",
  "operations/recovery",
  "operations/security-events",
];
const identified = [
  ["records", ["", "snapshot", "history"]],
  ["drafts", ["", "finalize"]],
  ["submissions", ["", "source", "recover"]],
  ["reviews", [""]],
  ["batches", [""]],
  ["operations/recovery", ["", "retry"]],
];
const allowedTemplates = new Set([
  "/api/unknown",
  ...routes.map((x) => "/api/" + x),
  ...identified.flatMap(([base, suffixes]) =>
    suffixes.map((s) => "/api/" + base + "/:id" + (s ? "/" + s : "")),
  ),
]);
export function requestContext(request) {
  let route = "/api/unknown",
    target = null;
  try {
    const pathname = new URL(request.url).pathname;
    if (routes.some((r) => pathname === "/api/" + r)) route = pathname;
    else
      for (const [base, suffixes] of identified) {
        const rest = pathname.slice(("/api/" + base + "/").length).split("/");
        if (
          pathname.startsWith("/api/" + base + "/") &&
          uuid.test(rest[0]) &&
          rest.length <= 2 &&
          suffixes.includes(rest[1] ?? "")
        ) {
          target = rest[0];
          route = "/api/" + base + "/:id" + (rest[1] ? "/" + rest[1] : "");
          break;
        }
      }
  } catch {}
  return {
    request_id: randomUUID(),
    method: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(
      request?.method,
    )
      ? request.method
      : "OTHER",
    route_template: route,
    target_id: target,
    session_hash: null,
    actor_id: null,
    actor_role: null,
  };
}
export const withSecurityContext = (context, fn) =>
  state.context.run(context, fn);
export function identifySecuritySession(hash) {
  const c = state.context.getStore();
  if (c) c.session_hash = hash;
}
export function identifySecurityActor(user) {
  const c = state.context.getStore();
  if (c) {
    c.actor_id = uuid.test(user?.user_id ?? "") ? user.user_id : null;
    c.actor_role = ["surveyor", "reviewer"].includes(user?.role)
      ? user.role
      : null;
  }
}
function pool() {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).username !== "fieldmerge_api"
  )
    throw new Error("Restricted event writer unavailable");
  if (!state.pool) {
    state.pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
      query_timeout: 1500,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
    });
    state.pool.on("error", () => {});
  }
  return state.pool;
}
async function sqlWriter(context, event) {
  await pool().query(
    "SELECT fieldmerge.api_record_security_event($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      event.request_id,
      context.session_hash,
      event.method,
      event.route_template,
      event.target_id,
      event.http_status,
      event.error_code,
      event.sqlstate,
    ],
  );
}
export async function appendSecurityFallback(
  event,
  directory = process.env.SECURITY_LOG_DIR ?? path.join(process.cwd(), "logs"),
) {
  // Closed, bounded fields; no raw input or exception text can enter a JSONL record.
  const safe = {
    occurred_at: new Date().toISOString(),
    request_id: uuid.test(event.request_id ?? "")
      ? event.request_id
      : randomUUID(),
    actor_id: uuid.test(event.actor_id ?? "") ? event.actor_id : null,
    actor_role: ["surveyor", "reviewer"].includes(event.actor_role)
      ? event.actor_role
      : null,
    method: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(
      event.method,
    )
      ? event.method
      : "OTHER",
    route_template: allowedTemplates.has(event.route_template)
      ? event.route_template
      : "/api/unknown",
    target_id: uuid.test(event.target_id ?? "") ? event.target_id : null,
    http_status:
      Number.isInteger(event.http_status) &&
      event.http_status >= 400 &&
      event.http_status <= 599
        ? event.http_status
        : 503,
    error_code: /^[a-z][a-z0-9_]{0,79}$/.test(event.error_code ?? "")
      ? event.error_code
      : "unclassified_failure",
    sqlstate: /^[A-Z0-9]{5}$/.test(event.sqlstate ?? "")
      ? event.sqlstate
      : null,
  };
  const line = JSON.stringify(safe) + "\n",
    stem = "security-" + safe.occurred_at.slice(0, 10) + "-" + process.pid;
  const task = async () => {
    await mkdir(directory, { recursive: true });
    for (let part = 0; part < 3; part++) {
      const file = path.join(directory, stem + "-" + part + ".jsonl");
      let size = 0;
      try {
        size = (await stat(file)).size;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (size + Buffer.byteLength(line) <= 5 * 1024 * 1024) {
        const handle = await open(file, "a", 0o600);
        try {
          await handle.writeFile(line, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      }
    }
    throw new Error("Fallback capacity exhausted");
  };
  const work = state.fallback.then(task, task);
  state.fallback = work.catch(() => {});
  return work;
}
export async function recordSecurityEvent(
  context,
  status,
  code,
  sqlstate,
  { writer = sqlWriter, directory } = {},
) {
  const event = {
    request_id: context.request_id,
    actor_id: context.actor_id,
    actor_role: context.actor_role,
    method: context.method,
    route_template: context.route_template,
    target_id: context.target_id,
    http_status: status,
    error_code: /^[a-z][a-z0-9_]{0,79}$/.test(code ?? "")
      ? code
      : "unclassified_failure",
    sqlstate: /^[A-Z0-9]{5}$/.test(sqlstate ?? "") ? sqlstate : null,
  };
  try {
    await writer(context, event);
    return "sql";
  } catch {}
  try {
    await appendSecurityFallback(event, directory);
    return "file";
  } catch {
    console.error(
      JSON.stringify({
        event: "security_event_not_persisted",
        request_id: context.request_id,
      }),
    );
    return "unavailable";
  }
}
export async function closeSecurityConnections() {
  await state.pool?.end();
  delete state.pool;
}
