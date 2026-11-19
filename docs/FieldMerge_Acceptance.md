# FieldMerge acceptance verification

All 35 scenarios in the unchanged [requirements baseline](FieldMerge_Requirements.md#13-acceptance-scenarios) passed. This closes the enumerated functional acceptance cases, rather than treating the earlier database assertion count as proof of complete application coverage.

The executable mapping is [tests/acceptance/scenarios.test.mjs](../tests/acceptance/scenarios.test.mjs). Each test is named AC01–AC35 and asserts its stored outcomes. The module checks its registered IDs against the actual requirements table, so adding/removing a required scenario without matching tests fails the suite. Every scenario uses a new fixture except AC34, which intentionally revisits a seeded baseline record in the disposable database.

Evidence: [individual results](../output/acceptance/scenarios.json), [runner output and cleanup](../output/acceptance/verification.json), and [selected source/migration checksums](../output/acceptance/source-checksums.json). Checksums identify the tested baseline, test harness and critical implementation files; they are not a signed attestation or a substitute for reviewing the tests.

## Scenario-to-test map

| ID | Verified behavior | Verification layers | Result |
|---|---|---|---|
| AC01 | Compatible diameter publishes one version | HTTP, SQL | Passed |
| AC02 | Independent stale-base changes preserve both values | HTTP, SQL | Passed |
| AC03 | Competing value remains pending | HTTP, SQL | Passed |
| AC04 | Already represented does not steal provenance | HTTP, SQL | Passed |
| AC05 | Base-equal proposal does not revert current | HTTP, SQL | Passed |
| AC06 | Change then reversal still conflicts | HTTP, SQL | Passed |
| AC07 | Omitted diameter remains unchanged | HTTP, SQL | Passed |
| AC08 | Explicit null clears a known guard value | HTTP, SQL, MongoDB | Passed |
| AC09 | String boolean rejects the entire item | HTTP, SQL | Passed |
| AC10 | Numeric zero remains a known value | HTTP, SQL | Passed |
| AC11 | One invalid field prevents every publication | HTTP, SQL | Passed |
| AC12 | Compatible health publishes while diameter waits | HTTP, SQL | Passed |
| AC13 | Missing base, unknown patch field and unsupported form have distinct errors | HTTP, SQL | Passed |
| AC14 | Three identical uploads produce one source and effect | HTTP, SQL, MongoDB | Passed |
| AC15 | Changed patch, evidence or metadata cannot reuse an identity | HTTP, SQL, MongoDB | Passed |
| AC16 | Racing proposals serialize at a real SQL lock | HTTP, SQL concurrency | Passed |
| AC17 | Stale reviewer version cannot silently rebase | HTTP, SQL | Passed |
| AC18 | Keep-current closes without a new accepted version | HTTP, SQL | Passed |
| AC19 | Accepted review commits decision, version, change and audit together | HTTP, SQL | Passed |
| AC20 | Two distinct reviewers cannot dispose of one revision twice | HTTP, SQL concurrency | Passed |
| AC21 | Retry after a committed decision returns the original receipt | SQL commit, HTTP retry | Passed |
| AC22 | Real MongoDB outage leaves reserved intake visible and SQL readable | Docker outage, HTTP, SQL, MongoDB | Passed |
| AC23 | Interruption after document insert recovers stored evidence once | Intake failpoint, HTTP, SQL, MongoDB | Passed |
| AC24 | Publication rollback and lost commit response both recover once | SQL failure injection, Intake failpoint, HTTP, SQL | Passed |
| AC25 | Wrong-role review and another surveyor draft are denied | HTTP, SQL permissions | Passed |
| AC26 | Application credentials cannot rewrite accepted history or sealed evidence | Restricted SQL, Restricted MongoDB | Passed |
| AC27 | Two optional observations are retained and independently aggregated | HTTP, SQL, MongoDB aggregation | Passed |
| AC28 | Observation timestamps do not select the accepted truth | HTTP, SQL, MongoDB | Passed |
| AC29 | Ten-minute future observation warns and holds actual changes | HTTP, SQL, MongoDB | Passed |
| AC30 | Mixed batch retains successful item across identical retry | HTTP, SQL, MongoDB | Passed |
| AC31 | Health-only publication preserves origins of carried values | HTTP, SQL provenance | Passed |
| AC32 | Evidence-only submission creates no scalar version | HTTP, SQL, MongoDB | Passed |
| AC33 | Both controlled forms share canonical merge behavior | HTTP, SQL, MongoDB | Passed |
| AC34 | Baseline re-import after accepted edits neither duplicates nor overwrites | HTTP, SQL import | Passed |
| AC35 | Impossible history is rejected under a rolled-back administrative fault | SQL fault injection, SQL rollback, HTTP recovery | Passed |

## Important boundaries

- AC16 and AC20 issue concurrent real HTTP requests. An independent PostgreSQL transaction holds the target record lock until both application transactions are observably waiting. Assertions then check serialization, reclassification, and a single terminal disposition.
- AC21 commits a decision through the restricted SQL wrapper and repeats it through HTTP. The separate browser suite additionally drops a successful review response and verifies exact-command retry after page reload.
- AC22 pauses an actual, uniquely identified disposable MongoDB container after SQL reservation and before evidence insertion. It verifies awaiting_document through HTTP, continued accepted-record reads, unavailable evidence summaries, and one publication after unpause and unchanged retry. A pre-reservation outage can return 503 without a reserved receipt because form verification also needs MongoDB. This check covers service unavailability, not process-crash durability, disk loss, or a network partition between multiple database nodes. An operation whose response timed out can still have executed when service resumes; stable source IDs prevent duplicate effects.
- AC23 and the lost-response half of AC24 use internal dependency-injection hooks at real intake boundaries. AC24 also causes an actual late SQL audit-write error and checks complete rollback before retry. These hooks are not HTTP inputs. The existing recovery suite independently kills/restarts a real worker process.
- AC25 and AC26 exercise server ownership/role checks and actual restricted database credentials. They do not model a compromised backend, stolen administrator credentials, or all possible security attacks.
- AC27–AC28 retain categorized notes and their timestamps. Form observations do not have an arbitrary scalar value property; competing measurements are represented by separate valid scalar proposals and supporting notes. Both arrival/timestamp orderings preserve evidence and leave the competing value pending.
- AC29 uses the real database clock plus ten minutes within the configured campaign. Fixtures will need their campaign dates updated before rerunning in a later campaign/year; a campaign-window warning must not be relabelled as a clock warning merely to pass a test.
- AC34 reruns the actual generated synthetic baseline seed after an accepted edit, checking identities and complete history. It does not certify a general public-dataset import pipeline or arbitrary source mappings.
- AC35 tests a defensive branch that correct parent-chain constraints normally make unreachable. Only inside a disposable administrator transaction, the test disables the immutable-update trigger and removes the parent-chain CHECK, then makes a broken parent link. Reconciliation raises the expected history-integrity error without publication. The entire fault transaction, including DDL, is rolled back; healthy retry remains a pending conflict. No migration or development constraint is weakened.

## Changes made during the audit

Missing accepted base snapshots now return HTTP 400 base_version_not_found, and unknown patch fields return HTTP 400 unknown_patch_field. Unsupported forms already had a distinct error. Diagnostic classification happens only after a failed new reservation, so a changed base under an existing request identity still returns an idempotency conflict. Reservation and publication continue to enforce the SQL rules.

The API MongoDB client now sets a three-second connection/server-selection timeout and five-second socket and pool-wait timeouts. An established connection to an unavailable server must not wait indefinitely. These are per-operation bounds, not a promise that a complete HTTP request or 100-item batch finishes within five seconds: driver retries and multiple operations can extend total time. The worker already has separate bounded I/O settings.

## Run it again

With Docker Desktop running and normal project dependencies/fixtures prepared:

```powershell
pnpm build
pnpm test:acceptance
```

The wrapper creates a unique Compose project using the existing postgres-test and mongo-test definitions, tmpfs data directories, and dynamically assigned loopback ports. No development named volume is mounted. Only the labelled disposable MongoDB container can be paused. A temporary production Next.js server listens on 127.0.0.1:3100. All acceptance services are removed afterward; output/acceptance records whether cleanup succeeded. A failed run is marked failed, rather than retaining a previous successful status.

Run API, acceptance and browser suites sequentially because their production servers share port 3100. The API/browser runners use unique databases on the normal development services; the acceptance runner uses separate services so its outage cannot interrupt development. Actual application calls use restricted API credentials; administrative access is limited to fixture provisioning, fault injection and assertions. Credentials remain in ignored local configuration and are not included in evidence.

## Completion limits

The 35 functional scenarios are verified. They are supported by the separate 18 unit groups, 33 API/worker/query groups, and 15 browser workflows, rather than replacing those suites. Browser accessibility scans are representative automated checks, not complete accessibility certification. [Query demonstrations and measured database performance](FieldMerge_Query_Demonstrations.md) are also prepared. The separate [security milestone](FieldMerge_Security.md) verifies submission-size/transport boundaries and selected adversarial inputs, plus persistent safe logging for handled authorization/stale failures. Final ER/schema/report reconciliation, release rehearsal and viva/submission preparation remain open in the [project checklist](FieldMerge_Project_Checklist.md). These suites do not establish exhaustive security/outage coverage.
