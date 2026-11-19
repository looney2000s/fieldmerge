# FieldMerge

Conflict-safe reconciliation of delayed urban tree survey updates.

Surveyors propose changes from a recorded base version. FieldMerge publishes compatible changes, holds competing values for reviewer decisions, and retains accepted history, original evidence and field-level provenance.

**[Project report (PDF)](output/pdf/FieldMerge_Project_Report.pdf)** - includes the author-supplied Chen ER diagram on page 9, database design, implementation, queries, screenshots, testing results, the complete data dictionary and foreign-key relationships.

## Technology

- Next.js and React for the interface; Next.js Route Handlers on Node.js for the API.
- PostgreSQL for accepted versions, proposals, decisions, sessions, transactions and integrity.
- MongoDB for source submissions, versioned forms, repeated evidence and editable drafts.
- Docker Compose for the database services; pnpm for application dependencies.

The database design uses 17 SQL tables, four views and three MongoDB collections. Transactions, guarded functions, triggers, indexes, CTEs, recursive/window queries and document aggregation support the workflow.

## Requirements

- Windows PowerShell, Node.js 22 or later and pnpm 11.
- Docker Desktop running with Linux containers and Docker Compose.
- Internet access for the initial image and dependency downloads.

## Setup

Clone this repository and open PowerShell in its root directory:

```powershell
git clone https://github.com/looney2000s/fieldmerge.git
cd fieldmerge
.\scripts\database.ps1 Setup
pnpm install --frozen-lockfile
pnpm configure:backend
pnpm dev
```

Open **http://localhost:3000**, matching `APP_ORIGIN` in the generated private `.env` file. Keep the application terminal running.

For unattended recovery, open a second terminal in the same directory:

```powershell
pnpm worker
```

Setup creates the schemas and synthetic starting records, provisions surveyor/reviewer fixtures, and verifies isolated test databases. Rerunning Setup preserves existing accepted records and checks applied migration checksums. `configure:backend` provisions restricted API/worker database access; the web server does not use database owner/root credentials.

If PowerShell blocks the setup script:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\database.ps1 Setup
```

For an already configured checkout, start the databases with `.\scripts\database.ps1 Start`, then run `pnpm dev` and `pnpm worker`. Stop services with `.\scripts\database.ps1 Stop`; existing database volumes are preserved.

## Accounts and usage

Setup generates one surveyor and one reviewer account. Open `tmp/database-fixtures/demo-accounts.json` privately for their email/password values. Keep this file when retaining existing database volumes: regenerating it does not reset stored passwords. Registration, password-reset and account-management screens are outside this version.

- **Surveyor:** open Records, select a tree and choose **Draft from this version**. Select which fields to propose, enter an in-campaign observation time, save and finalize. Inspect the resulting submission and any pending fields. A complete saved draft can also be downloaded as a JSON upload file for Batch uploads.
- **Reviewer:** open Review queue, compare the base/current/proposed values, choose accept, keep current or replace, and supply a reason. Refresh a stale comparison before making a new decision.
- **History:** inspect the record's accepted versions and provenance. An unchanged retry returns the earlier outcome rather than publishing twice.

Use a normal browser window for one role and a private/incognito window for the other. An omitted field makes no proposal; explicit null means unknown; zero and false are valid known values. Finalized evidence and accepted history cannot be edited through ordinary application operations.

## Verification

With Docker running and setup complete:

```powershell
pnpm test:unit
pnpm build
pnpm test:api
pnpm test:acceptance
pnpm test:security
```

For browser checks, install Chromium once and then run:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) 'tmp\playwright-browsers'
pnpm exec playwright install chromium
pnpm test:browser
```

Run the API/security/browser suites sequentially after building; they share temporary port 3100 and use isolated test databases. The acceptance suite uses disposable services. Generated results remain local under ignored `output` directories. The final PDF contains the recorded verification results and their limits; publishing source does not mean every suite ran again for that publication.

Runnable SQL and MongoDB query examples are in `database/demonstrations`. To generate isolated query measurements:

```powershell
pnpm db:evidence
pnpm db:evidence:summary
```

The measurement runner uses a separate temporary Compose project. Results are synthetic, warmed local database measurements, not production-capacity claims. SQL staging DDL/DML preserves accepted history.

## Database documentation

- [Requirements and acceptance scenarios](docs/FieldMerge_Requirements.md)
- [Application architecture](docs/FieldMerge_Architecture.md)
- [Relational schema and constraints](docs/FieldMerge_Relational_Schema.md)
- [Complete SQL data dictionary](docs/FieldMerge_Data_Dictionary.md)
- [MongoDB model and database justification](docs/FieldMerge_MongoDB_Model.md)

The physical schema catalog is `output/design/schema-catalog.json`. SQL definitions live in ordered migrations under `database/postgres/migrations`; MongoDB validators and initialization are under `database/mongodb`. Add a new migration instead of modifying an already-applied file. `pnpm design:export` refreshes the metadata catalog and dictionary from running local databases.

## Configuration and scope

PostgreSQL runs on `127.0.0.1:15432`; MongoDB runs on `127.0.0.1:27018`. Generated secrets stay in ignored `.env` and `tmp` files. Do not publish them or put administrator credentials in the browser.

The project covers one configured survey campaign, known tree identities, four accepted fields and two form versions. It supports delayed uploads rather than a complete offline application. Reviewer decisions establish accepted project data, not biological truth. The worker must run for automatic recovery. Hosted deployment, supervised operations and backup/restore verification are separate operational work.
