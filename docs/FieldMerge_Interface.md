# FieldMerge interface

The Next.js workspace connects the existing authenticated API, PostgreSQL publication/review functions, and MongoDB drafts/source evidence. The interface uses actual stored records and outcomes. Demonstration records and screenshots are synthetic.

## Open the application

From the project directory, with Docker Desktop running:

```powershell
.\scripts\database.ps1 Setup
pnpm install --frozen-lockfile
pnpm configure:backend
pnpm dev
```

Open http://localhost:3000 and sign in. Use this exact origin, matching APP_ORIGIN in the ignored .env. The configured local server listens on loopback. For unattended recovery, run `pnpm worker` in another terminal and restart the worker after code changes.

Local generated account credentials are in `tmp/database-fixtures/demo-accounts.json`. Open that ignored file privately and use the email/password for the required role. Passwords are not embedded in the interface, screenshots, repository, or this guide. Opening a private/incognito window allows the reviewer and surveyor sessions to coexist. Logging into a second account in the same browser context replaces that context's session.

## Surveyor workflow

1. Open Records. Filter by a literal record ID/species fragment, health, and active/retired status. Results use bounded pages; the page count is not a total dataset count.
2. Open a record. Inspect its accepted values, immutable version history, and latest value provenance. Download a snapshot containing its exact base version and campaign. Viewing an older version changes the displayed snapshot; the provenance panel remains explicitly labelled as the latest accepted version.
3. Choose Draft from this version. Select a form and create the draft. Each field has three distinct actions: No proposal, Set a value, or Clear to unknown. Zero and false are valid values. An omitted field leaves the accepted value alone.
4. Enter the claimed observation time. The v2 form also supports repeated categorized notes with their own timestamps. These notes support a decision; they do not update scalar values automatically. Dates are shown/edited in local time and submitted with an explicit UTC offset. Unedited source timestamps are retained.
5. Save the draft. Partial drafts are allowed. Download upload file produces a JSON array from a complete saved envelope, retaining its logical request ID and base. Unsaved changes disable finalization and download; browser-close/reload protection is enabled while edits are dirty. In-app navigation can discard unsaved edits, so save before leaving.
6. Finalize the saved revision. Compatible fields publish together; competing fields wait for review. Sealed content cannot be edited. Follow the submission outcome to inspect per-field results, warnings, and original source observations.
7. For delayed uploads, use Batch uploads to select a prepared JSON array. Every item has an independent result and the durable batch receipt can be reopened. Correcting sealed source content requires a new logical submission, rather than editing its original evidence.

Drafts and submissions are owner-scoped. All authenticated roles can read the accepted records; other surveyors cannot inspect an owner's drafts, private source envelopes, or batch memberships.

## Reviewer workflow

1. Open Review queue. Filter pending fields by record reference, field, surveyor, and receipt-time interval.
2. Choose Compare to inspect the base/current/proposed values and original supporting evidence. Each field receives its own disposition.
3. Accept the proposal, keep the current value, or supply a valid replacement. A reason is required for every decision, including an explicit clear to unknown.
4. If the accepted record or pending revision changed, the decision is blocked. Choose Refresh comparison, inspect the changed context, and enter a fresh reason. The interface never silently changes an approval's version tokens and resubmits it.
5. Follow the saved outcome or record history to inspect the result and reviewer-linked provenance.
6. Reports & exports separates SQL accepted/workflow totals from MongoDB stored-evidence counts. The reads are independent. Unavailable evidence is labelled unavailable, not replaced by zero. CSV/JSON downloads export up to 5,000 matching latest records; larger results require narrower filters.
7. Recovery displays safe job status and event history. A reasoned retry schedules inspection of the same evidence; it cannot rewrite source content, interrupt a live worker claim, or reschedule a completed job. A worker must be running for queued work to proceed.

## Retry behavior

Decisions retain their complete canonical command and captured comparison in per-user, versioned sessionStorage before submission. An unconfirmed response locks the command. Retry exact decision sends the identical request ID, values, reason, and version references. After a page reload, an Unconfirmed decisions banner can resume that command even when a committed field has left the queue. Finalization similarly retains the saved revision; repeated finalization returns the original outcome.

The same unchanged upload file retains a batch transport key in the current browser tab's sessionStorage. Original logical submission IDs also prevent duplicate effects. File content itself is kept only in memory; reselect the original file after a page reload. Batch metadata stores a file hash, name, and identity, not its raw evidence. No password or session token is stored in web storage.

SessionStorage is a convenience for retry continuity, not authoritative storage. Clearing it, closing the tab, switching browsers, or disabling browser storage can remove pending retry information. Inspect stored outcomes before beginning another decision. The SQL/MongoDB receipts and constraints remain authoritative. Full offline editing, service workers, and automatic background browser synchronization are outside this MVP.

## Interface read models

Migration 009 adds five guarded SQL read functions; it adds no tables. The HTTP additions are:

| Operation | Meaning and access |
|---|---|
| GET /api/submissions | Latest 100 visible submissions; optional record_id/state; own surveyor or all reviewer |
| GET /api/batches | Latest 100 visible batch summaries; own surveyor or all reviewer |
| GET /api/reviews/authors | Pending-source author names/references; reviewer only |
| GET /api/reviews/:id | One current pending comparison, author label, and base version; reviewer only |
| GET /api/drafts/:id | Existing own draft plus its immutable base snapshot |

Record-label enrichment keeps external DEMO identifiers readable in draft cards and review rows. Read models do not expose password hashes, session hashes, worker credentials, or lease tokens. Role gates provide navigation feedback; API and SQL checks enforce authorization independently. Client-side JSON validation shares a browser-safe exact-number parser with the backend; hashing and database connections remain server-only.

## Browser verification

Install the test browser once, within the ignored workspace directory:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) 'tmp\playwright-browsers'
pnpm exec playwright install chromium
pnpm build
pnpm test:browser
```

The browser runner provisions unique PostgreSQL/MongoDB test databases on the local development services and starts a temporary production Next.js server on 127.0.0.1:3100. It does not mutate development business records. Provisioning uses administrator credentials; application requests use restricted API credentials. The temporary server/browser are closed at completion. Run test:api and test:browser sequentially because they share port 3100 and provision the same restricted login roles. A production build must precede either test.

The successful run is recorded in `output/browser/verification.json`, with individual workflow/accessibility results in `output/browser/checks.json`. Screenshots are in the same directory. These checks combine browser actions, API responses, SQL versions/decisions, and MongoDB evidence. They cover compatible/conflicting stale-base proposals; explicit null/false/zero; stale review rejection; response loss after commit and exact retry, including review reload; mixed batch replay; history/provenance; exports; role denial; draft deletion; keyboard focus; mobile navigation; and session revocation.

Automated axe WCAG A/AA checks run on representative rendered pages. They are useful evidence, not a complete accessibility certification or a substitute for manual assistive-technology testing. The separate [acceptance suite](FieldMerge_Acceptance.md) now maps and passes all 35 functional scenarios; this browser suite remains representative UI coverage. Performance/query-plan evidence, broader outage/security coverage, final design/report reconciliation, and viva/submission preparation remain separate work.
