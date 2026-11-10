# Owner-scoped drafts and safe finalization

Implemented 10 November 2026. Drafts live in MongoDB; finalization uses the existing verified SQL/source intake. No business table was added. Migration 005 adds a session-aware function validating a draft's active tree, existing base version, and supported form.

## Access and lifecycle

Only an active surveyor may operate on their own drafts. The server derives the owner from the SQL session. Reviewer access is denied, and requests for another surveyor's draft return 404. A reviewer reads finalized source evidence through submission routes instead.

The lifecycle is editable → finalizing → finalized, or deletion while editable. Every edit and deletion requires expected_revision_no. A successful edit replaces the entire partial payload, increments the revision, and assigns a fresh future client_submission_id. Tree, base version, and form stay fixed; create a new draft to change them.

Partial drafts may omit patch, observation time, or both. Every supplied value is still validated. Full validation runs before finalization freezes the draft. For example, finalizing an empty draft returns 400 and leaves it editable without reserving SQL intake. Saving an edit after such a failure creates a new finalization request identity.

Finalization atomically matches owner, editable state, and expected revision before changing state to finalizing. That transition preserves the revision and canonical content. An edit/delete that loses this race returns 409. A finalizer that loses to an edit must refresh; it cannot publish the stale revision. Simultaneous finalizers resume the same sealed content and idempotency key.

The server then calls ordinary verified intake. On success it records finalized plus final_submission_id. Finalized means an immutable source was processed; its receipt can still say needs_review or rejected. It does not mean every proposed value was accepted.

Failures after the freeze leave the draft sealed. Retry the same finalize route with the same expected revision. This safely covers interruption before SQL reservation, after reservation, after source storage, after SQL commit, and after marking the draft finalized. Never unlock or edit a finalizing document merely because the client saw a timeout.

## Route contract

| Route | Method | Body and result |
|---|---|---|
| /api/drafts | GET | Latest 100 own drafts, including finalizing/finalized navigation metadata. |
| /api/drafts | POST | record_id, base_version_no, form_version, optional payload; returns 201 and draft. |
| /api/drafts/:id | GET | Own draft metadata and canonical_payload_json. |
| /api/drafts/:id | PUT | expected_revision_no and replacement partial payload; returns updated draft. |
| /api/drafts/:id | DELETE | expected_revision_no; deletes only an editable matching revision. |
| /api/drafts/:id/finalize | POST | expected_revision_no only; returns draft and receipt. |

As with other mutations, send application/json and the configured Origin, plus the session cookie. Attempts to supply owner/state/revision/request IDs as create fields, or to replace target identity during an edit, are rejected. A stale revision returns stale_draft_refresh_required; editing/deleting sealed content returns draft_is_sealed.

canonical_payload_json contains the envelope with server-generated request identity and the draft's partial payload. Its number/timestamp strings are retained through finalization without a JavaScript floating-point or BSON-date round trip. BSON projections still use Decimal128 and Date. The server verifies the projection against the canonical representation before finalizing.

## Try it from PowerShell

Start the application and sign in as a surveyor using [the API guide](FieldMerge_API.md). Reuse its $base, $headers, and $surveyorSession variables:

```powershell
$id = '30000000-0000-4000-8000-000000000001'
$snapshot = Invoke-RestMethod "$base/api/records/$id" -WebSession $surveyorSession
$create = @{
  record_id = $id
  base_version_no = $snapshot.record.version_no
  form_version = 'tree-v2'
} | ConvertTo-Json
$created = Invoke-RestMethod "$base/api/drafts" -Method Post -Headers $headers -ContentType 'application/json' -WebSession $surveyorSession -Body $create
$draft = $created.draft
$path = "$base/api/drafts/$($draft.draft_id)"
$edit = @{
  expected_revision_no = $draft.revision_no
  payload = @{
    observed_at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    patch = @{ health = 'Fair'; guard_damage = $false }
  }
} | ConvertTo-Json -Depth 10
$saved = Invoke-RestMethod $path -Method Put -Headers $headers -ContentType 'application/json' -WebSession $surveyorSession -Body $edit
$finalize = @{ expected_revision_no = $saved.draft.revision_no } | ConvertTo-Json
$result = Invoke-RestMethod "$path/finalize" -Method Post -Headers $headers -ContentType 'application/json' -WebSession $surveyorSession -Body $finalize
$result.receipt
```

Repeat the final request unchanged to retrieve the same receipt. A proposal matching the accepted value may produce no_change. For editable-draft deletion, use DELETE with the current expected_revision_no before finalizing. Deleting a finalized draft is intentionally denied.

## Verification and remaining limits

Run pnpm test:unit, pnpm build, then pnpm test:api. The integrated suite exercises owner/role denial, invalid references, partial validation, revision-safe edits/deletes, simultaneous edits, edit/delete versus finalization, simultaneous finalizers, and restart-safe requests after injected interruptions around real database operations. It checks for one SQL identity, one reconciliation audit event, and exact canonical evidence preservation. Failpoints are dependency injection in tests and cannot be selected through HTTP.

The verified production build passes. All six unit test groups and fourteen integrated API test groups pass. The rerun database suite also passes 136 assertions and six SQL concurrent-session scenarios. Saved integration evidence is in output/api/verification.json; database evidence is in output/database/verification.json. Injected interruption tests demonstrate resumability at those boundaries, not a process-kill or database-outage experiment.

The MongoDB API user now has the existing draft-editor role in addition to insert/read evidence roles. It still cannot rewrite sealed source evidence or forms. Ownership and draft-state transition rules are enforced by server queries, not by per-user MongoDB accounts. A compromised trusted backend/database administrator is outside this access model.

The canonical draft field is optional in the collection validator for compatibility with earlier structural fixtures; all API-created drafts include it. A legacy editable draft lacking it must be saved through PUT before finalization. State/owner/revision predicates apply even when those older documents are encountered.

There is no unattended recovery worker, full draft editor screen, bulk draft finalization, draft-create idempotency token, or paginated draft browser yet. If a create response is lost, list own drafts before creating another. Operational form/record changes after a draft is frozen may prevent progress until the configuration is resolved; frozen content is never silently rebased or rewritten. Do not reuse a draft's generated request ID for a different direct upload.

MongoDB's single-document atomic update/filter behavior supports the revision-checked transition; FieldMerge's cross-store retry protocol remains an application design, with no distributed transaction claim. See [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) and [Node.js compound operations](https://www.mongodb.com/docs/drivers/node/current/crud/compound-operations/).
