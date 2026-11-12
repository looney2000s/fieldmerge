# FieldMerge project checklist

Status baseline: 12 November 2026. Checked means completed within the scope stated; unchecked means remaining or not yet verified. A completed database function does not imply a working API or web interface. This checklist covers FieldMerge only.

## Step 0 Understand the assignment

- [x] Read the project requirements PDF.
- [x] Read the 50-mark evaluation rubric.
- [x] Review the submitted-project spreadsheet for overlap.
- [x] Account for solo implementation when setting scope.
- [ ] Record the solo arrangement with the instructor; approval has not been verified in this chat.
- [ ] Confirm final submission deadline, required format, and demonstration arrangements.

## Step 1 Select and define the problem

- [x] Select FieldMerge and the urban tree survey context.
- [x] Define the real-world problem and motivation using public documentation.
- [x] Check the proposed workflow against the supplied project descriptions.
- [x] Identify substantive behavior beyond CRUD: conflict detection, controlled merging, versioning, and review.
- [x] Define an MVP suitable for one developer and explicit exclusions.
- [x] Create the project proposal DOCX and apply the requested removals.

## Step 2 Finalize requirements

- [x] Define surveyor and reviewer roles and permitted actions.
- [x] Define the four canonical fields, types, nullable values, and units.
- [x] Define missing/null/false/zero semantics and species normalization.
- [x] Define the two controlled form versions and optional evidence observations.
- [x] Define merge rules, including intervening edits and reversals.
- [x] Define submission/review idempotency and version/revision tokens.
- [x] Define submission states, batch/resource limits, and recovery requirements.
- [x] Define 35 acceptance scenarios and expected outcomes.

## Step 3 Establish source control and working practices

- [x] Add .gitignore rules for environment secrets, temporary fixtures, and dependencies.
- [x] Create a README with database setup and verification instructions.
- [x] Initialize the local Git repository on main.
- [x] Make a reviewed initial commit excluding .env, generated account credentials, and local course materials.
- [x] Connect the GitHub repository and publish the initial database milestone on main.
- [ ] Maintain meaningful commits for the remaining implementation and individual contribution evidence.

## Step 4 Complete database design

- [x] Choose PostgreSQL plus MongoDB and explain their responsibilities.
- [x] Define the Chen entities, attributes, relationships, and participation constraints.
- [x] Draw the ER diagram — reported completed by the user.
- [ ] Inspect the actual ER diagram and reconcile it with the implemented schema.
- [ ] Export/store the final readable ER diagram in the project deliverables.
- [x] Create the relational schema and data dictionary.
- [x] Define composite identities and same-tree foreign keys.
- [x] Document normalization decisions and deliberate redundant guard columns.
- [x] Define the MongoDB collection model and cross-store reference boundaries.

## Step 5 Set up the local environment

- [x] Install/configure Docker Desktop and verify Docker access.
- [x] Configure PostgreSQL and MongoDB through Docker Compose.
- [x] Pin the tested database image digests.
- [x] Configure loopback-only database ports and generated local credentials.
- [x] Provide persistent development storage and separate temporary test services.
- [x] Provide Start, Stop, Status, Setup, and Verify commands.
- [x] Implement ordered, checksum-protected SQL migrations.
- [x] Verify setup/seed repeatability without resetting development records.

## Step 6 Implement database structures and initial data

- [x] Apply migration 001 with nine business tables and the migration-tracking table.
- [x] Implement primary/foreign/unique constraints, field domains, and indexes.
- [x] Enforce initial version existence and protect immutable SQL history.
- [x] Create the initial read views and source-document validators.
- [x] Create three MongoDB collections and their indexes.
- [x] Define restricted MongoDB evidence/draft service roles.
- [x] Seed one synthetic campaign and three baseline trees.
- [x] Generate two demo accounts with salted password hashes.
- [x] Seed two form definitions with matching SQL/MongoDB hashes.
- [x] Pass 39 PostgreSQL structural checks and 31 MongoDB structural checks.
- [ ] Expand the demonstration fixtures with representative unresolved, partially applied, and resolved cases through supported workflows.
- [ ] Decide whether to retain synthetic data only or also provide a documented public-data importer. Public-data import is optional; do not label synthetic data as real observations.

## Step 7 Implement automatic reconciliation

- [x] Apply migration 002 and implement reconcile_submission.
- [x] Require a verified SQL source projection and matching expected hash before processing.
- [x] Lock the tree before publication and re-read current accepted state.
- [x] Validate/normalize the complete patch before applying any field.
- [x] Implement no-change, already-represented, compatible, and conflict outcomes.
- [x] Detect changes that later returned to the base value.
- [x] Publish compatible fields together while retaining conflicting values.
- [x] Handle explicit null, clock/campaign warnings, and evidence-only SQL inputs.
- [x] Create a new version only when an accepted value changes.
- [x] Save field outcomes, submission state, receipt, and audit event atomically.
- [x] Return the same original receipt on matching retries.
- [x] Protect verified input and initial receipts from mutation.
- [x] Create the field-value provenance view.
- [x] Pass 32 automatic reconciliation assertions and two concurrent-session scenarios.

## Step 8 Implement reviewer decisions

- [x] Apply migration 003 and implement review_change.
- [x] Support accepting a proposal, keeping current, and supplying a replacement.
- [x] Check the active reviewer role at the trusted SQL boundary.
- [x] Require a reason and validate replacement field types/values.
- [x] Reject stale accepted-version and pending-change revision tokens.
- [x] Enforce one terminal decision per proposed field.
- [x] Serialize reviewer retry identities, including cross-tree key reuse.
- [x] Store immutable decision receipts and reject changed-content retries.
- [x] Update live submission state without rewriting its initial reconciliation receipt.
- [x] Preserve proposal, reviewer, and chosen-value provenance.
- [x] Verify complete rollback when a late review audit write fails.
- [x] Pass 34 reviewer assertions and four concurrent-session scenarios.

## Step 9 Finish workflow integrity and production-facing database access

- [x] Add consistency enforcement ensuring every actual nonbaseline snapshot change has exactly one matching applying field-change link.
- [x] Validate snapshot values, submission origins, decisions, applying links, receipts, live states, and workflow audit together at transaction completion.
- [x] Protect workflow states and terminal field outcomes outside controlled verified-intake/reconciliation/review entry points using a non-login execution role and mutation guards.
- [x] Provision separate restricted PostgreSQL/MongoDB API accounts; application requests use neither owner nor root credentials.
- [x] Guard database entry points for authenticated surveyors/reviewers; the API role has no direct table access.
- [x] Derive database actor identity from a revocable hashed session token inside guarded functions.
- [x] Verify direct database bypass and wrong-role wrapper calls using actual API credentials.

Migration 004 connects the workflow functions to authenticated sessions through restricted, role-aware wrappers. Migration 006 makes the publication functions execute as a restricted non-login role and adds deferred consistency/ordinary mutation protection. General direct table access remains denied; the API cannot assume the workflow role. See docs/FieldMerge_Workflow_Integrity.md.

## Step 10 Build verified source intake and cross-store recovery

- [x] Implement deterministic canonicalization, exact decimals, duplicate-key rejection, and bounded input parsing.
- [x] Compute/verify fingerprints and compare the stored BSON projection with the canonical source.
- [x] Reserve SQL request identities and reject changed-content retries.
- [x] Insert sealed MongoDB evidence idempotently with restricted insert/read credentials.
- [x] Verify source/form identity and hashes before marking SQL ready and storing verified_patch.
- [x] Connect verified intake to reconciliation without duplicate effects.
- [x] Implement a persistent recovery queue, bounded claims, expired-token fencing, retry budget/backoff, quarantine, and sealed-draft discovery across worker restarts.
- [x] Test same-request recovery with injected interruptions before/after document storage and after SQL commit before response.
- [x] Expose reviewer-only recovery job/status/event inspection and reasoned retry without overwriting evidence.
- [x] Process batch items independently with durable manifests, memberships, per-item receipts/errors, stable retry identities, and immutable first-intake source attribution.
- [x] Verify both controlled source forms, evidence-only submissions, explicit null/false/zero, and timestamp/decimal behavior through real intake.
- [x] Verify submission/batch byte limits, malformed transport, and selected boundary values through S01–S17/S23; see docs/FieldMerge_Security.md for the tested scope.

## Step 11 Build the authenticated backend

- [x] Scaffold Next.js route handlers and restricted server-side database connections.
- [x] Generate server-only API credentials and reject owner/root connection identities in application modules.
- [x] Implement password verification, login/logout, revocable eight-hour sessions, and inactive-account checks.
- [x] Enforce roles and draft ownership on every currently exposed protected operation.
- [x] Implement record listing and snapshot retrieval endpoints.
- [x] Add literal record filtering, bounded cursor pagination, and version-specific snapshot downloads.
- [x] Implement owner-scoped draft creation, revision-safe edit, and permitted deletion.
- [x] Implement immutable draft finalization with retries after injected interruptions, including a lost response after SQL commit.
- [x] Implement submission/batch upload, own/reviewer outcome/source retrieval, and owner-requested recovery endpoints.
- [x] Implement reviewer queue, current comparison, and guarded decision endpoints.
- [x] Implement history and field-provenance endpoints.
- [x] Implement reviewer SQL/MongoDB aggregate summaries and bounded CSV/JSON accepted-record exports.
- [x] Map database errors to bounded HTTP responses and return a refresh-required stale-review error.
- [x] Record handled failed access/stale attempts through an independent SQL transaction with safe persistent file fallback; verify rollback survival, reviewer access, redaction, and logger failure.

## Step 12 Build the Next.js interface

- [x] Login and role-aware navigation.
- [x] Accepted record list with search/filtering and details.
- [x] Snapshot download and clear base-version display.
- [x] Own drafts with field selection, explicit clear controls, and validation.
- [x] Delayed batch upload and per-item feedback.
- [x] Submission detail with source observations, warnings, and field outcomes.
- [x] Reviewer queue and base/current/proposed comparison.
- [x] Reviewer decision form with reason and stale-comparison handling.
- [x] Version history and field-provenance screens.
- [x] Role-appropriate summaries and exports.
- [x] Loading, empty, error, access-denied, and retry states.
- [x] Keyboard access, readable labels, and usable layout at common screen sizes.

## Step 13 Complete integrated verification and query evidence

- [x] Run structural and SQL workflow checks against real isolated databases.
- [x] Exercise six real concurrent-session scenarios and injected SQL rollback failures.
- [x] Save verification output and migration checksums in output/database/verification.json.
- [x] Verify injected workflow inconsistencies roll back, including actual COMMIT failures and an HTTP integrity-error/same-request retry scenario.
- [x] Verify restricted worker credentials, missing-source waiting, quarantine, competing/expired workers, inactive authors, connection failure, and an actual worker-process kill/restart.
- [x] Map all 35 acceptance scenarios to executable tests; all 35 pass with the evidence and boundaries in docs/FieldMerge_Acceptance.md.
- [x] Run representative browser → authenticated API → both databases → response workflows for both roles; the separate AC01–AC35 suite also passes.
- [x] Test owner/role denial, restricted SQL/MongoDB bypass attempts, literal injection-like filters, invalid/missing inputs, and inactive/expired/revoked sessions in the existing targeted integration checks.
- [x] Test actual MongoDB service unavailability by pausing a disposable container, interrupted intake hooks, a killed/restarted worker process, and lost browser responses; see the precise boundaries in the acceptance guide.
- [x] Extend transport/adversarial coverage with 23 security API groups and five browser checks; these targeted checks are not an exhaustive security audit.
- [x] Test browser-submitted lost-response retries for review/finalization, review reload/resume, unchanged batch replay, and stale reviewer actions without changing intent automatically.
- [x] Independently reconcile SQL accepted/workflow totals and MongoDB form/batch/observation aggregates in integrated tests.
- [x] Prepare and execute meaningful DML, JOIN, nested/correlated, recursive/CTE, window, aggregate, GROUP BY, HAVING, and ORDER BY demonstrations, plus MongoDB evidence queries/aggregations.
- [x] Demonstrate CREATE/ALTER, INSERT/UPDATE/DELETE and explicit DROP using disposable staging objects; preserve accepted history and sealed evidence.
- [x] Record full query plans, raw samples and index comparisons on 10,003 synthetic records, 14,308 snapshots and 4,504 source documents, with environment/method/limits documented in output/performance and docs/FieldMerge_Query_Demonstrations.md.
- [ ] Verify a clean rebuild and full test run using the final code/configuration.

The latest saved database milestone has 231 assertions (39 SQL structure + 32 reconciliation + 34 reviewer + 52 integrity + 21 recovery + 22 query/export/batch + 31 MongoDB), four actual COMMIT scenarios, six concurrent SQL scenarios, and matching form hashes. These database assertions remain separate evidence. All 35 functional acceptance scenarios additionally pass in the dedicated production-API/disposable-service suite, including actual MongoDB unavailability and rollback/retry.

The milestone additionally passes eighteen unit groups, thirty-three API/worker/query integration groups against a production Next.js server and both databases, and a production build. Evidence is in output/api/verification.json. New tests verify filters/pagination, downloads, independent summaries, formula-like CSV text, 5,000/5,001-row export limits, batch replay/membership/ownership, and batched recovery. Prior worker kill/restart, connectivity failure, authorization, and integrity checks remain included. Fifteen browser workflow checks now pass against a production Next.js server and both databases, including exact-intent retries after lost responses, stale review rejection, explicit null/false/zero, exports, role denial, keyboard focus, and mobile navigation. Nine representative axe WCAG A/AA page scans report no violations, and no browser runtime errors were recorded. Evidence and screenshots are in output/browser. Automated scans do not establish complete accessibility conformance. The AC01–AC35 mapping and recorded results are in docs/FieldMerge_Acceptance.md and output/acceptance. The separate security suite passes 23 transport/security groups and five browser checks. Eight added unit groups verify logger isolation, persistence/redaction, bounded capacity, and stream-byte handling. See docs/FieldMerge_Security.md for coverage and operational limits.

## Step 14 Complete the final documentation

- [x] Maintain the project overview, requirements, schema models, implementation guides, and database README.
- [ ] Reconcile the final ER diagram, relational schema, document model, dictionary, and implementation.
- [ ] Add the implemented system architecture and authentication/data-flow explanation.
- [x] Document important queries and explain the roles of functions, transactions, locks, constraints, triggers, views and document aggregation in the query/viva guide; integrate these into the final report separately.
- [ ] Integrate application screenshots, test evidence, measured performance and source attribution into the final report.
- [ ] State verified results, known limitations, conclusion, and future enhancements accurately.
- [ ] Document final setup, demo accounts/configuration, execution, verification, and recovery instructions.
- [ ] Finalize the report/DOCX and visually inspect its layout.
- [ ] Remove secrets, generated credential files, and unnecessary temporary artifacts from submission materials.

## Step 15 Rehearse and submit

- [ ] Prepare a repeatable demonstration of the problem, design, both databases, and complete user workflow.
- [ ] Demonstrate a compatible merge, conflict resolution, duplicate retry, provenance, and denied unauthorized action.
- [ ] Prepare viva explanations for constraints, locking, transactions, triggers/functions, CTEs, document queries, and technology tradeoffs.
- [ ] Practice modifying/explaining a query or rule and rerunning an appropriate check.
- [ ] Rehearse setup and demonstration from the documented final revision.
- [ ] Audit each rubric component and verify its supporting evidence.
- [ ] Package and submit the required source, report, diagrams, and evidence by the confirmed deadline.
- [ ] Complete the final demonstration/viva.

Hosted deployment is not explicitly mandated by the supplied project requirements. Add deployment and live configuration verification only if requested by the instructor or chosen as an enhancement; a complete local demonstration remains the current implementation target.

## Immediate next milestone

Reconcile final ER/schema/report deliverables and rehearse a clean release/demo. All 35 functional acceptance cases, targeted transport/security checks and safe failure logging pass, and query/performance evidence is prepared. The latest branch is codex/security-boundaries, building on the earlier backend/interface/audit branches. The interface is ready for a local demonstration; startup, generated-account locations, workflows, and current limitations are documented in docs/FieldMerge_Interface.md. Query examples and measurements are in docs/FieldMerge_Query_Demonstrations.md and output/performance. Keep pnpm worker running for unattended recovery and restart it after code updates. main contains the earlier database milestone until feature work is merged.
