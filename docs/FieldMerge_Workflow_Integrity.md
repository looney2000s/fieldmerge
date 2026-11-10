# Commit-time workflow integrity

Implemented 10 November 2026 in migration 006. This closes the previously documented gap between individually valid foreign keys and a consistent publication/review transaction. No business entity or table was added.

## What the database now enforces

| Invariant | Enforcement |
|---|---|
| Every changed nonbaseline snapshot field has exactly one applying link | Compare each version with its parent; require the same-record/version/field link. Existing uniqueness prevents two links. |
| An applying link represents a real change | Reject links to unchanged fields, mismatched source submissions, and incorrect accepted values. |
| Publication values and actors match their origin | Automatic values match normalized proposals and the author; reviewed values match chosen values and the reviewer. |
| Proposals describe their actual source and comparison | Check base/current snapshots, verified patch coverage, species normalization, and intervening accepted transitions up to the original comparison version. |
| Initial outcomes follow reconciliation rules | Recompute classification, warning-held changes, initial field dispositions, and the original reconciliation receipt. |
| Terminal field dispositions require a valid decision | Validate action/chosen value, comparison/version/revision, result version, resulting state, and immutable decision receipt. |
| Live submission state agrees with its fields | Derive needs_review/partially_applied/applied/no_change/resolved from initial outcomes and subsequent decisions. |
| Rejections publish nothing | Require the rejected receipt/reason and audit; reject any associated field effects or snapshots. |
| Incomplete intake publishes nothing | Awaiting/ready/processing rows cannot have publication effects or workflow receipts/audits. |
| Workflow audit agrees with effects | Require one matching reconciliation/rejection event and one correctly attributed event per decision. |

Most of these checks must run after the related rows have all been written. Five constraint triggers, initially deferred, invoke assert_submission_consistent for affected submissions when their transaction commits. The checks inspect source-owned versions rather than scanning every tree's complete workflow. Multiple queued events may recheck the same submission; performance on larger datasets remains to be measured.

Decision receipt state is additionally checked when the decision is inserted, against the live submission state at that moment. Later decisions may legitimately change that state, while the earlier original response remains immutable.

The version-1 baseline is exempt from applying-link requirements. Existing primary/foreign keys, field constraints, the initial-version participation trigger, and immutable version/decision/audit triggers remain in force.

## Who may write workflow rows

fieldmerge_workflow is a non-login role without superuser, database-creation, role-creation, or RLS-bypass privileges. The existing reconcile_submission, review_change, and api_finish_submission functions execute under that role with fixed search paths. Their function OIDs are preserved, so API calls remain bound to the protected entry points.

The role receives the table/sequence/helper access those functions require. Row-locking reads also require an UPDATE grant on one column of users and tree identities; the functions do not change those identities. No membership in this role is granted to the API account. No client-selectable configuration variable authorizes a write.

Mutation guards reject direct nonbaseline publication, field/decision writes, reserved workflow audit events, and submission workflow-state changes outside those entry points. They also prevent deleting reserved intake/field history or reopening/rewriting terminal field outcomes. Updating operational last_error/updated_at does not grant publication authority.

Trusted owner tooling may insert initial awaiting_document or verified ready SQL fixtures. These are not user-facing operations and still must satisfy commit-time consistency. SQL alone cannot verify a MongoDB envelope; actual application intake continues to verify source/form identity, canonical content, and BSON projection before calling api_finish_submission.

The API account retains only its session-aware wrapper grants and no direct table privileges. PostgreSQL RLS is not used. A database administrator can deliberately SET ROLE, alter functions, or disable triggers; administrator/backend compromise is outside the end-user access model. These safeguards catch unsupported ordinary writes and workflow inconsistencies, not a hostile superuser.

## Transaction and HTTP behavior

Leave these constraint triggers deferred while running a multi-row workflow. After a complete function call, SET CONSTRAINTS ALL IMMEDIATE can force the same checks early; restore deferred timing before starting another publication in that transaction. API handlers use the default transaction timing.

An integrity failure uses SQLSTATE 23514 with a workflow integrity prefix. The HTTP boundary returns 503 workflow_integrity_failure, distinguishing server inconsistency from an invalid client field. It does not return a successful receipt for a rejected COMMIT.

For example, if an unexpected trigger changes health during a species-only publication, the missing health applying link prevents the commit. The accepted snapshot, field outcomes, verification transition, receipt, and workflow audit all roll back. The reserved SQL request and sealed MongoDB source can remain from earlier intake steps. After the fault is resolved, retry the original request; never change its content under the same ID.

Migration 006 validates pre-existing SQL submissions before recording success. Inconsistent historical data stops the upgrade transaction; it is not silently rewritten. Future migration changes must use a new numbered file.

## Verified evidence

Run .\scripts\database.ps1 Verify, then pnpm build and pnpm test:api. Setup runs the database suite before applying migrations to development.

This integrity suite has 52 assertions and four actual COMMIT scenarios, alongside the project's structural/workflow/recovery/query and concurrency suites. Current totals are maintained in the repository README. Evidence, including migration checksums, is saved to output/database/verification.json. Migrations 007–008 add recovery and transport metadata/entry points without weakening publication checks.

The integrity tests inject mismatched snapshot fields/values/publishers, proposal/base/comparison errors, incorrect applying links/revisions, missing changes, incorrect live states/receipts, inconsistent decisions, and missing/misattributed audits. Each failure must leave its publication or review effects rolled back. The actual COMMIT tests demonstrate automatic publication, rejection/rollback of a version without its applying links, rejection/rollback of decisionless disposal, and a valid keep-current decision without a new version.

Fault triggers and administrative SET ROLE calls are isolated test fixtures. Production guards are not disabled. The older structural suite intentionally uses rolled-back incomplete row fixtures to test basic PK/FK/domain constraints; it is not evidence that those incomplete graphs can commit. The new integrity/COMMIT suites verify that distinction.

An HTTP integration fault test corrupts a real attempted snapshot, expects 503, checks that SQL remains awaiting_document with no new accepted version, removes the fault, and retries the unchanged request to obtain one publication/audit event. The complete API evidence is in output/api/verification.json.

[Recovery/inspection](FieldMerge_Recovery.md) and [queries/exports/batch grouping](FieldMerge_Queries_Exports_Batches.md) are implemented. Complete acceptance mapping, performance measurements, and the full UI remain. These checks do not provide a distributed transaction with MongoDB or prove factual correctness of survey observations.

PostgreSQL documents [deferred constraint triggers](https://www.postgresql.org/docs/current/sql-createtrigger.html) and [constraint timing](https://www.postgresql.org/docs/current/sql-set-constraints.html). FieldMerge's invariants, protected execution role, and validation protocol are project design choices.
