# FieldMerge project checklist

Status baseline: 10 November 2026. Checked means completed within the scope stated; unchecked means remaining or not yet verified. A completed database function does not imply a working API or web interface. This checklist covers FieldMerge only.

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
- [ ] Create/connect the GitHub repository and push the work.
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

- [ ] Add consistency enforcement ensuring every actual nonbaseline snapshot change has exactly one matching applying field-change link.
- [ ] Validate snapshot values, submission origins, decisions, and applying links together at transaction completion.
- [ ] Protect workflow states and terminal field outcomes against unsupported mutation outside the two trusted workflow functions.
- [ ] Provision separate restricted backend/service login accounts; stop using database-owner/root credentials for application requests.
- [ ] Implement database access policies/protected entry points appropriate to authenticated surveyors and reviewers.
- [ ] Establish server-verified actor context safely within each request transaction.
- [ ] Verify direct database bypass attempts using the actual application credentials.

The existing functions check supplied identities and are inaccessible to fieldmerge_app. They are not yet connected to authenticated users. These remaining items are separate from the passing owner-driven SQL tests.

## Step 10 Build verified source intake and cross-store recovery

- [ ] Implement deterministic client-envelope canonicalization, including exact decimals and duplicate-key rejection.
- [ ] Compute and verify request fingerprints against the stored source content.
- [ ] Reserve SQL request identities and reject changed-content retries.
- [ ] Insert sealed MongoDB source evidence idempotently.
- [ ] Verify source identity, form, target/base, and content hash before marking SQL ready and storing verified_patch.
- [ ] Connect ready intake to automatic reconciliation without duplicate effects.
- [ ] Implement bounded processing/recovery coordination across worker restarts.
- [ ] Recover from failure before document storage, after document storage, and after SQL commit but before response.
- [ ] Expose incomplete/mismatched intake for operational inspection without overwriting evidence.
- [ ] Process valid batch items independently and return per-item receipts/errors.
- [ ] Verify all source forms, evidence-only submissions, byte limits, and timestamp/decimal conversions through real intake.

## Step 11 Build the authenticated backend

- [ ] Scaffold the Next.js project with server-side PostgreSQL and MongoDB connections.
- [ ] Validate required environment configuration and keep credentials server-only.
- [ ] Implement password verification, login/logout, secure sessions, and inactive-account handling.
- [ ] Enforce roles and draft ownership on every protected operation.
- [ ] Implement record listing, filtering, snapshot retrieval, and download endpoints.
- [ ] Implement owner-scoped draft creation, revision-safe edit, and permitted deletion.
- [ ] Implement immutable draft finalization with safe restart/retry behavior.
- [ ] Implement source submission/batch upload and outcome retrieval endpoints.
- [ ] Implement reviewer queue, current comparison, and decision endpoints.
- [ ] Implement history, provenance, aggregate, and export endpoints.
- [ ] Map database errors into actionable responses; require reconsideration after stale approval errors.
- [ ] Record failed access/stale attempts at a logging boundary that survives rolled-back database transactions, without logging secrets.

## Step 12 Build the Next.js interface

- [ ] Login and role-aware navigation.
- [ ] Accepted record list with search/filtering and details.
- [ ] Snapshot download and clear base-version display.
- [ ] Own drafts with field selection, explicit clear controls, and validation.
- [ ] Delayed batch upload and per-item feedback.
- [ ] Submission detail with source observations, warnings, and field outcomes.
- [ ] Reviewer queue and base/current/proposed comparison.
- [ ] Reviewer decision form with reason and stale-comparison handling.
- [ ] Version history and field-provenance screens.
- [ ] Role-appropriate summaries and exports.
- [ ] Loading, empty, error, access-denied, and retry states.
- [ ] Keyboard access, readable labels, and usable layout at common screen sizes.

## Step 13 Complete integrated verification and query evidence

- [x] Run structural and SQL workflow checks against real isolated databases.
- [x] Exercise six real concurrent-session scenarios and injected SQL rollback failures.
- [x] Save verification output and migration checksums in output/database/verification.json.
- [ ] Map all 35 acceptance scenarios to integrated tests and close any coverage gaps.
- [ ] Run the full browser → authenticated API → both databases → response workflows for both roles.
- [ ] Test ownership, role bypass, injection attempts, invalid/missing inputs, and session behavior.
- [ ] Test actual MongoDB outages, interrupted intake, worker restart, and lost responses.
- [ ] Test browser-submitted retries and stale reviewer actions without changing intent automatically.
- [ ] Independently reconcile SQL accepted/review totals and MongoDB evidence aggregates.
- [ ] Prepare meaningful DML, JOIN, nested/correlated, recursive/CTE, aggregate, GROUP BY, HAVING, and ORDER BY demonstrations where applicable.
- [ ] Demonstrate CREATE/ALTER and safe DROP using disposable objects; preserve final evidence/history.
- [ ] Record representative query plans and measured performance on a documented dataset.
- [ ] Verify a clean rebuild and full test run using the final code/configuration.

The latest saved milestone has 136 assertions (39 SQL structure + 32 reconciliation + 34 reviewer + 31 MongoDB structure), six concurrent-session scenarios, and matching form hashes. These are not equivalent to all 35 end-to-end acceptance scenarios passing.

## Step 14 Complete the final documentation

- [x] Maintain the project overview, requirements, schema models, implementation guides, and database README.
- [ ] Reconcile the final ER diagram, relational schema, document model, dictionary, and implementation.
- [ ] Add the implemented system architecture and authentication/data-flow explanation.
- [ ] Add important queries and explain how advanced database features solve the problem.
- [ ] Add actual application screenshots, completed tests, performance results, and source attribution.
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

Complete the authenticated backend boundary and database access design, then verified MongoDB-to-PostgreSQL intake. This connects the tested SQL functions to real user submissions. Establish Git/GitHub tracking now as well, because it is still absent from this workspace.
