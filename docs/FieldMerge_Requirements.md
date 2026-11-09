# FieldMerge requirements specification

Version 1.0 · 1 November 2026 · Solo DBMS project

## 1 Purpose and authority

FieldMerge reconciles delayed proposals against shared urban tree survey records. It publishes compatible changes, holds disagreements for review, and preserves the provenance of accepted values. This specification fixes the minimum viable behavior before ER modeling and schema implementation.

This is the requirements baseline for implementation. Where its rules differ from the preliminary Word proposal, this specification takes precedence. In particular, it adds detection of intervening field changes, defines complete submission states, and removes the undefined coupled-conflict category. The Word proposal remains the project overview; it is not changed by this document.

No implementation or completed testing is claimed here. All examples are synthetic fixtures with specified expected outcomes.

## 2 Scope and operating assumptions

- One dataset and one survey campaign are supported. A campaign represents a fixed survey reference period; proposals correct or complete its published record. Continuous monitoring of changing real-world conditions is outside scope.
- Every tree has a stable server record ID. Surveyors select existing trees. Creating, merging, or deleting tree identities is restricted to seed/import tooling.
- A published record contains species, perceived health, diameter, and guard damage. These four fields are independent for merge purposes. No rule assumes that a species determines health or that diameter proves a species classification.
- The application supports downloaded snapshots and delayed batch uploads. It need not implement a general offline synchronization engine, native mobile app, maps, or automatic background browser synchronization.
- A batch contains independent single-record submissions. Successful items remain successful when another item fails; batch-wide atomicity is not promised.
- Reviewer decisions establish accepted project data, not verified biological truth. Client timestamps and upload order never independently establish which observation is correct.
- PostgreSQL owns accepted state, version history, workflow outcomes, decisions, and permissions. MongoDB retains source submissions, form definitions, and editable drafts.

### Explicit exclusions

Automatic entity matching, semantic search, AI adjudication, species diagnosis, arbitrary nested merges, multiple organizations, device trust verification, hardware integration, edits based on unpublished local versions, and distributed atomic commits across both databases are excluded. Additional survey domains and a complete offline web application are future enhancements.

## 3 Vocabulary

| Term | Definition |
|---|---|
| Accepted version | Immutable published snapshot of one tree within the campaign. |
| Base version | Existing accepted version against which a surveyor prepared a proposal. |
| Current version | Latest committed accepted version when processing or approval occurs. |
| Patch | Object containing only fields the surveyor proposes to change. |
| Source submission | Sealed original envelope, patch, optional observations, and client metadata. |
| Conflict | A proposed field change that cannot be published automatically under these rules. |
| Resolution | Reviewer action that disposes of a pending change, with a reason. |
| Provenance | Link from an accepted value to its baseline import, applying submission, and decision where relevant. |
| Intervening edit | Actual accepted change to a field after the base version, including a change later reversed. |

## 4 Field definitions

All four editable fields permit explicit null, meaning no accepted value is known. Null is distinct from omission, false, zero, and an empty string. An omitted patch field makes no proposal and cannot erase its accepted value.

| Field | Type and allowed values | Validation and comparison |
|---|---|---|
| species | String up to 120 characters, or null | Trim outer whitespace and collapse repeated internal spaces. Reject empty strings and control characters. Compare resulting strings exactly; no fuzzy matching, synonym inference, or automatic case folding. |
| health | Good, Fair, Poor, or null | Exact enumeration after trimming. Input choices should prevent arbitrary spelling. Null means unknown. |
| diameter_cm | Decimal from 0 to 999999.99, maximum two fractional digits, or null | Canonical unit is centimeters. Reject negative values, nonfinite values, strings, and excess precision. Zero is valid data and never interpreted as missing. The upper limit is a storage bound, not a claim of biological plausibility. |
| guard_damage | Boolean or null | True means damage was reported; false means no damage was reported; null means unknown. This field does not independently assert that a guard exists. Strings such as "false" are invalid. |

The diameter bound follows the preliminary numeric(8,2) representation. FieldMerge does not infer factual correctness from these syntactic bounds. If plausibility warnings are later added, they must not silently correct user values.

### Import rules

The importer maps the chosen public source's identifiers and allowed values explicitly. It verifies source units before converting diameter to centimeters. Source missing-value codes map to null through a documented mapping, never by a generic zero-to-null rule. Any rounding required by import conversion is recorded as an import transformation. Do not invent guard-damage observations absent from the source; seed that field as null when necessary.

Store the dataset identifier, source record ID, attribution URL, import time, and mapping version. An identical re-import must not overwrite subsequent accepted versions or create duplicate identities.

## 5 Submission and form contract

| Attribute | Requirement |
|---|---|
| client_submission_id | UUID generated once per logical final submission. Scoped to the authenticated author. Reused unchanged for retries. |
| record_id | Existing active tree record in the configured dataset/campaign. |
| base_version_no | Positive integer identifying an existing accepted version of that record. Never guessed or supplied as an unpublished local revision. |
| form_version | Supported immutable published form definition. |
| observed_at | ISO 8601 timestamp with explicit UTC offset. Stored as UTC; retained as claimed evidence. |
| patch | Object containing only permitted canonical fields. At least one patch field or one evidence observation is required. |
| observations | Optional array of structured evidence entries, governed by the form definition. Does not itself change accepted scalar fields. |
| client_metadata | Optional bounded object describing client/app context. Never used to grant access or identify the authenticated author. |

The server assigns submission_id, author identity, received_at, processing state, and content fingerprint. Client attempts to supply server-owned fields are rejected. The server retrieves base values itself; it does not trust a client snapshot as authoritative history.

### Two controlled form versions

- **tree-v1:** Envelope and the four supported scalar patch fields. Optional free-form metadata is bounded but has no merge semantics.
- **tree-v2:** Same canonical fields plus repeated observations. Each observation contains category (guard, trunk, root, branch, or other), a nonempty note of at most 500 characters, and an observation timestamp. Up to 20 observations are allowed.

Version 2 evidence is retained and queryable in MongoDB. No arbitrary field in an observation is projected into accepted state. Unknown canonical patch keys and unsupported form versions cause rejection. Historical definitions remain readable after intake support is disabled.

### Resource limits

The initial limits are 100 items per batch, 256 KiB per submission, a 5 MiB batch body, and 20 optional observations per item. These are project safeguards, not measured capacity claims. Requests exceeding transport limits fail before processing. Every item in a valid batch receives its own outcome identifier or validation error.

## 6 Roles and user workflows

| Action | Surveyor | Reviewer |
|---|---|---|
| Read accepted records and download snapshots | Yes | Yes |
| Create, read, edit, or delete own unsubmitted draft | Yes | No |
| Finalize/upload own proposals | Yes | No |
| Inspect own submission evidence and outcomes | Yes | Yes, all submissions |
| Resolve pending changes or supply replacement values | No | Yes |
| Read accepted version history and value provenance | Yes | Yes |
| Read all conflict queues and source-document aggregates | No | Yes |
| Edit sealed evidence, accepted history, or previous decisions | No | No |

Reviewer replacements must originate from a pending change; unrestricted direct editing of accepted records is not part of the MVP. Demo accounts are seeded. Self-registration and account-management screens are excluded.

### Surveyor workflow

1. Sign in and select an active tree.
2. Download or open its accepted snapshot with record ID and base version.
3. Prepare a draft, explicitly selecting the fields to propose. Unselected fields are omitted.
4. Finalize the draft or upload its envelope later, using a stable client submission ID.
5. Inspect the receipt, field outcomes, and any pending review. Finalized evidence cannot be edited; a correction is a separate submission against an accepted version.

### Reviewer workflow

1. Open a pending-change queue filtered by tree, field, author, or receipt date.
2. Inspect base, current, and proposed values with versions, observation times, and evidence.
3. Choose accept proposal, keep current, or replace with another valid value. Enter a nonblank reason of at most 2000 characters.
4. Submit the current record version and pending change revision seen on screen.
5. If either has changed, refresh and reconsider. The server never silently rebases a stale approval.
6. Inspect the saved decision, any new accepted version, and remaining pending proposals.

In the MVP, a decision resolves one pending field at a time. It does not implicitly dispose of other proposals on the same field, even if their desired value now matches the accepted value. Those proposals remain visible until explicitly processed.

## 7 Deterministic reconciliation rules

Processing validates the complete submission first. An invalid field rejects the whole item before any of its fields publish. A valid item is then classified per field against a single current snapshot while holding the target record's publication lock.

For each included field, let B be its normalized base value, C its current accepted value, and P its normalized proposed value. Equality is typed and null-aware: null equals null; numeric zero is not false; strings never equal numbers. Let H mean the field actually changed in any accepted version after the base version, even if it later returned to B.

Evaluate in the following order:

| Rule | Condition | Outcome | Publication effect |
|---|---|---|---|
| M01 | Field omitted | No proposal | Preserve C. |
| M02 | P equals B | No change intended | Preserve C, including a newer value different from B. |
| M03 | P differs from B and P equals C | Already represented | Preserve C; record the outcome without transferring provenance. |
| M04 | P differs from B, P differs from C, H is false, and C equals B | Compatible | Apply P after full snapshot validation. |
| M05 | P differs from B, P differs from C, and H is true | Conflict | Preserve C and create a pending review item. |
| M06 | H is false but C differs from B | History inconsistency | Abort publication and surface an integrity error; never assume compatibility. |

H tracks accepted value changes, not merely submissions or reviewer activity that kept the existing value. For example, B=30, then accepted values 32 and 30, followed by P=36 is a conflict. The equality C=B alone is insufficient because a newer accepted decision would otherwise be silently overwritten.

### Compatible and pending fields in one item

All compatible fields in the item publish together as one new snapshot. Conflicting fields retain their current values and remain pending. No version is created if no accepted value changes. The published snapshot must satisfy field constraints. The initial four fields have no additional cross-field dependency rule; an undefined coupled-conflict state is not implemented.

### Observation and clock handling

The campaign fixes the meaning of the published record. Differing observation timestamps remain evidence and do not change M01–M06. A timestamp more than five minutes ahead of server receipt time produces a clock warning and sends actual proposed changes to review rather than automatic publication. Timestamps later than the permitted campaign window also require review. Timestamps before the campaign start are rejected. The campaign window is seeded configuration displayed to users.

No-change and already-represented fields still produce no new accepted version, even when timestamps are flagged. An evidence-only valid submission is retained with a no_change accepted-state outcome and its warnings displayed.

## 8 Versioning and reviewer decisions

- Every imported tree starts at version 1. Versions are immutable and numbered consecutively per record, under a record-level database lock.
- One version represents one publication transaction. It may apply several independent fields from one submission. A subsequent reviewer decision may produce another version from that submission.
- A version stores its parent, creation time, publication actor, and origin. Fields carried forward retain their original per-field provenance. The latest version creator is not automatically the author of every value in that snapshot.
- Each change and decision records the version it compared against. Publication and review re-read the latest state inside their transaction.
- A reviewer accepting P or choosing a replacement creates a version only if the accepted value changes. Keeping C or selecting the same value closes the pending item without a new version.
- Only the first valid terminal disposition of a pending item takes effect. Stale or repeated reviewer actions cannot reopen or duplicate that disposition.
- Every review request also has a reviewer-scoped idempotency key. Identical retries return the existing decision; changed content using that key is rejected. Concurrent decisions with different keys still cannot resolve the same pending revision twice.

The ER model must represent field provenance and version transitions sufficiently to answer H and identify the true origin of unchanged values. A single origin_submission_id on a whole snapshot is insufficient by itself.

## 9 Idempotent and recoverable intake

The identity of a finalized request is (authenticated author, client_submission_id). Its fingerprint covers all submitted content, including evidence and client metadata, after a defined deterministic JSON encoding. Object-key order and insignificant whitespace do not change the fingerprint; array order does. The encoder must define stable decimal representation. Server receipt times, processing state, and transport batch IDs are excluded.

| Condition | Required behavior |
|---|---|
| New valid request identity | Reserve SQL intake and proceed with evidence storage. |
| Same identity and matching fingerprint | Resume incomplete work or return the existing receipt/outcome. |
| Same identity and different fingerprint | Return an idempotency conflict; preserve the original request. |
| Malformed envelope before identity can be validated | Return validation errors; no accepted-state mutation. |

Recovery sequence:

1. Reserve SQL intake with unique request identity, source fingerprint, and awaiting_document state.
2. Insert the sealed MongoDB source document under submission_id using an idempotent operation.
3. Verify the stored document identity and fingerprint, then advance SQL to ready.
4. Claim the ready item, lock its target record, re-read current state, classify, and commit snapshots, field outcomes, receipt state, and audit events in one SQL transaction.

A document-write failure leaves visible incomplete intake. A crash after a successful document write is recovered by verification. A crash during SQL publication rolls back that transaction; retrying cannot apply it twice. A committed transaction whose response was lost returns its committed result on retry. The processing claim is released or recovered after a bounded lease; no permanent processing state may depend on an abandoned browser request.

No cross-database transaction is claimed. Publication cannot proceed without verified source evidence. A source/hash mismatch is quarantined as an integrity error for operational recovery and is never silently replaced. Accepted state remains available during a MongoDB outage, but new intake requiring document access cannot publish.

## 10 State model

Draft lifecycle is separate from finalized submission lifecycle: editable draft → finalized, or editable draft → deleted. Only drafts can be physically deleted through ordinary user workflows.

| Submission state | Meaning and allowed progression |
|---|---|
| awaiting_document | SQL identity reserved; source not yet verified. Advance to ready after verification. |
| ready | Source verified and awaiting processing. Advance to processing. |
| processing | Worker has a bounded claim. Transaction commits an outcome; failure or expired claim permits recovery. |
| needs_review | Initial processing created pending changes with no accepted change. Review may leave it here, make it partially_applied, or finish it as resolved. |
| partially_applied | At least one field has applied and at least one remains pending. Review can remain partial or finish as resolved. |
| applied | Initial processing completed with accepted changes and no pending fields. Terminal. |
| no_change | Initial processing completed without accepted changes or pending fields. Terminal. |
| resolved | All pending fields have received a disposition. Terminal; inspect per-field outcomes to see applied versus rejected proposals. |
| rejected | Submission fails validation; no field from that item published. Terminal. |

Record rejected pre-intake validation attempts separately when needed; not every malformed upload can have a submission row. Operational failures are retryable error metadata on an incomplete intake/claim, not falsely reported as a successful terminal result.

Per-field outcome is pending, applied, rejected, no_change, or already_represented. Classification and disposition are separate: a conflicting proposal may later have an applied disposition. A decision that keeps current rejects the pending proposal without labeling the entire submission as invalid.

## 11 Security and integrity requirements

- Hash passwords using an appropriate password library; keep session and database secrets in server configuration. Do not expose database credentials to the browser.
- Check authentication, active-account status, role, and draft ownership on every protected server operation. Client-provided identity cannot authorize a request.
- Use parameterized SQL and controlled document queries. Validate types both at intake and within protected SQL publication paths.
- Deny application roles direct updates/deletes to accepted snapshots, sealed evidence, previous decisions, and audit events. Use role-aware database entry points and access policies; test bypass attempts with the application database credentials.
- Establish database actor context only from the server-verified session within the request transaction. A browser cannot issue SQL or set that context directly. Backend compromise and administrator tampering are outside the threat model.
- Retain original evidence and append corrections. Immutable history means protected from ordinary application mutation, not cryptographically immune to an administrator.
- Audit intake, processing, publication, rejection, and reviewer decisions with actor, server time, record/submission identifiers, and version references. Do not log passwords, session tokens, or database secrets.

## 12 Required screens and outputs

1. Login and role-aware navigation.
2. Accepted records list with record/species/health filters and snapshot download.
3. Own draft editor and delayed batch upload with per-item receipts.
4. Submission detail showing evidence, classifications, per-field outcomes, and warnings.
5. Reviewer queue and base/current/proposed comparison with decision form.
6. Version history and per-field provenance view.
7. Reviewer summary and export: accepted SQL records, pending/resolved SQL workflow totals, and MongoDB form/batch evidence aggregates.

Document read/update/delete demonstrations use source-document retrieval, owner-scoped draft edits/deletion, and permitted draft cleanup. Final evidence is not erased to demonstrate DELETE. MongoDB aggregations group submissions by form version and batch, and summarize repeated observation categories and completeness. SQL remains the source for accepted-state and conflict-resolution totals.

## 13 Acceptance scenarios

Unless stated otherwise, the tree is active, the base exists, the envelope is valid, the clock is unflagged, and the author has surveyor access. Each scenario resets to its stated fixture. These are expected outcomes, not executed test results.

| ID | Input or event | Expected outcome |
|---|---|---|
| AC01 | B diameter=30, C=30, P=32; no intervening edit | Publish 32 in one new version. |
| AC02 | A changes diameter; B changes health from their shared base | Both survive; B does not revert A's diameter. |
| AC03 | B diameter=30, C=32, P=36 | Pending conflict; C remains 32. |
| AC04 | B=30, C=32, P=32 | Already represented; no new version and no provenance reassignment. |
| AC05 | B=30, C=32, P=30 | No change intended; C remains 32. |
| AC06 | B=30; accepted history 32 then 30; P=36 | Pending conflict despite current equaling base. |
| AC07 | Diameter omitted while health changes | Diameter untouched. |
| AC08 | B guard_damage=true, C=true, P=null | Compatible explicit clear; accepted value becomes unknown. |
| AC09 | P guard_damage="false" | Reject entire item; string is not boolean. |
| AC10 | P diameter=0 | Valid numeric proposal; never converted to null. |
| AC11 | Patch contains one valid field and one negative diameter | Reject item before publishing either field. |
| AC12 | Diameter conflicts; health is independently compatible | Publish health once; diameter pending; state partially_applied. |
| AC13 | Missing base, unknown patch key, or unsupported form | Reject with field-specific error and no publication. |
| AC14 | Same finalized request uploaded three times | One source submission and one set of effects; prior receipt returned. |
| AC15 | Same request identity with a different patch or evidence | Idempotency conflict; original unchanged. |
| AC16 | Two compatible same-field requests race against one base | Serialize publication; after first commit, second is reclassified against current state. |
| AC17 | Reviewer submits against an old current version | Reject stale approval, refresh comparison; no silent rebase. |
| AC18 | Reviewer keeps current with a reason | Close that pending proposal; no accepted version created. |
| AC19 | Reviewer accepts proposal with valid current version | One atomic decision, applied field, new snapshot, and audit trail. |
| AC20 | Two reviewers resolve the same pending revision | At most one terminal disposition; other receives stale/already-resolved result. |
| AC21 | Identical reviewer request retried after lost response | Same saved decision returned; no duplicate version or decision. |
| AC22 | MongoDB fails before source document is stored | Visible awaiting_document intake; no publication; retry can resume. |
| AC23 | Crash after document insert but before ready | Recovery verifies existing source and completes intake once. |
| AC24 | Crash inside publication or response lost after commit | Rollback and safe retry, or return committed outcome; never double application. |
| AC25 | Surveyor attempts a reviewer action or another user's draft | Denied in server workflow and protected database operation as applicable. |
| AC26 | Application account attempts to rewrite accepted history | Denied; previous snapshot and audit history intact. |
| AC27 | V2 source includes two optional observations | Evidence retained and counted in document aggregates; no implicit scalar overwrite. |
| AC28 | Two source observations have different timestamps and values | Preserve both; no automatic latest-time truth rule. |
| AC29 | Proposed changes have timestamp 10 minutes ahead of receipt | Clock warning; actual changes held for reviewer rather than auto-published. |
| AC30 | One invalid and one valid item in a permitted batch | Independent error/receipt; valid item processed once. |
| AC31 | New snapshot changes only health | Species/diameter/guard provenance retains prior source, not latest publisher. |
| AC32 | Evidence-only valid submission with no patch changes | Evidence stored; no_change outcome and no new accepted version. |
| AC33 | Two controlled forms submit the same supported patch | Same canonical merge behavior; original document structure remains inspectable. |
| AC34 | Identical baseline import rerun after user updates | No duplicate identities and no overwrite of accepted user changes. |
| AC35 | Base/current value difference has no corresponding history | Integrity error; no automatic publication. |

## 14 Completion criteria and schema implications

Requirements are ready for ER modeling when every proposed mutation has a role, validation rule, state transition, provenance effect, and acceptance scenario. This baseline supplies those decisions. Changes made later must identify the affected requirements and scenarios rather than silently changing behavior.

The ER diagram must represent users, dataset/campaign context, tree identities, accepted versions, form registry, source-submission references, proposed field changes, reviewer decisions, and audit events. It must also represent per-field provenance or an equivalent reconstructible history, request uniqueness, decision idempotency, and references to existing base versions. Physical tables and indexes are decided in the next step.

All deterministic scenarios must pass before declaring the reconciliation workflow complete. Security bypasses, races, and interrupted intake require real integration tests in addition to pure merge-rule tests. The browser demonstration must cover both roles, a compatible merge, a conflict resolution, a retry, and a failed unauthorized action.

Performance results must report the tested dataset size, batch size, machine, and measurement method. No fixed response-time or production-scale claim is made before measurement. Version history and document aggregates should be demonstrated on reproducible seeded records.
