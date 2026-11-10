# Automatic recovery and operational inspection

Implemented 10 November 2026 in migration 007 and the local Node.js recovery worker. The worker resumes SQL intake and sealed finalizing drafts without a browser session. It does not mint sessions or impersonate a logged-in user; publication remains attributed to the original SQL author.

## Run locally

Database setup and restricted credentials have been configured on this checkout. In a separate PowerShell terminal at the project root:

```powershell
pnpm worker
```

Keep that process running for automatic recovery. It polls every five seconds, scans at most 50 finalizing drafts, and processes at most ten jobs per cycle. Ctrl+C requests a stop after the current bounded cycle. This is a foreground local process, not an installed Windows service or an automatically restarted hosted service.

For a single bounded cycle:

```powershell
pnpm worker:once
```

An empty queue normally reports processed: 0. A zero exit code means the cycle ran; inspect outcomes/discovery_failed and the operational API to determine whether individual jobs completed. Logs contain identifiers/status/error codes, not source envelopes, passwords, lease tokens, or receipts.

On a fresh clone, run .\scripts\database.ps1 Setup, install dependencies, then pnpm configure:backend before starting the worker. That provisioning command creates fieldmerge_worker SQL/MongoDB logins and stores generated WORKER_DATABASE_URL/WORKER_MONGODB_URI plus passwords only in the ignored .env. Runtime code rejects owner/root connection identities.

## Durable state and protocol

Migration 007 adds two internal SQL tables, without changing the nine business entities:

| Relation | Main columns and meaning |
|---|---|
| fieldmerge_ops.recovery_jobs | job_id PK; unique (job_kind, target_id); owner_id FK; optional submission_id FK; status; lifetime attempts; consecutive failure_count; next_attempt_at; private lease_token; lease_expires_at; claimed_by; bounded last_error_code; created/updated/completed times. Submission-kind target_id must equal its nonnull submission_id. |
| fieldmerge_ops.recovery_events | event_id identity PK; job_id FK; queued/claimed/failure/retry_requested/completed event; optional reviewer actor_id FK; bounded structured metadata; server time. Update/delete is prohibited. |

The SQL repository contains nine business tables, two authentication tables, recovery jobs/events, transport batches/items, and the migration registry. See [the transport schema](FieldMerge_Queries_Exports_Batches.md) for the later batch extension. MongoDB still has three collections. Its finalizing-draft discovery index is (state, _id).

Every new SQL reservation automatically queues a submission job in the reservation transaction. Successful ordinary API publication completes that job in the publication transaction. Upgrading also queues existing incomplete SQL submissions. A worker discovers sealed finalizing MongoDB drafts, including a crash between freezing the document and reserving SQL intake, and idempotently registers their jobs. Editable drafts are never automatically finalized.

Workers claim due jobs using FOR UPDATE SKIP LOCKED, commit a random 60-second lease token, and release SQL locks before accessing MongoDB. A replacement worker can claim an expired lease. Context reads and publication check the token/expiry; publication locks the tree, submission, then operational job, matching the normal publication order. An expired worker cannot publish over a successor. A late request may return an already committed receipt without applying anything again.

For a submission job, the worker reads and validates canonical source content, checks form identity/hash and the entire BSON projection against SQL metadata, and invokes a fenced publication function. Missing original source is never reconstructed from a scalar patch.

For a draft job, it verifies the frozen document, reserves the same author-scoped submission identity, inserts source evidence once, follows the same verification/publication path, and repairs finalized navigation metadata. SQL commit followed by a failed MongoDB metadata update remains recoverable. Draft content/revision/request ID stay frozen. A retry never creates a correction implicitly.

## Status and retry policy

| Job status | Meaning |
|---|---|
| queued | Eligible for a worker now. |
| leased | One bounded claim is active. Expired claims can be reclaimed. |
| retry | Temporary service failure or busy processing; due after bounded exponential backoff. |
| waiting_source | SQL identity exists but the original MongoDB evidence is absent; recheck after 60 seconds. The author can upload the unchanged original envelope. |
| blocked | Inactive author, unavailable prerequisite, or eight consecutive automatic failures. Requires correcting the cause and/or an explicit retry. |
| quarantined | Source/form/draft integrity mismatch, invalid stored envelope, conflicting identity, missing sealed draft, or SQL workflow integrity rejection. No automatic rewriting or publication. |
| completed | Original SQL outcome exists, and draft navigation was finalized when this was a draft job. The outcome may still require reviewer decisions. |

Temporary retries back off from ten seconds to at most five minutes. After eight consecutive failures, automatic retry stops. A reviewed retry resets that consecutive failure budget, but preserves lifetime attempts and the event history. An unchanged owner upload can still complete its submission job through the normal API, including when recovery is waiting or blocked.

Error disposition/events are committed separately after a failed publication transaction, so they survive that rollback. If the worker dies before recording an error, its lease remains reclaimable. Quarantine is an operational status, not a new business submission state. A reviewer retry only reschedules inspection of the same evidence; it cannot edit evidence, change its identity, bypass an inactive author, or force acceptance.

## Reviewer operations API

Start pnpm dev and log in as a reviewer using [the API guide](FieldMerge_API.md).

| Route | Method | Result |
|---|---|---|
| /api/operations/recovery | GET | Latest 100 jobs, incomplete first; current source state, attempts, due/lease times, and safe error codes. |
| /api/operations/recovery/:jobId | GET | Safe job metadata and latest 30 immutable operational events. |
| /api/operations/recovery/:jobId/retry | POST | JSON reason, 1–500 characters; queues the same job and records the authenticated reviewer/reason. |

An actively leased or completed job cannot be rescheduled. Surveyor requests are denied. These endpoints omit lease tokens, worker credentials, and draft/source payloads; unfinished draft content is not exposed to reviewers. The graphical operations screen remains to be built.

After signing in with a separate $reviewerSession:

```powershell
$jobs = Invoke-RestMethod "$base/api/operations/recovery" -WebSession $reviewerSession
$jobs.jobs | Format-Table job_id, job_kind, status, attempts, last_error_code
$pending = $jobs.jobs | Where-Object status -ne 'completed' | Select-Object -First 1
if ($pending) {
  Invoke-RestMethod "$base/api/operations/recovery/$($pending.job_id)" -WebSession $reviewerSession
}
```

After investigating/correcting the cause, send POST to that job's retry route with the usual Origin header and a JSON body such as {"reason":"Connectivity restored; retry original evidence"}. Do not include secrets in reasons. For missing evidence, the owner's unchanged original upload is preferable to repeatedly scheduling an empty recovery attempt.

## Permissions and verification

fieldmerge_worker has no direct SQL table access, session-creation permission, or membership in fieldmerge_workflow. It can call only dedicated recovery functions. Actor/target identities come from persisted jobs and reservations. MongoDB permissions allow evidence insert/read, form read, and draft find/update; they exclude evidence update/delete, form editing, and draft creation/deletion. Draft state/identity predicates are enforced by the trusted worker, not by per-user MongoDB accounts. Backend/administrator compromise is outside this model.

Run .\scripts\database.ps1 Verify, pnpm build, and pnpm test:api. The recovery queue has 21 SQL assertions alongside the project's other database suites. Current full-suite totals are maintained in the repository README.

Integrated recovery coverage includes restricted credentials, reviewer-only inspection/retry, missing-source waiting, immutable quarantine, stored-source recovery without a user session, sealed drafts before SQL reservation and after SQL commit, competing workers, expired-token fencing, inactive authors, connection-failure backoff, and an actual worker-process kill/restart. Batch recovery preserves the first-intake attribution in SQL and MongoDB. Tests park unrelated fixtures only inside their disposable databases.

The process-kill test observes a persisted live lease, kills the child process, advances its expiry in the isolated fixture rather than sleeping a minute, and starts a fresh CLI process that publishes once. Connectivity tests use an unreachable loopback port; they do not stop the user's development MongoDB container. Saved evidence is in output/database/verification.json and output/api/verification.json.

Remaining limits include the graphical operations screen, pagination/filtering, measured queue capacity, deployment/service supervision, and complete acceptance/browser coverage. Discovery is bounded and its cursor restarts safely; a scan failure is reported without stopping independent SQL jobs. PostgreSQL unavailability pauses the cycle, and database recovery resumes on subsequent polling. There is no distributed transaction across SQL and MongoDB.

PostgreSQL documents [SKIP LOCKED for queue consumers](https://www.postgresql.org/docs/18/sql-select.html). Job statuses, lease fencing, source checks, and error/retry policy are FieldMerge project design decisions.
