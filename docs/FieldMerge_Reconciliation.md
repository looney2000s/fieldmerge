# Automatic reconciliation implementation

Implemented 10 November 2026 in [migration 002](../database/postgres/migrations/002_reconciliation.sql). Migration 001 remains unchanged. This milestone implements the automatic SQL path; reviewer approvals follow separately.

Update: reviewer decisions are now implemented in migration 003. See [the reviewer guide](FieldMerge_Reviewer_Decisions.md); older future-tense references below refer to the automatic milestone's original boundary.

## Entry point and trust boundary

```sql
SELECT fieldmerge.reconcile_submission(submission_id, expected_payload_hash);
```

The function is SECURITY INVOKER with a fixed search_path and no EXECUTE grant to PUBLIC or fieldmerge_app. It is currently an owner/trusted-worker entry point. It does not accept a caller-selected author or an arbitrary patch on each retry. Do not expose this function directly to a browser or grant ordinary users table privileges to make it work.

The future intake service must verify MongoDB identity/content and canonical hash, then atomically populate submissions.verified_patch, source_verified_at, and ready state. verified_patch contains the source's raw scalar patch; normalization occurs during SQL processing. An empty verified patch is allowed for an already-validated evidence-only submission. SQL does not itself prove the presence of source observations or recompute the MongoDB canonical envelope fingerprint. The current test fixtures explicitly simulate that trusted handoff.

Once source_verified_at is set, the request identity, target/base, form, source hash, observation/receipt timestamps, verified patch, and verification time cannot be edited through normal SQL UPDATE. Initial reconciliation_result is also protected once recorded. Evidence may be corrected only through a new submission.

## Processing behavior

1. Look up the target and lock its tree_records row before locking the submission. Other publishers must follow the same order.
2. Verify the expected hash. A matching retry with an existing receipt returns that initial result without new versions or audit events.
3. Require verified input, a ready state or expired processing claim, an active surveyor author, and an active tree. A live processing claim cannot be stolen.
4. Validate the whole patch, its supported form, and the observation's campaign lower boundary. Invalid content records a rejected receipt and audit event with no partial field effects. Operational/prerequisite errors raise exceptions and remain retryable after the cause is corrected.
5. Normalize species whitespace. Preserve typed null, boolean false, and numeric zero. Reject unknown fields, invalid types, negative/out-of-range diameter, and excess precision before publication.
6. Read the current snapshot under the tree lock. Compare each field to base/current and inspect every intervening accepted value transition, including reversals.
7. Publish all compatible changed fields in one new snapshot. Preserve conflicting current values and create pending field_changes. Clock/campaign upper-bound warnings hold actual changes for review. No-change/already-represented fields never create a redundant version.
8. Commit field outcomes, final submission state, cleared processing claim, original receipt, and audit event in the caller's SQL transaction.

The function makes no separate commit. If the caller rolls back or an error occurs late in processing, versions, changes, receipt, and audit effects all roll back together. Future backend callers should retry serialization/deadlock errors as whole transactions, using the same request identity.

Result fields: submission_id, state, published version_no (or JSON null), compared_version_no, and per-field outcomes. Rejected receipts instead include reason. Possible initial states are applied, partially_applied, needs_review, no_change, and rejected. A later reviewer may change the live state; replay still returns the original initial receipt.

## Provenance

field_value_provenance supplies one row per accepted version and canonical field. It locates the last actual value transition and joins the applying proposal and any terminal reviewer decision. Carried-forward values retain their earlier origin; baseline unknown values remain attributed to version 1. No extra provenance table or duplicated current-state row is required.

The automatic function writes the expected proposal/version links. Global consistency triggers that reject arbitrary privileged writes with missing or contradictory links remain for the reviewer/integrity milestone. Database owners remain outside the ordinary application threat model.

## Reproduce verification

```powershell
.\scripts\database.ps1 Verify
```

This applies both migrations to a fresh isolated test database. It runs:

- 39 existing PostgreSQL structure checks.
- 32 reconciliation assertions: publication, partial merges, conflicts, reversal history, no-change/already-represented behavior, normalization, null/false/zero, invalid whole-patch rejection, warnings, inactive/retired prerequisites, leases, immutable verified inputs/receipt, and atomic rollback/retry.
- Two actual concurrent-session scenarios: competing proposals and simultaneous retries of the same submission. The first session holds the tree lock through a deliberate test barrier; the second must wait and then observe committed state.
- 31 MongoDB structure checks and cross-store form-definition hash agreement.

The concurrency harness asserts the barrier through pg_stat_activity rather than assuming both sessions overlapped. Its extra fixtures remain only in the isolated test database. SQL assertion fixtures roll back; development seed data is preserved.

The last successful results are in [verification.json](../output/database/verification.json). Setup runs the test suites before applying new migrations to development. Repeating Setup also verifies the checksums of previously applied migrations.

## Remaining work

Reviewer approval with expected-version/change-revision and decision-idempotency checks; authenticated identity and row access policies; verified MongoDB intake/fingerprint calculation; draft finalization and source recovery; complete workflow-wide consistency triggers; end-to-end API tests and UI. The SQL automatic-processing tests do not establish these remaining guarantees.
