# FieldMerge Implementation Report

Conflict safe reconciliation of delayed urban tree survey updates

DBMS Level 3 project | Solo implementation | 12 November 2026

Implementation baseline 7588773 on codex/security-boundaries. PostgreSQL migrations 001 through 010 and the matching MongoDB model are implemented. The report documents the working local system, its design and the limits of its recorded evidence.

## Project summary

FieldMerge preserves a shared accepted tree record when different surveys arrive from older versions. It publishes compatible scalar changes, holds competing proposals for review, and retains the source evidence and value origins needed to explain each outcome. A reviewer resolves pending fields using explicit version and revision checks.

## Problem statement

Surveyors revisiting the same urban trees can prepare observations from different copies of a record and upload them later. If receipt order decides the accepted value, a delayed proposal can overwrite a more recent accepted change even when the observer did not see it. Coordinators also need to distinguish harmless independent edits from competing values and to trace a chosen value to its source. FieldMerge solves this bounded data-reconciliation problem for identified trees by linking every proposal to an accepted base version, checking intervening field history, and requiring reasoned review before conflicting values are published.

## Objectives

- Preserve accepted changes when delayed proposals affect independent fields.
- Prevent changed-content retries and repeated uploads from producing duplicate effects.
- Retain sealed source evidence and field-level publication provenance.
- Make conflicting decisions explicit, authorized and atomic.
- Demonstrate relational integrity and meaningful document operations through a usable Next.js interface.

Verified baseline: 17 PostgreSQL tables, 146 columns, 29 foreign keys, four views and three MongoDB collections. All 35 functional acceptance scenarios pass. The complete physical dictionary is included in the appendix and in docs/FieldMerge_Data_Dictionary.md.

# Motivation and concrete scenario

ODK documents parallel entity updates prepared from older versions and an arrival-order update policy with conflict warnings [1]. This establishes a documented operational situation and a comparison point. Its form audit log also records who changed answers, when and why, supporting the usefulness of traceable evidence [2]. These sources do not establish the prevalence or financial cost of this problem for a particular municipal team.

A possible current workaround is to compare exported spreadsheets or review a version history after an overwrite. That is a project hypothesis, not an interview finding. The technical weakness of manual comparison is reproducible: the reviewer must reconstruct the base, current state and intervening edits before deciding whether an older proposal is compatible.

| Step | Accepted state or proposal | FieldMerge outcome |
|---|---|---|
| 1 | Version 1: health Good and diameter 30 cm. | Two surveyors prepare proposals from version 1. |
| 2 | Surveyor A submits diameter 31 cm. | Version 2 publishes diameter 31 cm. |
| 3 | Surveyor B submits health Fair and diameter 32 cm from version 1. | Health can publish while diameter stays pending. |
| 4 | Reviewer sees base 30, current 31 and proposed 32 cm. | A reasoned decision creates a new version only if the chosen value differs. |
| 5 | The same proposal or decision is retried unchanged. | The original receipt returns; no duplicate publication occurs. |

## Distinctive contribution

The contribution is the implemented combination of conservative field-history classification, partial publication, immutable evidence, reasoned review, exact retry identity and recoverable coordination between SQL and MongoDB. A change that was made and later reversed still counts as an intervening edit. Neither client timestamps nor upload order settle disputed truth.

Relative to the documented ODK arrival-order behavior, FieldMerge holds competing changed values before publication. This is a difference in the selected workflow, not a claim that conflict resolution is globally new or that existing products cannot support alternative policies. The project makes no first-ever or market-gap claim.

## Why the scope is viable

The prototype works with known record IDs and deterministic synthetic fixtures. It needs no private lab access, specialized hardware, paid service, machine-learning training or large user community. Synthetic data demonstrates correctness; it is not evidence of real-world demand.

# Scope roles and functional requirements

The MVP covers one configured campaign, two controlled form versions and four canonical scalar fields. Delayed upload is supported through saved drafts, exact snapshots and JSON batch files. A complete offline browser application is outside scope.

| Requirement | Implemented behavior |
|---|---|
| Authentication | Seeded surveyor/reviewer accounts; salted password hashes and revocable opaque sessions. |
| Accepted records | Bounded literal filtering, current/historical snapshots and downloads. |
| Drafts | Surveyor-owned create/read/revision-safe edit/delete while editable. |
| Finalization | Seal one draft revision and submit its unchanged identity/content. |
| Reconciliation | Validate the entire proposal; publish compatible fields and retain competing values. |
| Reviewer decisions | Accept proposal, keep current or replace; require reason and fresh version/revision tokens. |
| History and provenance | Inspect immutable snapshots and per-field source/decision origins. |
| Batches | Up to 100 independent positions with stable manifests and durable receipts/errors. |
| Reports and exports | SQL accepted-state summaries plus MongoDB evidence aggregates; bounded CSV/JSON exports. |
| Recovery and failure evidence | Bounded worker retries/quarantine and reviewer operational inspection; independent safe failure events. |

| Role | Permitted responsibility |
|---|---|
| Surveyor | Read accepted records; manage own editable drafts; submit/retry proposals; inspect own evidence and outcomes. |
| Reviewer | Read all source/outcome context, resolve pending fields, inspect summaries, recovery jobs and bounded failure events. |

Neither role may rewrite accepted history, sealed evidence or earlier decisions. Reviewers do not generally read other users' unfinished drafts. Self-registration, account-management screens, entity matching, maps, species diagnosis, AI adjudication, arbitrary nested merging and multiple organizations are excluded.

# System architecture and authentication flow

![Figure 1  Implemented server and database responsibilities](tmp/implementation-report/architecture.png)

Only the server connects to databases. It verifies an exact configured Origin on writes, bounds the incoming bytes, rejects malformed/ambiguous JSON, and authenticates the opaque cookie. PostgreSQL session-aware wrappers resolve the actor from the session hash; client-supplied author/reviewer identities cannot confer authority.

The API and worker have separate restricted SQL/MongoDB credentials in private environment configuration. The API has no direct SQL business-table access and cannot assume the non-login publication role. No PostgreSQL row-level security is claimed: denied table access and guarded functions are the chosen mechanism.

Source intake reserves an SQL identity, stores/verifies a sealed document, then publishes within a local SQL transaction. The separate worker resumes incomplete work. There is no distributed transaction or browser connection to either database. Successful local SQL commit does not imply that an HTTP response reached the user.

# Relational design and schema inventory

The conceptual business design has nine entities. ACCEPTED_VERSION is identified by its owner TREE_RECORD and the partial key version_no; the SQL primary key is (record_id, version_no). Campaigns contain records, users author submissions, submissions contain field changes, and a field change has at most one terminal decision. The completed Chen diagram is maintained separately.

| Schema | Relation | Responsibility |
|---|---|---|
| fieldmerge | app_users | User identities and application roles |
| fieldmerge | survey_campaigns | Campaign window and source attribution |
| fieldmerge | tree_records | Stable campaign-scoped tree identity |
| fieldmerge | accepted_versions | Immutable typed accepted snapshots |
| fieldmerge | form_versions | Registered immutable document forms |
| fieldmerge | submissions | Verified intake, retry identity and receipts |
| fieldmerge | field_changes | Per-field proposal and disposition |
| fieldmerge | review_decisions | Terminal reviewer intent and receipt |
| fieldmerge | audit_events | Committed business-workflow evidence |
| fieldmerge_auth | login_attempts | Authentication-attempt windows |
| fieldmerge_auth | sessions | Hashed opaque session references |
| fieldmerge_meta | migrations | Applied version/checksum registry |
| fieldmerge_ops | batch_items | Independent batch positions and outcomes |
| fieldmerge_ops | intake_batches | Owner-scoped manifest identity |
| fieldmerge_ops | recovery_events | Recovery activity history |
| fieldmerge_ops | recovery_jobs | Durable scheduling, leases and fencing |
| fieldmerge_ops | security_events | Independent safe HTTP failure evidence |

The physical implementation adds two authentication tables, five operational/transport tables and one migration registry. These support the application without changing the nine-entity business scope. Composite same-tree foreign keys and linear predecessor constraints protect version/decision origins. The appendix lists all 146 columns; the companion catalog contains all 239 constraints and complete definitions.

The 29 foreign keys are physical constraints, not 29 distinct Chen relationship types. A nullable origin reference permits the baseline. A deferred trigger requires every committed tree to have version 1; an ordinary child foreign key alone cannot enforce that participation rule.

# Data semantics and normalization

| Canonical field | Allowed representation | Meaning |
|---|---|---|
| species | Text up to 120 characters or null | Trim/collapse whitespace for comparison; no fuzzy matching or case inference. |
| health | Good, Fair, Poor or null | Controlled category, not a diagnosis. |
| diameter_cm | Exact numeric 0–999999.99 with at most two fractional digits, or null | Storage bound, not biological plausibility. Zero is known data. |
| guard_damage | Boolean or null | False is a known negative report. Null means unknown. |

An omitted patch field makes no proposal. Explicit JSON null requests an unknown value. Typed JSON scalar values in field_changes are never SQL NULL; an absent applied_version_no is SQL NULL because no snapshot applied that change. Unknown keys, string booleans and excess decimal precision are rejected.

## Keys and deliberate redundancy

Request identities are unique per authenticated author; decisions are unique per reviewer retry identity and terminal change. Version identity is composite within a tree. record_id is deliberately repeated on field_changes and review_decisions to support declarative same-tree composite foreign keys. These physical tables should not be advertised as strictly third normal form because the guard column is derivable through the parent. Removing it would require another enforcement mechanism.

Full immutable snapshots repeat carried values to make accepted reads straightforward. Publication records provenance only for actual changes, so carrying an unchanged field does not steal its source. Current values are not duplicated as mutable columns on tree_records.

## Executable dictionary

output/design/schema-catalog.json captures exact types, nullability, defaults, keys, constraints, indexes, views, explicit triggers, function signatures and MongoDB validators/indexes. It exports no application rows. docs/FieldMerge_Data_Dictionary.md adds a meaning for every column and complete constraint/index definitions. All ten applied migration checksums matched their source files at reconciliation.

The baseline has 43 indexes including constraint-supporting indexes, 26 explicit noninternal triggers and 60 functions including helpers. These object counts describe structure, not feature counts or performance guarantees.

# MongoDB model and database justification

| Collection | Responsibility | Permitted mutation |
|---|---|---|
| submission_documents | Sealed source envelope, canonical JSON, optional evidence and metadata. _id matches SQL submission_id. | Insert/read; no source rewrite or delete through ordinary service roles. |
| form_definitions | Immutable controlled form definitions agreeing with the SQL registry hash. | Read published definitions; a new definition requires a new version. |
| submission_drafts | Owner-scoped partial envelope, revision, lifecycle and final submission reference. | Create/read/edit/delete while editable; seal before finalization. |

PostgreSQL is appropriate for ordered accepted versions, same-record references, uniqueness, authorization and atomic publication. MongoDB is useful for retaining complete versioned source envelopes with optional repeated evidence and metadata, and for draft document operations and aggregation. It does not independently determine accepted truth.

## Source envelope

```
{
  "_id": "server submission UUID",
  "author_id": "authenticated author UUID",
  "record_id": "known tree UUID",
  "form_version": "tree-v2",
  "payload_hash": "canonical content SHA-256",
  "canonical_payload_json": "deterministic client envelope",
  "payload": {"patch": {"diameter_cm": 31.25},
              "observations": [{"category": "trunk",
                                "note": "Measurement context"}]}
}
```

This shortened illustration is not a valid executable input: required request/base/timestamp fields are omitted for readability. Actual validators use lowercase UUID strings, BSON dates and Decimal128. The canonical JSON retains exact numeric content and original timestamp spelling beyond BSON millisecond precision.

Indexes support unique author/request lookup, record/time and form/time reads, batch grouping, owner/state draft lists and finalizing-draft discovery. MongoDB aggregates group forms/batches, unwind observations and distinguish field presence from explicit null. SQL foreign keys cannot cross into MongoDB: the server verifies identity, canonical content and matching form hashes before publication.

# Automatic reconciliation and SQL integrity

The server validates the complete envelope before deriving the verified scalar projection. Reconciliation locks the tree identity row, rereads the current accepted snapshot and inspects actual field changes between the submitted base and current version. Classification and any publication occur within one SQL transaction.

| Condition for a supplied field | Disposition |
|---|---|
| Proposed value equals the base value | No-change proposal; do not revert a later current value. |
| Proposed value is already represented by current state | No extra publication and no provenance takeover. |
| No intervening accepted edit to the field | Compatible change, unless a clock/campaign warning holds it. |
| An intervening accepted edit conflicts with the proposal | Pending reviewer decision. |
| The field changed and then returned to its base value | Still treated as intervening history; equal endpoints alone are insufficient. |
| Any supplied scalar is invalid | Reject the item without partially publishing its otherwise valid fields. |

Compatible fields in a valid item publish together; competing fields remain pending in the same receipt. If no accepted scalar changes, no new version is created. Every accepted snapshot change must have the matching applying field-change link. Deferred consistency triggers check origins, decisions, receipts, live states and audit evidence at transaction completion.

## Retry identity

The authenticated author plus client_submission_id identifies a logical proposal. A deterministic canonicalizer sorts keys while preserving exact scalar/string/array content, rejects duplicate JSON keys, and fingerprints the client envelope. An unchanged retry returns the original reconciliation receipt. Changed content under the same identity fails, including changed supporting evidence or metadata. Transport batch identity is separate.

The SQL chain has a same-tree predecessor reference and predecessor arithmetic. Publication locks serialize next-version assignment. Immutable-history triggers and denied direct grants block ordinary rewrite/delete paths; they do not prevent a privileged database administrator from changing the system.

# Review recovery and safe failure evidence

## Reviewer publication

A reviewer supplies the pending change revision, accepted version, chosen action, nonempty reason and stable client decision identity. The protected function locks the record/change and checks the current context again. A stale action fails rather than silently rebasing. accept_proposal or replace creates a new version only when its chosen value differs; keep_current closes the change without inventing a version.

Decision receipt, field disposition, version, provenance and business audit evidence commit together. A repeated identical command returns its earlier receipt. There can be only one committed terminal decision for a proposed field.

## Recoverable two store coordination

Intake reserves the SQL identity before document insertion and verification. Recovery jobs persist independently of a browser session. Bounded claims, token fencing, retry scheduling and quarantine prevent an expired worker from committing as a later claimant. A worker discovers sealed finalizing drafts and resumes the same content. It cannot overwrite a conflicting sealed document or reinterpret it as a new request.

The design deliberately avoids two-phase commit. A temporary awaiting_document state can exist, and a committed result can outlive a lost response. Source identity/hash checks and unchanged retries make these states recoverable. The worker must run for unattended progress; it is not installed as a supervised service.

## Failure evidence and web boundary

Handled HTTP failures receive a server-generated X-Request-Id and an independent SQL event after business rollback. Reviewer reads are bounded to 1–100 events. When SQL logging fails, closed-field JSONL fallback files are appended and synced. Bodies, raw URLs/queries, emails, passwords, cookies, tokens, session hashes and raw exception messages are excluded.

Fallback allocation is capped at three 5 MiB segments per UTC day and process, with no overwrite. Total retention across days/restarts needs operator management. If both SQL and file persistence fail, a fixed diagnostic is emitted and the original denial still returns. Framework failures outside wrapped handlers and batch-item errors in HTTP 207 are outside this HTTP-failure logger; batch receipts retain their own item outcomes.

# Advanced database concepts and query demonstrations

| Concept | Implemented use or evidence |
|---|---|
| Transactions and row locks | Atomic accepted publication/review; real lock-controlled races. |
| Stored functions | reconcile_submission, review_change and restricted session-aware wrappers. |
| Triggers | Immutable history; deferred cross-relation integrity at commit. |
| Views | Latest accepted records, pending reviews, submission outcomes, field provenance. |
| CTEs and recursion | Pending workload aggregation and bounded version-parent traversal. |
| JOIN and correlated subquery | Author/current comparison and records with pending species proposals. |
| Window functions | LAG identifies intervening changes, including reversals. |
| Indexes and plans | SQL record/time history and MongoDB record/time evidence lookup. |
| NoSQL aggregation and RUD | Evidence forms/categories/presence; owner/state-aware draft read/update/delete. |

The executable SQL catalog contains Q01–Q12 and the MongoDB catalog contains M01–M04. This workload query combines a CTE, GROUP BY, HAVING, JOIN and ordering:

```
WITH workload AS (
  SELECT record_id, count(*) AS pending_fields
  FROM fieldmerge.field_changes WHERE state = 'pending'
  GROUP BY record_id HAVING count(*) > 1
)
SELECT r.source_record_id, w.pending_fields
FROM workload w
JOIN fieldmerge.tree_records r USING (record_id)
ORDER BY w.pending_fields DESC, r.record_id LIMIT 20;
```

Administrative inspection connections execute raw SQL demonstrations; the API login cannot directly read these tables. Meaningful INSERT/UPDATE/DELETE operates through guarded workflow transitions and editable MongoDB drafts. CREATE/ALTER/DROP and staging DML are demonstrated in a rolled-back disposable SQL sandbox, preserving immutable accepted history and sealed evidence.

# Verification results and practical limits

Recorded tests use real PostgreSQL/MongoDB and a production Next.js server where applicable. Synthetic fixtures and disposable fault injection are separated from development business records. The counts below belong to distinct suites and are not additive guarantees.

| Suite | Recorded outcome | Evidence directory |
|---|---|---|
| Database structure and workflows | 231 assertions; four actual COMMIT cases; six concurrent SQL scenarios; matching forms | output/database |
| Validation export and logging units | 18 passing groups | Tests run with pnpm test:unit |
| API worker and query integration | 33 passing groups | output/api |
| Functional acceptance | All AC01–AC35 pass; disposable cleanup completed | output/acceptance |
| Interface | 15 browser workflows; nine representative axe checks; no recorded runtime errors | output/browser |
| Transport and security | 23 API groups plus five browser checks pass | output/security |
| Query and performance evidence | 21 checks pass on a larger synthetic fixture | output/performance |
| Design reconciliation | 17 tables / 146 column meanings; ten applied migration checksums match | output/design |

## Representative fault checks

Coverage includes concurrent proposals/reviewers, SQL rollback, lost successful responses, an actual MongoDB service pause, worker process kill/restart, stale/expired claims, wrong-role/owner denial, changed-content retries, exact transport caps, invalid UTF-8/duplicate keys and stored markup rendered as text.

Testing found and corrected valid maximum-diameter rejection caused by double-valued MongoDB bounds, recursive parser stack exhaustion on excessive nesting, inconsistent empty-body classification, and acceptance error distinctions for missing bases and unknown patch fields.

The production build passed. Source-checksum manifests identify selected tested files and all migrations; they are not signed attestations. Tests are targeted rather than exhaustive. Automated accessibility scans are representative. No production deployment, disaster recovery, disk-loss durability, multi-node partition or hostile-administrator guarantee is claimed.

# Measured query behavior

The saved warmed local benchmark used 10,003 synthetic accepted records, 14,308 immutable snapshots and 4,504 matching SQL/MongoDB sources. It also contains 12,006 field changes, 3,599 pending fields, 402 decisions and 5,501 supporting observations. The generated history used normal guarded workflow functions.

| Read comparison | Client median | Inspection evidence |
|---|---|---|
| SQL Q03 with record/receipt index | 0.932 ms | 5 root shared buffer hits plus reads; one server EXPLAIN 0.046 ms. |
| SQL Q03 with that index absent | 1.063 ms | 79 root shared buffer hits plus reads; one server EXPLAIN 0.163 ms. |
| MongoDB M01 forced natural scan | 2.975 ms | 4,504 documents examined for three returned references. |
| MongoDB M01 record/time index hint | 1.414 ms | Three documents and three keys examined for the same references. |

Each normal read had two warm-ups and nine measured executions from one client. SQL statistics were refreshed; scan alternatives were interleaved and restored in the disposable databases. Query plans, parameters, raw samples, versions and settings are saved, enabling inspection beyond elapsed time.

The host was Windows 11 with an i5-13450HX and 23.7 GiB usable memory; Docker reported 11.5 GiB. The measured databases were PostgreSQL 18.6 and MongoDB 8.0.34. Times include driver/loopback overhead; one EXPLAIN sample is not a client median. With nine samples, the descriptive nearest-rank p95 equals the maximum and is not a reliable production tail estimate.

The smaller SQL client-time difference is not evidence of a large website speedup. The narrower plan and reduced examined work provide a more direct explanation. Full-collection MongoDB aggregates are not claimed to benefit from a point-lookup index. These measurements exclude HTTP/browser concurrency and the later independent HTTP failure logger.

Reproduce with pnpm db:evidence followed by pnpm db:evidence:summary. The benchmark uses a separate temporary Compose project and does not modify development business data. The complete report is output/performance/README.md; query/viva explanations are in docs/FieldMerge_Query_Demonstrations.md.

# Application screenshots

![Figure 2  Surveyor draft detail showing explicit field intent](output/browser/draft.png)

![Figure 3  Reviewer comparison and reasoned decision detail](output/browser/review.png)

These are screenshots from the passing browser workflow suite with synthetic records. Browser tests also inspect actual SQL/MongoDB outcomes, lost-response retries, stale actions, exports, keyboard access and a 390 px mobile layout. Screenshots illustrate the interface; assertions establish the tested behavior.

# Execution and demonstration

Use Windows PowerShell, Node.js 22 or later, pnpm 11 and Docker Desktop with Linux containers. The repository pins the tested database image digests. From the project folder:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\database.ps1 Setup
pnpm install --frozen-lockfile
pnpm configure:backend
pnpm dev
```

Open http://localhost:3000, matching APP_ORIGIN. Open tmp/database-fixtures/demo-accounts.json privately for generated surveyor/reviewer logins. Keep the fixture file when preserving existing development volumes: regenerating it does not rotate stored account hashes. Never include it or .env in submission materials.

Run pnpm worker in a separate terminal for unattended recovery. Use private/incognito browser contexts for separate roles. Setup verifies isolated test databases and applies ordered checksum-protected migrations without resetting existing records. Restart API/worker processes after code changes.

## Core demonstration sequence

- Open a tree and prepare two drafts from the same base. Finalize a diameter-only change first.
- Finalize the older-base draft with a different diameter and a health change. Show compatible health publication and pending diameter.
- As reviewer, compare base/current/proposed values, enter a reason and resolve the pending field.
- Show version history and field provenance; replay an unchanged upload and demonstrate no extra version.
- Show a denied wrong-role request and its server correlation event; inspect a source document and independent evidence aggregate.

The companion demonstration guide gives repeatability preconditions and evidence checkpoints. Development fixtures have three baseline records; larger examples use the disposable performance fixture. A clean-room release rehearsal, instructor format/deadline confirmation, and the actual demonstration/viva remain separate tasks.

# Limitations contribution and conclusion

## Known limitations

- No technician interviews, municipal pilot or user study establishes local adoption or operational savings. Motivation is supported by public product documentation and a reproducible data problem.
- One campaign, four scalars and two controlled forms bound the model. A complete offline app, entity matching, maps and biological assessment are excluded.
- There is no distributed atomic commit. Temporary cross-store incompleteness is visible and recoverable through the running worker.
- Local configuration is demonstrated. Hosted HTTPS, CSP/HSTS, service supervision, backups and restore rehearsal require separate operational work.
- Targeted tests and local warmed query plans do not establish exhaustive security, complete accessibility or production capacity.

## Solo contribution and provenance

The single-developer project scope includes problem definition, database design/migrations, authenticated API, Next.js workflows, recovery, query analysis, tests and documentation. Git records the progression from the database baseline through interface, acceptance, performance and security milestones. Attribution should describe the actual tooling and assistance used; commit history alone does not certify independent authorship or instructor approval of the solo arrangement.

## Conclusion and future enhancements

The implemented system demonstrates that delayed proposals can preserve independent accepted changes while holding disputed fields for an explicit decision. Databases enforce identity, history, atomicity and review context, while source documents retain optional evidence. A useful next extension is a documented public-data import mapping, followed by supervised worker deployment, backup/restore verification and user evaluation. These enhancements should preserve the existing provenance and retry guarantees.

## Public references

[1] ODK Documentation. Managing Entities in Central, sections on parallel updates and conflicts. https://docs.getodk.org/central-entities/ (consulted 12 November 2026).

[2] ODK Documentation. Form Audit Log. https://docs.getodk.org/form-audit-log/ (consulted 12 November 2026).

Implementation references: ordered SQL migrations, database/mongodb/model.js, the complete schema catalog/dictionary, and the recorded acceptance, browser, security and performance artifacts identified in this report. The conceptual ER diagram is a separate project deliverable.

# Appendix 1 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge.app_users

User identities and application roles.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| user_id | uuid | N PK | Application user identity. |
| email | text | N UQ | Normalized login address. |
| password_hash | text | N | Salted scrypt password hash, never a plaintext application password. |
| display_name | varchar(120) | N | Display label. |
| role | text | N | Application role: surveyor or reviewer. |
| is_active | boolean | N | Whether new guarded use of this identity is allowed. |
| created_at | timestamptz | N | Server creation time. |

UNIQUE (email).

PRIMARY KEY (user_id).

## fieldmerge.survey_campaigns

Campaign window and source attribution.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| campaign_id | uuid | N PK | Campaign identity. |
| name | varchar(160) | N | Campaign display name. |
| starts_at | timestamptz | N | Campaign reference-window start. |
| ends_at | timestamptz | N | Campaign reference-window end. |
| source_dataset_id | text | N | Attributed source dataset identifier. |
| source_url | text | N | Source attribution URL. |
| import_mapping_version | text | N | Version of deterministic baseline source mapping. |
| created_at | timestamptz | N | Server creation time. |

PRIMARY KEY (campaign_id).

# Appendix 2 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge.tree_records

Stable campaign-scoped tree identity.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| record_id | uuid | N UQ/PK | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| campaign_id | uuid | N FK/UQ | Campaign identity. |
| source_record_id | text | N UQ | External source identity, unique within campaign. |
| imported_at | timestamptz | N | Baseline import time. |
| is_active | boolean | N | Whether new guarded use of this identity is allowed. |
| created_at | timestamptz | N | Server creation time. |

UNIQUE (campaign_id, source_record_id).

PRIMARY KEY (record_id).

## fieldmerge.accepted_versions

Immutable typed accepted snapshots.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| record_id | uuid | N PK/FK | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| version_no | integer | N PK/FK | Accepted version number within the tree. |
| parent_version_no | integer | Y FK | Previous version of this same tree; null only for baseline. |
| species | varchar(120) | Y | Normalized accepted species label, or unknown. |
| health | text | Y | Good, Fair, Poor, or unknown. |
| diameter_cm | numeric | Y | Exact centimeters; 0–999999.99, at most two meaningful decimal places, or unknown. |
| guard_damage | boolean | Y | True, false, or unknown; omission is not a stored scalar. |
| origin_submission_id | uuid | Y FK | Verified submission responsible for a nonbaseline snapshot. |
| published_by | uuid | N FK | Responsible authenticated publisher identity. |
| created_at | timestamptz | N | Server creation time. |

PRIMARY KEY (record_id, version_no).

# Appendix 3 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge.form_versions

Registered immutable document forms.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| form_version | text | N PK | Controlled form version identifier. |
| definition_id | uuid | N UQ | Logical identifier of the MongoDB form definition. |
| schema_hash | text | N | SHA-256 fingerprint of the canonical published definition. |
| is_supported | boolean | N | Whether this immutable form version permits new intake. |
| published_at | timestamptz | N | Server publication time. |

UNIQUE (definition_id).

PRIMARY KEY (form_version).

## fieldmerge.audit_events

Committed business-workflow evidence.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| event_id | bigint | N PK | Event identity. |
| actor_id | uuid | Y FK | Responsible or identifiable actor when available. |
| record_id | uuid | Y FK | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| submission_id | uuid | Y FK | Source submission identity; logical MongoDB source _id. |
| event_type | text | N | Controlled activity kind. |
| event_data | jsonb | N | Structured event details governed by the write function. |
| created_at | timestamptz | N | Server creation time. |

PRIMARY KEY (event_id).

# Appendix 4 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge.submissions

Verified intake, retry identity and receipts.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| submission_id | uuid | N UQ/PK | Source submission identity; logical MongoDB source _id. |
| author_id | uuid | N UQ/FK | Authenticated author; never taken from client metadata. |
| client_submission_id | uuid | N UQ | Author-scoped retry identity. |
| record_id | uuid | N FK/UQ | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| base_version_no | integer | N FK | Existing accepted version used to prepare the proposal. |
| form_version | text | N FK | Controlled form version identifier. |
| payload_hash | text | N | Canonical source-content SHA-256. |
| batch_id | uuid | Y FK | Server transport batch identity; not logical source identity. |
| observed_at | timestamptz | N | Claimed observation time; does not select accepted truth. |
| received_at | timestamptz | N | Server receipt time. |
| state | text | N | Current workflow disposition; allowed values are in the companion CHECK definitions. |
| source_verified_at | timestamptz | Y | Time source identity, form and fingerprint were verified. |
| requires_review | boolean | N | Clock/campaign warning holds changed values for review. |
| warnings | jsonb | N | Structured warning-code array. |
| rejection_reason | text | Y | Terminal validation explanation when applicable. |
| lease_token | uuid | Y | Current bounded processing/recovery claim identity. |
| lease_expires_at | timestamptz | Y | Claim expiry used with fencing checks. |
| last_error | varchar(2000) | Y | Bounded operational diagnostic. |
| updated_at | timestamptz | N | Server time of the last allowed workflow update. |
| verified_patch | jsonb | Y | Verified typed SQL projection; not a replacement for sealed evidence. |
| reconciliation_result | jsonb | Y | Original immutable reconciliation receipt. |

UNIQUE (author_id, client_submission_id).

PRIMARY KEY (submission_id).

UNIQUE (submission_id, record_id).

# Appendix 5 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge.field_changes

Per-field proposal and disposition.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| change_id | uuid | N UQ/PK | Proposed scalar change identity. |
| submission_id | uuid | N UQ/FK | Source submission identity; logical MongoDB source _id. |
| record_id | uuid | N UQ/FK | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| field_name | text | N UQ | One of the four canonical editable fields. |
| base_value | jsonb | N | Typed normalized scalar in the base snapshot; JSON null means unknown. |
| proposed_value | jsonb | N | Typed normalized proposed scalar. |
| compared_value | jsonb | N | Typed scalar when the change was classified. |
| compared_version_no | integer | N FK | Accepted snapshot used in classification. |
| classification | text | N | Reconciliation category; not the same as final disposition. |
| state | text | N | Current workflow disposition; allowed values are in the companion CHECK definitions. |
| pending_reason | text | Y | Reason a field is awaiting review; null after disposition. |
| revision_no | integer | N | Review-context revision used to reject stale actions. |
| applied_version_no | integer | Y UQ/FK | Snapshot that actually applied this field; absent for unapplied changes. |
| updated_at | timestamptz | N | Server time of the last allowed workflow update. |

UNIQUE (change_id, record_id).

PRIMARY KEY (change_id).

UNIQUE (record_id, applied_version_no, field_name).

UNIQUE (submission_id, field_name).

# Appendix 6 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge.review_decisions

Terminal reviewer intent and receipt.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| decision_id | uuid | N PK/UQ | Immutable reviewer decision identity. |
| change_id | uuid | N UQ/FK | Proposed scalar change identity. |
| record_id | uuid | N FK/UQ | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| reviewer_id | uuid | N UQ/FK | Authenticated reviewer responsible for the decision. |
| client_decision_id | uuid | N UQ | Reviewer-scoped retry identity. |
| request_hash | text | N | Fingerprint of validated reviewer intent. |
| expected_version_no | integer | N FK | Accepted version the reviewer saw. |
| expected_change_revision | integer | N | Pending change revision the reviewer saw. |
| action | text | N | accept_proposal, keep_current, or replace. |
| chosen_value | jsonb | N | Typed terminal scalar, including JSON null. |
| reason | varchar(2000) | N | Trimmed nonempty reviewer explanation. |
| result_version_no | integer | Y FK/UQ | New accepted version if the decision changes an accepted value. |
| created_at | timestamptz | N | Server creation time. |
| decision_result | jsonb | Y | Original immutable decision receipt for unchanged retries. |

UNIQUE (change_id).

PRIMARY KEY (decision_id).

UNIQUE (record_id, result_version_no).

UNIQUE (reviewer_id, client_decision_id).

# Appendix 7 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge_auth.sessions

Hashed opaque session references.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| token_hash | text | N PK | SHA-256 session-token hash; secret session identifiers are not exported as data. |
| user_id | uuid | N FK | Application user identity. |
| expires_at | timestamptz | N | Session expiry. |
| created_at | timestamptz | N | Server creation time. |

PRIMARY KEY (token_hash).

## fieldmerge_auth.login_attempts

Authentication-attempt windows.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| attempt_key | text | N PK | Hashed login-attempt key. |
| window_start | timestamptz | N | Login-attempt window start. |
| attempts | integer | N | Attempt counter. |

PRIMARY KEY (attempt_key).

## fieldmerge_meta.migrations

Applied version/checksum registry.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| version | text | N PK | Applied ordered migration number. |
| checksum | text | N | SHA-256 of applied migration file. |
| applied_at | timestamptz | N | Migration application time. |

PRIMARY KEY (version).

# Appendix 8 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge_ops.intake_batches

Owner-scoped manifest identity.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| batch_id | uuid | N UQ/PK | Server transport batch identity; not logical source identity. |
| owner_id | uuid | N UQ/FK | Authenticated owner of a batch or recovery target. |
| client_batch_id | uuid | N UQ | Owner-scoped retry identity for a batch. |
| manifest_hash | text | N | Fingerprint of ordered batch content. |
| item_count | integer | N | Number of manifest positions. |
| created_at | timestamptz | N | Server creation time. |

UNIQUE (owner_id, client_batch_id).

PRIMARY KEY (batch_id).

## fieldmerge_ops.batch_items

Independent batch positions and outcomes.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| batch_id | uuid | N FK/PK | Server transport batch identity; not logical source identity. |
| item_index | integer | N PK | Original zero-based batch position. |
| content_hash | text | N | Canonical item fingerprint used for unchanged manifest replay. |
| submission_id | uuid | Y FK | Source submission identity; logical MongoDB source _id. |
| error_code | varchar(80) | Y | Bounded safe failure code. |
| updated_at | timestamptz | N | Server time of the last allowed workflow update. |

PRIMARY KEY (batch_id, item_index).

# Appendix 9 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge_ops.recovery_jobs

Durable scheduling, leases and fencing.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| job_id | uuid | N PK | Recovery job identity. |
| job_kind | text | N UQ | Submission or sealed-draft recovery work kind. |
| target_id | uuid | N UQ | Target UUID; polymorphic/possibly nonexistent targets have no general entity FK. |
| owner_id | uuid | N FK | Authenticated owner of a batch or recovery target. |
| submission_id | uuid | Y FK | Source submission identity; logical MongoDB source _id. |
| status | text | N | Recovery lifecycle status. |
| attempts | integer | N | Attempt counter. |
| failure_count | integer | N | Bounded recovery failure counter. |
| next_attempt_at | timestamptz | N | Earliest next eligible recovery time. |
| lease_token | uuid | Y | Current bounded processing/recovery claim identity. |
| lease_expires_at | timestamptz | Y | Claim expiry used with fencing checks. |
| claimed_by | uuid | Y | Worker claim identifier. |
| last_error_code | varchar(80) | Y | Safe most recent recovery error. |
| created_at | timestamptz | N | Server creation time. |
| updated_at | timestamptz | N | Server time of the last allowed workflow update. |
| completed_at | timestamptz | Y | Recovery completion time when applicable. |

UNIQUE (job_kind, target_id).

PRIMARY KEY (job_id).

# Appendix 10 SQL data dictionary

Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.

## fieldmerge_ops.recovery_events

Recovery activity history.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| event_id | bigint | N PK | Event identity. |
| job_id | uuid | N FK | Recovery job identity. |
| event_type | text | N | Controlled activity kind. |
| actor_id | uuid | Y FK | Responsible or identifiable actor when available. |
| event_data | jsonb | N | Structured event details governed by the write function. |
| created_at | timestamptz | N | Server creation time. |

PRIMARY KEY (event_id).

## fieldmerge_ops.security_events

Independent safe HTTP failure evidence.

| Column | Type | Null and keys | Meaning |
|---|---|---|---|
| request_id | uuid | N PK | Server-generated HTTP correlation UUID. |
| occurred_at | timestamptz | N | Server time of failure-event insertion. |
| actor_id | uuid | Y FK | Responsible or identifiable actor when available. |
| actor_role | text | Y | Role of an identifiable actor; not proof authorization succeeded. |
| method | text | N | Bounded HTTP method enumeration. |
| route_template | varchar(100) | N | Allowlisted route template; excludes raw URL and query. |
| target_id | uuid | Y | Target UUID; polymorphic/possibly nonexistent targets have no general entity FK. |
| http_status | smallint | N | Mapped HTTP failure status 400–599. |
| error_code | varchar(80) | N | Bounded safe failure code. |
| sqlstate | varchar(5) | Y | Optional five-character SQLSTATE, excluding raw exception text. |

PRIMARY KEY (request_id).
