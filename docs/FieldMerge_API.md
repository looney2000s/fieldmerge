# Authenticated API milestone

Implemented 10 November 2026 on feature/authenticated-api, extended on codex/drafts-finalization. This is a runnable Next.js App Router backend, with a minimal status home page. [Owner-scoped draft APIs and safe finalization](FieldMerge_Drafts.md) are now implemented. The complete interface and a persistent recovery worker remain separate work.

## Start locally

```powershell
.\scripts\database.ps1 Setup
pnpm install --frozen-lockfile
pnpm configure:backend
pnpm dev
```

The application URL is http://localhost:3000. APP_ORIGIN must match the browser/client Origin exactly; use that URL consistently. Use pnpm build followed by pnpm start for the production server. All API routes use the Node.js runtime and dynamic, noncached responses.

The ignored .env contains generated restricted connection settings. configure:backend is an administrative provisioning step; request handlers use fieldmerge_api credentials. Never expose .env or generated account-password fixtures publicly. No hosted authentication provider or paid service is required.

## Login and read records from PowerShell

```powershell
$base = 'http://localhost:3000'
$headers = @{ Origin = $base }
$accounts = Get-Content .\tmp\database-fixtures\demo-accounts.json -Raw | ConvertFrom-Json
$surveyor = $accounts | Where-Object role -eq 'surveyor'
$login = @{ email = $surveyor.email; password = $surveyor.password } | ConvertTo-Json
Invoke-RestMethod "$base/api/auth/login" -Method Post -Headers $headers -ContentType 'application/json' -Body $login -SessionVariable surveyorSession
Invoke-RestMethod "$base/api/auth/me" -WebSession $surveyorSession
$records = Invoke-RestMethod "$base/api/records" -WebSession $surveyorSession
$records.records
```

Mutation requests require an exact allowed Origin header and application/json for JSON bodies. The API denies forged author/reviewer IDs in user envelopes; the session determines identity.

## Submit a proposal

Take a snapshot before editing. Retain the exact client submission ID and content for retries.

```powershell
$id = '30000000-0000-4000-8000-000000000001'
$snapshot = Invoke-RestMethod "$base/api/records/$id" -WebSession $surveyorSession
$proposal = @{
  client_submission_id = [guid]::NewGuid().ToString()
  record_id = $id
  base_version_no = $snapshot.record.version_no
  form_version = 'tree-v2'
  observed_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  patch = @{ health = 'Fair' }
}
$body = $proposal | ConvertTo-Json -Depth 10
$receipt = Invoke-RestMethod "$base/api/submissions" -Method Post -Headers $headers -ContentType 'application/json' -WebSession $surveyorSession -Body $body
$receipt
```

The seeded campaign covers 2026. Observations outside its reference window are rejected or held according to the requirements. All demonstration data is synthetic. Submitting a value already represented may return no_change rather than create a version.

Send `$body` unchanged again to verify idempotency. A changed body with the same client_submission_id returns a conflict. An actual correction requires a new client submission ID and a considered base snapshot.

## Routes

| Route | Method | Access and behavior |
|---|---|---|
| /api/auth/login | POST | Seeded account email/password; sets opaque session cookie. |
| /api/auth/me | GET | Active session profile; never returns a password hash. |
| /api/auth/logout | POST | Revokes current session and clears cookie. |
| /api/records | GET | Either role; first 50 accepted records. |
| /api/records/:id | GET | Either role; accepted snapshot and version. |
| /api/records/:id/history | GET | Either role; up to 100 versions and latest field provenance. |
| /api/submissions | POST | Surveyor only; verified single-envelope intake. |
| /api/submissions/batch | POST | Surveyor only; array of 1–100 envelopes, independent per-item results, HTTP 207. |
| /api/submissions/:id | GET | Owner or reviewer; live outcome and per-field changes. |
| /api/submissions/:id/source | GET | Owner or reviewer; original canonical source and receipt time. |
| /api/submissions/:id/recover | POST | Owner surveyor; recover from stored source, or request re-upload if source is missing. |
| /api/reviews | GET | Reviewer only; first 100 pending comparisons with current version/revision tokens. |
| /api/reviews/:changeId | POST | Reviewer only; atomic terminal decision. |

Batch transport IDs are not yet persisted. Pagination/filter parameters and aggregate/export routes are not exposed in this milestone. Draft list/create/read/edit/delete/finalize routes are documented in [the draft guide](FieldMerge_Drafts.md).

## Reviewer requests

Sign in as the seeded reviewer using a separate WebSession. Read /api/reviews, then post the following structure to the chosen change's review route:

```json
{
  "client_decision_id": "b0000000-0000-4000-8000-000000000001",
  "expected_version_no": 2,
  "expected_change_revision": 1,
  "action": "accept_proposal",
  "reason": "Reviewed the source observations"
}
```

Generate a fresh decision UUID, and use the actual current_version_no and revision_no from the comparison. keep_current also omits chosen_value. replace requires chosen_value, which may be JSON null for an explicit clear. Stale approval returns HTTP 409 with stale_review_refresh_required. Refresh and reconsider before issuing a new decision; do not change approval tokens automatically.

## Sessions and access boundary

The existing seeded scrypt password hashes are checked with constant-time comparison. Login creates a cryptographically random 256-bit bearer token. Only its SHA-256 hash and an eight-hour expiry are stored in the internal fieldmerge_auth.sessions table. Cookies are HttpOnly, SameSite=Strict, path=/; HTTPS production origins also receive Secure. Local HTTP is used only for development/testing. Session status and active account/role are checked on each request and again in guarded SQL functions. Logout invalidates the server record immediately.

The database persists a ten-attempt/five-minute limit per normalized email fingerprint. It does not yet provide an Internet-scale IP/risk abuse service. Password reset, registration, and account administration are outside the fixed seeded-account MVP.

fieldmerge_api has no direct table privileges or access to owner workflow functions. It can execute a fixed set of SECURITY DEFINER wrappers, with fixed search paths, deriving the actor from the session token hash. Authentication bootstrap functions are trusted backend entry points; the backend still owns password verification. Database/application credential compromise remains outside the end-user threat model. No PostgreSQL row-level security is claimed: denied direct table access plus session-aware wrappers is the selected database enforcement mechanism.

MongoDB's API user can read forms/evidence and insert sealed evidence, but cannot update/delete source documents or change form definitions. It also has the collection-limited draft-editor role; draft ownership, state, and revision predicates are supplied by the trusted server.

## Canonicalization and source verification

The input parser rejects duplicate JSON keys, comments/trailing commas, excessive depth/size, and unsupported numeric ranges. Decimal.js interprets original number tokens without first rounding them through JavaScript floating-point values. Canonical encoding sorts object keys, preserves array order and string contents, normalizes numeric spelling, and hashes the complete client envelope. Missing, null, false, and zero remain distinct.

MongoDB stores canonical_payload_json alongside the typed BSON projection. Decimal values use Decimal128; timestamps use BSON dates. Canonical source preserves original timestamp spelling and precision, while BSON dates have millisecond precision. Source verification compares canonical content/hash, authenticated owner, target/form/request identity, receipt timestamp, and the full BSON projection. Published form-definition hashes are also compared across stores before intake.

SQL first reserves a request identity. MongoDB then inserts the source once. Duplicate inserts read and verify the existing document; they never replace it. A guarded SQL function marks the verified source ready and reconciles atomically. Interrupted operations can be retried using the original request. A stored-source recovery endpoint is also available to the owner. Source mismatches produce a 503 integrity response and leave intake incomplete.

No distributed transaction is claimed. No unattended queue worker is implemented yet. Recovery currently depends on an owner retry/recovery request; original re-upload is required if no source document was stored.

## Verification and limitations

```powershell
pnpm test:unit
pnpm build
pnpm test:api
```

The API runner provisions unique SQL/MongoDB test databases, builds on existing synthetic fixtures, launches the production Next.js server temporarily, and closes it afterward. It does not mutate development tree records. Admin credentials are used only for provisioning and controlled fault fixtures; actual HTTP handlers and direct bypass checks use restricted credentials.

Coverage includes login/origin/cookie behavior, unauthorized routes and SQL access, own versus other-user source visibility, verified intake and content mismatch, reviewer roles and stale decisions, exact retry receipts, JSON/precision validation, evidence-only and mixed batch input, disabled/expired/revoked sessions, and persistent login throttling.

Interruptions are deliberately injected around real database operations (before source storage, after source storage, before SQL finish, and after commit before response). This verifies resumability of those boundaries; it is not a claim that a live MongoDB process was stopped mid-request. A privileged test also corrupts source metadata to prove verification refuses to publish it.

Results are saved in output/api/verification.json. Remaining work: persistent recovery coordination, complete privileged-write consistency triggers, richer data/query endpoints, the full interface, and full mapping/closure of all 35 acceptance scenarios. This milestone adds two internal authentication tables without changing the nine core business entities. Migration 005 adds draft-target validation without adding a table.

The verified run passes six unit test groups and fourteen integration test groups, with a successful production build. The database suite remains separate evidence: 136 assertions and six concurrent-session scenarios, rerun with migration 005 and the extended draft validator.
