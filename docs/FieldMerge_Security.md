# FieldMerge transport boundaries and failure evidence

This milestone adds targeted transport/security tests and persistent safe failure logging. It does not establish that the application is free of vulnerabilities or cover administrator/backend credential compromise.

## Implemented boundary

Every API handler wrapped by `handled` assigns a cryptographically random server request UUID, returned as `X-Request-Id`. Incoming correlation headers cannot choose it. Thrown failures mapped to HTTP 4xx/5xx are recorded after the original handler has failed, through an independent restricted PostgreSQL connection. A rejected stale review can therefore roll back its business transaction while its failure event commits. Successful requests are not security events. Framework-generated 404/405/header-limit responses outside these handlers are outside this logger. Per-item errors inside a successful HTTP 207 batch response remain in durable batch receipts rather than this HTTP-failure log.

Migration 010 adds `fieldmerge_ops.security_events`, a recent-events index, an immutable-history trigger, a restricted write function, and a reviewer-only read function. The API and worker have no direct table privileges. The logger uses a separate API-role pool capped at two connections with bounded connection/query timeouts. Its failure never changes the original denied operation into success or changes its response status.

Stored fields are a server request UUID/time, nullable actor UUID/role, bounded method and route template, optional UUID target, status, safe error code, and optional SQLSTATE. No body, query string, raw URL, email, IP address, headers, cookies, passwords, tokens, session hashes, decision reasons, exception messages or stacks are stored. The SQL writer uses a session hash transiently to resolve identity, including an expired/inactive session still present in the session table. An identified actor is not evidence that authorization succeeded. An unknown session yields a null actor. File fallback can identify only an actor already authenticated in that request.

This follows the principle of recording useful application failures while excluding credentials and sensitive content described in the [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html). The field list and persistence choices are FieldMerge design decisions.

## Fallback and operational limits

If SQL logging fails, closed-field JSONL records are appended and synced under `logs/` by default; optional `SECURITY_LOG_DIR` selects another server directory. These files are Git-ignored. A process serializes its appends, with at most three 5 MiB segments per UTC day and process ID. Full segments are retained, never overwritten. This bounds each day's process allocation, not total lifetime disk use: multiple processes/restarts/days accumulate files. Directory access, backup, archival/retention, and disk monitoring are operator responsibilities. Windows permissions inherit filesystem ACLs; the requested Unix file mode is not a Windows ACL guarantee.

Fallback records survive a normal process restart (tested by reading from a second Node process). This is not a power-loss or disk-failure guarantee. Fallback files are not automatically imported into SQL or returned by the reviewer endpoint. For an explicit manual reconciliation, request UUID is the deduplication key. If SQL and file persistence both fail, only a fixed `security_event_not_persisted` diagnostic and request UUID are emitted; the original denial still returns. Database constraints/triggers and restricted roles protect ordinary application access, not a privileged administrator who can disable protections. This is not a cryptographically tamper-evident audit system.

## Verified cases

| Cases | Behavior checked |
|---|---|
| S01–S03 | Exactly 256 KiB accepted for single submissions; one byte over rejected; actual UTF-8/chunked bytes counted without trusting Content-Length. |
| S04–S07 | Exactly 5 MiB and 100 batch positions, over-limit rejection before registration, canonical per-item 256 KiB cap, independent receipts, unchanged retries, invalid batch shapes/counts. |
| S08–S10 | Duplicate keys, invalid JSON/UTF-8, NUL keys, excessive nesting including 5,000 levels, empty bodies, content type, and 8 KiB control-request cap. |
| S11–S14 | All 11 write handlers require the configured Origin; protected reads require sessions; role/ownership denial, forged identity, literal query syntax, malformed filters/cookies. |
| S15–S17 | Decimal/boolean/enumeration boundaries, 20 observations with 500-character notes, timestamp validity/original spelling, and prototype/operator-shaped metadata remaining data. |
| S18–S22 | Server correlation, redaction, independently committed stale-review failure, reviewer-only bounded reads, denied log rewrites, actual SQL-logger failure and persistent file fallback, login throttling. |
| S23 | Exact maximum diameter survives draft creation and finalization through MongoDB and SQL. |

Five additional Chromium checks verify HttpOnly/SameSite Strict session behavior, stored markup rendered as text for both roles, escaped accepted species, and sign-out revocation. Eight logger/stream unit groups cover isolated concurrent request context, safe field encoding, logging failure behavior, parallel file appends, bounded segment capacity, and actual byte counting. Together with the existing validation/export groups, the unit suite has 18 passing groups.

The tests exposed three corrected behaviors: an empty stream now consistently returns `body_required`; nesting is checked before the recursive JSON parser; and MongoDB diameter bounds now use Decimal128 literals instead of double bounds. The last fix prevents rejecting the valid exact value `999999.99`. Both source and draft validators share this correction; `Setup` updates validators without resetting collections. MongoDB documents numeric validator bounds in its [JSON Schema reference](https://www.mongodb.com/docs/manual/reference/operator/query/jsonschema/); the exact-value failure and fix were established by FieldMerge's executable tests.

Canonical source JSON retains original offset/high-precision timestamp spelling. BSON dates retain milliseconds; SQL timestamps have PostgreSQL precision. Original source spelling, rather than a lossy BSON conversion, participates in retry identity. Tests also preserve missing/null/false/zero distinctions and exact decimal validation.

## Reproduce and inspect

With Docker Desktop running and the setup/backend configuration completed, run suites sequentially from the project folder:

```powershell
pnpm build
pnpm test:unit
pnpm test:security
pnpm test:api
pnpm test:acceptance
pnpm test:browser
```

The HTTP suites share temporary port 3100 and must not run concurrently. Security tests use unique databases on the development services and private fallback directories under ignored `tmp/security-events`; acceptance uses separate disposable services. Development business records are preserved. See `output/security/verification.json`, `checks.json`, `browser.json`, and `escaped-record.png`. The separate regression runs pass 33 API groups, all 35 acceptance cases, and 15 browser workflows with nine representative axe checks; no browser runtime errors were recorded. These counts describe different suites and should not be added as independent guarantees.

To inspect development failures, apply schemas with `.\scripts\database.ps1 Setup`, restart running API/worker processes after updating code, then run `pnpm dev` and open http://localhost:3000. Generate a denied request or stale action and inspect `X-Request-Id` in browser Developer Tools → Network. A reviewer can read the latest 1–100 SQL events, default 50:

```powershell
$base = 'http://localhost:3000'
$accounts = Get-Content .\tmp\database-fixtures\demo-accounts.json -Raw | ConvertFrom-Json
$reviewer = $accounts | Where-Object role -eq 'reviewer'
$login = @{ email = $reviewer.email; password = $reviewer.password } | ConvertTo-Json
Invoke-RestMethod "$base/api/auth/login" -Method Post -Headers @{ Origin = $base } -ContentType 'application/json' -Body $login -SessionVariable reviewerSession
(Invoke-RestMethod "$base/api/operations/security-events?limit=50" -WebSession $reviewerSession).events
```

The endpoint currently has no dedicated interface screen. Keep the generated account file private. Production HTTPS/cookie delivery, CSP, HSTS and hosted TLS configuration are not established by these local HTTP tests. Existing same-origin, role, ownership, session and restricted-database controls remain the local MVP boundary. Final ER/schema/report reconciliation, release rehearsal, and submission materials remain in the project checklist. Prior warmed database performance measurements exclude the new HTTP failure-logging path and are not denial-throughput benchmarks.
