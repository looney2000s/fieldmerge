# Reviewer decision implementation

Implemented 10 November 2026 in migration 003. This extends the automatic reconciliation path without changing migrations 001 or 002.

## Entry point

```sql
SELECT fieldmerge.review_change(
  p_reviewer_id,
  p_client_decision_id,
  p_change_id,
  p_expected_version_no,
  p_expected_change_revision,
  p_action,
  p_chosen_value,
  p_reason
);
```

All identifiers are UUIDs; version and revision tokens are positive integers. The reason is a nonblank string of at most 2000 characters. Actions:

| Action | chosen value argument | Effect |
|---|---|---|
| accept_proposal | SQL NULL | Use the pending proposal's normalized value. |
| keep_current | SQL NULL | Reject the proposal and retain the latest accepted value. |
| replace | Valid JSONB scalar | Use the reviewer's replacement. JSON null explicitly clears a nullable field. |

Passing a replacement value with another action is rejected rather than silently ignored. SQL NULL is not a replacement value; use `'null'::jsonb` for an explicit clear. Species replacements are normalized as in automatic reconciliation; other field domains, including exact decimal precision, are validated before publication.

Migration 006 makes this a SECURITY DEFINER entry point owned by the restricted non-login fieldmerge_workflow role. PUBLIC, fieldmerge_app, and fieldmerge_api have no raw EXECUTE grant. The implemented api_decide wrapper derives reviewer identity from its session and calls this function. Passing a reviewer UUID is not sufficient authentication, and this function must not be exposed directly to end users.

## Transaction and concurrency behavior

1. Validate the request and verify an active reviewer account. The account is held under a shared row lock during the decision so concurrent deactivation cannot intervene unnoticed.
2. Fingerprint the complete request using PostgreSQL's JSONB serialization and SHA-256. This internal decision fingerprint is separate from the client-envelope canonicalizer used for MongoDB intake. It includes exact reason/replacement content and version/revision tokens.
3. Acquire a transaction-scoped advisory lock on reviewer plus client decision key. This also protects same-key requests targeting different trees. Hash collisions cause extra serialization, not permission changes.
4. For an existing key, reject changed content or return its immutable original receipt. Replay does not create another version or audit event. Old owner-inserted decisions without receipts require a controlled backfill before they can be replayed through this interface.
5. Lock the tree, then submission, then pending field change. This agrees with the automatic publication lock order. Require an active tree and a submission that completed automatic processing and still has reviewable state.
6. Compare the supplied accepted-version and pending-change revision tokens to current state. A mismatch requires refresh and reconsideration; never silently rebase an approval.
7. Publish one new snapshot only when the selected accepted value actually differs. Preserve every other field. Resolve the selected field, increment its revision, and recalculate the submission's live state.
8. Append the decision, immutable receipt, and audit event in the same transaction as publication. Any failure rolls back every effect.

Only one terminal decision is allowed per change. Other proposals for the same tree/field remain pending until explicitly reviewed. If another operation has already made a proposal's value current, accepting it closes it as already_represented without a new snapshot. Replacing with the current value closes as no_change. Keeping current closes as rejected. These are field dispositions, not invalid-submission statuses.

If pending fields remain, the submission stays needs_review or partially_applied according to whether any fields have applied. Once all pending fields are disposed, it becomes resolved. Initial automatic receipts remain unchanged; retrying reconciliation still returns its initial receipt while the live submissions row reflects subsequent decisions.

## Error contract

| SQLSTATE | Meaning and required response |
|---|---|
| 22023 | Invalid action/value/reason/tokens or changed content using a reserved decision key. Correct the request; do not blindly retry. |
| 42501 | Account is not an active reviewer, or ordinary application privilege is missing. |
| P0002 | Proposed field change not found. |
| 55000 | Change already disposed, source not reviewable, retired tree, or legacy receipt missing. Refresh or use an explicit operational correction. |
| 40001 | Current version/revision differs from the reviewer's tokens. Refresh the comparison and require a new considered decision. Do not transparently retry a stale approval with new tokens. |
| 23514 | Inconsistent field-change identity or a commit-time workflow mismatch. Treat a workflow integrity failure as operational; the HTTP boundary returns 503. |

The function records successful terminal decisions. Failed/stale calls raise exceptions; a surrounding rollback also rolls back any same-transaction audit write. Recording failed attempts durably will be handled by the API/operational logging boundary, not by pretending an aborted transaction persisted its audit.

## Receipts and provenance

review_decisions.decision_result stores the exact committed response, protected by the existing immutable-decisions trigger. It contains decision, change, submission and reviewer identifiers; action and chosen value; field/submission states; reviewed and produced versions; and resulting change revision. It is the original outcome, not a live status query.

Published versions point to the original proposal's submission and the responsible reviewer. field_value_provenance joins the applying change to the terminal decision, explaining a reviewer replacement even when it differs from proposed_value. Unchanged fields retain their earlier origin. A decision that changes no value does not take over provenance.

## Verification

Run `.\scripts\database.ps1 Verify` from the project root. The suite now includes 34 reviewer assertions plus four real concurrent-session scenarios:

- Distinct reviewers attempting the same pending change: one terminal decision.
- Identical reviewer retry keys in overlapping sessions: same receipt, one audit event.
- Same reviewer/key used on different trees with different content: second request rejected, other proposal remains pending.
- Reviewer publication overlapping automatic reconciliation on the same tree: automatic processing waits, reads the new accepted state, and holds a stale competing proposal.

Other assertions cover all actions, no-op decisions, JSON null/zero/false, species normalization, stale version/revision tokens, permission checks, original reconciliation receipts, provenance, and rollback after an injected final-audit failure. These use trusted SQL fixtures, not authenticated API requests or live MongoDB intake.

Migration 006 additionally verifies decisions, chosen values, applying links, receipts, live states, and workflow audit together. Its 52 assertions and four actual COMMIT scenarios are documented in [workflow integrity](FieldMerge_Workflow_Integrity.md). Separate API tests cover the authenticated reviewer path. The upgrade refuses inconsistent or receipt-less pre-existing decision graphs instead of silently backfilling history.

## Remaining boundary

Persistent recovery coordination and operational visibility, richer query/export routes, full browser/acceptance coverage, measured performance, and Next.js screens remain. Authentication, verified source intake, owner-scoped draft finalization, requested recovery, and commit-time SQL consistency are implemented. Ordinary API roles access session-aware wrappers, with direct workflow/table access denied; PostgreSQL RLS is not claimed.
