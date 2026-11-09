# FieldMerge MongoDB document model

Version 1.0 · 2 November 2026

## 1 Ownership and representation

This document completes the document-database portion of the logical design. It follows [the requirements](FieldMerge_Requirements.md) and accompanies [the relational schema](FieldMerge_Relational_Schema.md). Collection validators, indexes, service roles, seeds, and live structural checks are now implemented under database/mongodb and tests/database. Authentication of end users, owner/state enforcement in draft API operations, fingerprint recomputation, and cross-store intake recovery remain for backend implementation; collection validators alone do not provide these guarantees.

PostgreSQL owns publication and reviewer outcomes. MongoDB owns source envelopes, immutable form definitions, and editable drafts. Never copy SQL state into a MongoDB document and then treat that copy as authoritative.

Use canonical lowercase UUID strings for logical identifiers in MongoDB, mapped to PostgreSQL uuid columns at the server boundary. This project choice avoids UUID binary-subtype inconsistencies between clients. Store persisted timestamps as BSON dates and diameter values as Decimal128, not binary floating-point values. JSON wire envelopes use timestamps with explicit offsets and numeric diameter literals; the server validates their precision before BSON conversion.

JSON examples below show wire-shaped values for readability. They are not BSON dumps, executable validators, real observations, or already verified SQL references.

## 2 submission_documents

One sealed source envelope per finalized SQL submission. Its _id is the same logical identifier as submissions.submission_id. Source metadata is assigned by the server; original client content is preserved under payload.

```json
{
  "_id": "80000000-0000-4000-8000-000000000001",
  "author_id": "10000000-0000-4000-8000-000000000001",
  "client_submission_id": "70000000-0000-4000-8000-000000000001",
  "record_id": "30000000-0000-4000-8000-000000000001",
  "form_version": "tree-v2",
  "batch_id": "60000000-0000-4000-8000-000000000001",
  "received_at": "2026-11-02T10:05:00Z",
  "payload_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "payload": {
    "client_submission_id": "70000000-0000-4000-8000-000000000001",
    "record_id": "30000000-0000-4000-8000-000000000001",
    "base_version_no": 5,
    "form_version": "tree-v2",
    "observed_at": "2026-11-02T09:30:00Z",
    "patch": {"diameter_cm": 32.25, "guard_damage": null},
    "observations": [
      {"category": "guard", "note": "Guard condition could not be assessed.", "observed_at": "2026-11-02T09:30:00Z"}
    ],
    "client_metadata": {"app_version": "demo-v1"}
  }
}
```

The illustrative hash is a placeholder value, not the calculated hash of this example. A real intake computes it from canonical client content. Derived top-level lookup fields must agree with payload fields and the authenticated author/SQL intake. No merge trusts them without server verification.

### Validation contract

- Require _id, author_id, client_submission_id, record_id, form_version, received_at, payload_hash, and payload. batch_id is optional/null because it is transport grouping.
- Validate canonical UUID strings and lowercase 64-character hexadecimal hashes. A valid-looking hash does not prove content integrity; recomputation and identity matching are required.
- Reject unknown top-level server-envelope fields. Do not accept a client-supplied author_id as authentication evidence.
- Require a positive base_version_no and well-formed timestamps in payload. Validate actual base existence, active tree, campaign window, and registered form in the SQL/server boundary.
- Allow only species, health, diameter_cm, and guard_damage inside patch. Each property is optional; present null means explicit unknown, and absent means no proposal.
- Species is normalized only in its SQL comparison projection; preserve the original submitted string as evidence. Enforce length/type on source input and normalization/domain limits before publication.
- Validate health enumeration, boolean guard_damage, and exact decimal diameter range/precision. MongoDB numeric validation must allow Decimal128 rather than requiring double.
- tree-v1 rejects observations. tree-v2 permits at most 20 repeated observation objects with allowed category, trimmed nonempty note up to 500 characters, and timestamp.
- Require at least one patch property or one observation. Enforce total byte limits on the incoming wire body before BSON conversion, not by measuring a differently encoded document afterward.
- BSON date conversion must not silently change logical identity: source timestamp spellings used for fingerprinting need reproducibility as described below.

### Fingerprint and original representation

Persist a canonical client-envelope string as an additional required field, canonical_payload_json, in the actual stored collection. The example omits its long duplicate string for readability. It preserves the deterministic, parseable logical source representation used for hashing even after BSON date/decimal conversion. It is not a raw HTTP byte log.

The canonicalizer sorts object keys, preserves array order and exact string contents, removes JSON whitespace, rejects duplicate object keys and nonfinite numbers, and uses a single deterministic decimal representation. It does not normalize species labels or apply business corrections before fingerprinting. Server author identity scopes the retry key; payload_hash covers all client content, excluding transport batch grouping and server metadata. The implementation must use the same canonicalizer for retries and recovery, and test decimal and timestamp cases explicitly.

Published source envelopes are insert/read-only for the intake and reviewer services. Recovery may verify an existing document but cannot replace it with different content. Hash conflicts are quarantined. New corrections use a new client request identity.

### Index plan

| Index | Purpose |
|---|---|
| _id unique | One logical source document per SQL submission. |
| (author_id, client_submission_id) unique | Extra protection against duplicate logical requests. |
| (record_id, received_at) | Inspect source evidence for a tree over time. |
| (form_version, received_at) | Form-specific counts and queries. |
| (batch_id, received_at) | Per-batch evidence inspection and summaries. |

No TTL index applies to sealed source evidence.

## 3 form_definitions

One published, immutable definition per registered form version. _id corresponds to form_versions.definition_id. The MongoDB definition schema itself is controlled; it is not an unrestricted dynamic-form builder.

```json
{
  "_id": "50000000-0000-4000-8000-000000000002",
  "form_version": "tree-v2",
  "schema_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "published_at": "2026-11-02T08:00:00Z",
  "canonical_fields": [
    {"name": "species", "type": "string", "nullable": true, "max_length": 120},
    {"name": "health", "type": "enum", "nullable": true, "values": ["Good", "Fair", "Poor"]},
    {"name": "diameter_cm", "type": "decimal", "nullable": true, "unit": "cm", "scale": 2},
    {"name": "guard_damage", "type": "boolean", "nullable": true}
  ],
  "optional_sections": {
    "observations": {"max_items": 20, "categories": ["guard", "trunk", "root", "branch", "other"], "max_note_length": 500}
  }
}
```

The schema hash shown is illustrative. Compute the real hash over the stable definition body, excluding its own hash and server publication metadata. Store that same hash in SQL. Validators still enforce the complete fixed requirements, including diameter bounds; the shortened example's metadata is not itself the entire executable validator.

Unique indexes: _id and form_version. New definition content requires a new form version. SQL is_supported controls new intake; existing definition documents remain readable.

## 4 submission_drafts

Drafts are owner-scoped editable documents and the normal target for MongoDB update/delete demonstrations. They do not participate in accepted-version history until finalized.

```json
{
  "_id": "90000000-0000-4000-8000-000000000001",
  "owner_id": "10000000-0000-4000-8000-000000000001",
  "client_submission_id": "70000000-0000-4000-8000-000000000002",
  "record_id": "30000000-0000-4000-8000-000000000001",
  "base_version_no": 5,
  "form_version": "tree-v1",
  "revision_no": 1,
  "state": "editable",
  "payload": {"patch": {"health": "Fair"}},
  "created_at": "2026-11-02T09:00:00Z",
  "updated_at": "2026-11-02T09:10:00Z",
  "final_submission_id": null
}
```

Partial data is allowed while editable. Finalization performs full envelope validation; a partially completed draft is not a valid final submission by itself. The server creates or preserves a stable request identity for finalization, locks the draft with an atomic revision-checked update to state finalizing, and invokes ordinary idempotent SQL/document intake. Do not let edits change the body of a finalizing request under the same identity.

On successful intake, set finalized and final_submission_id. If a response or intermediate step fails, retry the same sealed finalizing content. If validation fails before any intake reservation, return the draft to editable and explicitly start a new finalization identity after an edit. Once a SQL identity has been reserved, changing its content is prohibited; edits must become a separate request. Finalized draft metadata may remain for navigation, but final source evidence lives in submission_documents.

Owners may update/delete only editable drafts. A finalizing draft cannot be deleted during recovery. Reviewers may inspect a finalized source submission but have no general access to another user's unfinished draft. There is no public database connection from the browser; owner and state filters are server-enforced and collection credentials are restricted.

Unique indexes: _id; (owner_id, client_submission_id). Add (owner_id, state, updated_at) for the user's draft list. Each edit supplies expected revision_no; a stale edit is rejected rather than replacing another browser session's draft.

## 5 Cross-store integrity and meaningful operations

The SQL intake row is reserved first. MongoDB receives an insert-once source under that reserved ID. Verification checks authenticated identity, request key, record, base, form, canonical hash, and canonical payload before SQL can enter ready state. An orphan/mismatch is operationally visible; it is not automatically repaired by overwriting evidence.

Use server-controlled validators with invalid-write rejection for the three collections. MongoDB supports field type/range validation and rejecting invalid inserts/updates [1]. That does not create a foreign key to PostgreSQL or enforce server authentication by itself.

Read: source comparison, versioned form retrieval, owner draft lists. Update: revision-safe edits to editable drafts. Delete: owner deletion of editable drafts; never sealed evidence. Aggregation: source counts by form/batch, observation categories, and percentage with optional observations. Exclude missing/null batch IDs when reporting named batch totals, or label the no-batch group explicitly. Accepted/remaining-conflict totals are queried from SQL rather than guessed from source contents.

## 6 Verification required at implementation

1. tree-v1 and tree-v2 validators reject unknown patch fields and invalid scalar types.
2. Missing patch field, JSON null, zero, and false remain distinct after wire/BSON/SQL conversion.
3. Semantically identical object-key order/whitespace retries fingerprint identically; changed strings/evidence fingerprint differently.
4. Decimal conversion and canonical timestamp content are reproducible during restart/recovery.
5. Duplicate source IDs/request keys cannot produce a second source or overwrite the first.
6. A source/SQL identity mismatch cannot publish.
7. Draft editing/deletion respects owner, state, and expected revision.
8. A crash during draft finalization resumes the same content/identity rather than allowing an edited retry.
9. Source/form mutation is denied for ordinary service workflows after sealing/publication.
10. Aggregation totals match an independently counted fixture, including evidence-only and no-batch submissions.

## 7 Technical reference

[1] [MongoDB schema validation](https://www.mongodb.com/docs/manual/core/schema-validation/), consulted 2 November 2026. FieldMerge's collection boundaries, fingerprinting protocol, and recovery behavior are project design choices.
