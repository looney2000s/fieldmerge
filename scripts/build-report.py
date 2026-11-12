"""Build the implementation report with the bundled python-docx runtime.
Run using the Python path returned by Codex load_workspace_dependencies.
Catalog export and existing verification artifacts are inputs; no database mutation.
"""
from pathlib import Path
import json, re, html
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[1]
def load(path): return json.loads((ROOT/path).read_text(encoding='utf-8-sig'))
schema=load('output/design/schema-catalog.json')
design=load('output/design/verification.json')
acceptance=load('output/acceptance/verification.json')
security=load('output/security/checks.json')
assert acceptance['status']=='passed' and acceptance['cleanup_completed']
assert security['passed']==23 and design['applied_migration_checksums_match']
BASE=schema['implementation_commit'][:7]
OUT=ROOT/'output/documents/FieldMerge_Implementation_Report.docx'
TMP=ROOT/'tmp/implementation-report'; TMP.mkdir(parents=True,exist_ok=True)

# Code-native architecture diagram. Shared SVG/PNG layout avoids an image-generation dependency.
W,H=1500,950
im=Image.new('RGB',(W,H),'white'); draw=ImageDraw.Draw(im)
font_path=Path('C:/Windows/Fonts/calibri.ttf')
font=ImageFont.truetype(str(font_path),28); small=ImageFont.truetype(str(font_path),24)
svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="950" viewBox="0 0 1500 950"><rect width="1500" height="950" fill="white"/>']
def box(x,y,w,h,lines):
 draw.rounded_rectangle((x,y,x+w,y+h),radius=14,fill='#f2f5f4',outline='#294b41',width=3)
 svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="#f2f5f4" stroke="#294b41" stroke-width="3"/>')
 for n,line in enumerate(lines):
  yy=y+27+n*37
  draw.text((x+w/2,yy),line,font=font,fill='#18342c',anchor='mt')
  svg.append(f'<text x="{x+w/2}" y="{yy+25}" text-anchor="middle" font-family="Calibri,Arial,sans-serif" font-size="28" fill="#18342c">{html.escape(line)}</text>')
def arrow(x1,y1,x2,y2,label=None):
 draw.line((x1,y1,x2,y2),fill='#445650',width=3)
 if x1==x2:
  offset=-14 if y2>y1 else 14
  pts=[(x2,y2),(x2-8,y2+offset),(x2+8,y2+offset)]
 else: pts=[(x2,y2),(x2-14,y2-8),(x2-14,y2+8)] if x2>x1 else [(x2,y2),(x2+14,y2-8),(x2+14,y2+8)]
 draw.polygon(pts,fill='#445650')
 svg.append(f'<path d="M{x1} {y1} L{x2} {y2}" stroke="#445650" stroke-width="3"/><polygon points="'+ ' '.join(f'{x},{y}' for x,y in pts)+'" fill="#445650"/>')
 if label:
  lx,ly=(x1+x2)/2+120,(y1+y2)/2
  draw.text((lx,ly),label,font=small,fill='#33443d',anchor='mm')
  svg.append(f'<text x="{lx}" y="{ly+8}" text-anchor="middle" font-family="Calibri,Arial,sans-serif" font-size="24">{html.escape(label)}</text>')
box(350,20,800,115,['Surveyor and reviewer browsers','Next.js interface and opaque session cookie'])
box(350,205,800,150,['Next.js server route handlers','Origin, body, session and role validation','Intake, drafts, reports and safe error mapping'])
box(55,465,650,175,['PostgreSQL guarded functions','Accepted versions, field changes, decisions','Sessions, batches, recovery jobs and safe events','Record locks and commit-time integrity'])
box(795,465,650,175,['MongoDB restricted service access','Sealed source envelopes and form definitions','Owner-scoped editable or sealed drafts','Exact canonical source and evidence aggregates'])
box(350,745,800,150,['Separate recovery worker process','Bounded claims, fencing, retries and quarantine','Resumes verified intake and sealed finalizing drafts'])
arrow(750,135,750,205,'HTTP API')
arrow(500,355,500,465,'Session-aware SQL')
arrow(1000,355,1000,465,'Verified document I/O')
arrow(510,745,510,640)
arrow(990,745,990,640)
svg.append('</svg>')
(ROOT/'output/design/architecture.svg').write_text(''.join(svg),encoding='utf-8')
im.save(TMP/'architecture.png')

pages=[]
def page(title,blocks): pages.append((title,blocks))
def p(text): return ('p',text)
def bullets(*items): return ('list',list(items))
def table(headers,rows,widths=None): return ('table',(headers,rows,widths))
def code(text): return ('code',text)
def image(path,width,caption,crop=None): return ('image',(path,width,caption,crop))

page('FieldMerge Implementation Report',[
 p('Conflict safe reconciliation of delayed urban tree survey updates'),
 p('DBMS Level 3 project | Solo implementation | 12 November 2026'),
 p(f'Implementation baseline {BASE} on codex/security-boundaries. PostgreSQL migrations 001 through 010 and the matching MongoDB model are implemented. The report documents the working local system, its design and the limits of its recorded evidence.'),
 ('h2','Project summary'),
 p('FieldMerge preserves a shared accepted tree record when different surveys arrive from older versions. It publishes compatible scalar changes, holds competing proposals for review, and retains the source evidence and value origins needed to explain each outcome. A reviewer resolves pending fields using explicit version and revision checks.'),
 ('h2','Problem statement'),
 p('Surveyors revisiting the same urban trees can prepare observations from different copies of a record and upload them later. If receipt order decides the accepted value, a delayed proposal can overwrite a more recent accepted change even when the observer did not see it. Coordinators also need to distinguish harmless independent edits from competing values and to trace a chosen value to its source. FieldMerge solves this bounded data-reconciliation problem for identified trees by linking every proposal to an accepted base version, checking intervening field history, and requiring reasoned review before conflicting values are published.'),
 ('h2','Objectives'),
 bullets('Preserve accepted changes when delayed proposals affect independent fields.', 'Prevent changed-content retries and repeated uploads from producing duplicate effects.', 'Retain sealed source evidence and field-level publication provenance.', 'Make conflicting decisions explicit, authorized and atomic.', 'Demonstrate relational integrity and meaningful document operations through a usable Next.js interface.'),
 p('Verified baseline: 17 PostgreSQL tables, 146 columns, 29 foreign keys, four views and three MongoDB collections. All 35 functional acceptance scenarios pass. The complete physical dictionary is included in the appendix and in docs/FieldMerge_Data_Dictionary.md.')
])
page('Motivation and concrete scenario',[
 p('ODK documents parallel entity updates prepared from older versions and an arrival-order update policy with conflict warnings [1]. This establishes a documented operational situation and a comparison point. Its form audit log also records who changed answers, when and why, supporting the usefulness of traceable evidence [2]. These sources do not establish the prevalence or financial cost of this problem for a particular municipal team.'),
 p('A possible current workaround is to compare exported spreadsheets or review a version history after an overwrite. That is a project hypothesis, not an interview finding. The technical weakness of manual comparison is reproducible: the reviewer must reconstruct the base, current state and intervening edits before deciding whether an older proposal is compatible.'),
 table(['Step','Accepted state or proposal','FieldMerge outcome'],[
 ['1','Version 1: health Good and diameter 30 cm.','Two surveyors prepare proposals from version 1.'],
 ['2','Surveyor A submits diameter 31 cm.','Version 2 publishes diameter 31 cm.'],
 ['3','Surveyor B submits health Fair and diameter 32 cm from version 1.','Health can publish while diameter stays pending.'],
 ['4','Reviewer sees base 30, current 31 and proposed 32 cm.','A reasoned decision creates a new version only if the chosen value differs.'],
 ['5','The same proposal or decision is retried unchanged.','The original receipt returns; no duplicate publication occurs.']
 ]),
 ('h2','Distinctive contribution'),
 p('The contribution is the implemented combination of conservative field-history classification, partial publication, immutable evidence, reasoned review, exact retry identity and recoverable coordination between SQL and MongoDB. A change that was made and later reversed still counts as an intervening edit. Neither client timestamps nor upload order settle disputed truth.'),
 p('Relative to the documented ODK arrival-order behavior, FieldMerge holds competing changed values before publication. This is a difference in the selected workflow, not a claim that conflict resolution is globally new or that existing products cannot support alternative policies. The project makes no first-ever or market-gap claim.'),
 ('h2','Why the scope is viable'),
 p('The prototype works with known record IDs and deterministic synthetic fixtures. It needs no private lab access, specialized hardware, paid service, machine-learning training or large user community. Synthetic data demonstrates correctness; it is not evidence of real-world demand.')
])
page('Scope roles and functional requirements',[
 p('The MVP covers one configured campaign, two controlled form versions and four canonical scalar fields. Delayed upload is supported through saved drafts, exact snapshots and JSON batch files. A complete offline browser application is outside scope.'),
 table(['Requirement','Implemented behavior'],[
 ['Authentication','Seeded surveyor/reviewer accounts; salted password hashes and revocable opaque sessions.'],
 ['Accepted records','Bounded literal filtering, current/historical snapshots and downloads.'],
 ['Drafts','Surveyor-owned create/read/revision-safe edit/delete while editable.'],
 ['Finalization','Seal one draft revision and submit its unchanged identity/content.'],
 ['Reconciliation','Validate the entire proposal; publish compatible fields and retain competing values.'],
 ['Reviewer decisions','Accept proposal, keep current or replace; require reason and fresh version/revision tokens.'],
 ['History and provenance','Inspect immutable snapshots and per-field source/decision origins.'],
 ['Batches','Up to 100 independent positions with stable manifests and durable receipts/errors.'],
 ['Reports and exports','SQL accepted-state summaries plus MongoDB evidence aggregates; bounded CSV/JSON exports.'],
 ['Recovery and failure evidence','Bounded worker retries/quarantine and reviewer operational inspection; independent safe failure events.']
 ]),
 table(['Role','Permitted responsibility'],[
 ['Surveyor','Read accepted records; manage own editable drafts; submit/retry proposals; inspect own evidence and outcomes.'],
 ['Reviewer','Read all source/outcome context, resolve pending fields, inspect summaries, recovery jobs and bounded failure events.']
 ]),
 p('Neither role may rewrite accepted history, sealed evidence or earlier decisions. Reviewers do not generally read other users\' unfinished drafts. Self-registration, account-management screens, entity matching, maps, species diagnosis, AI adjudication, arbitrary nested merging and multiple organizations are excluded.')
])
page('System architecture and authentication flow',[
 image('tmp/implementation-report/architecture.png',6.6,'Figure 1  Implemented server and database responsibilities'),
 p('Only the server connects to databases. It verifies an exact configured Origin on writes, bounds the incoming bytes, rejects malformed/ambiguous JSON, and authenticates the opaque cookie. PostgreSQL session-aware wrappers resolve the actor from the session hash; client-supplied author/reviewer identities cannot confer authority.'),
 p('The API and worker have separate restricted SQL/MongoDB credentials in private environment configuration. The API has no direct SQL business-table access and cannot assume the non-login publication role. No PostgreSQL row-level security is claimed: denied table access and guarded functions are the chosen mechanism.'),
 p('Source intake reserves an SQL identity, stores/verifies a sealed document, then publishes within a local SQL transaction. The separate worker resumes incomplete work. There is no distributed transaction or browser connection to either database. Successful local SQL commit does not imply that an HTTP response reached the user.')
])

inventory=[('fieldmerge',x) for x in ['app_users','survey_campaigns','tree_records','accepted_versions','form_versions','submissions','field_changes','review_decisions','audit_events']]+[(t['schema'],t['name']) for t in schema['tables'] if t['schema']!='fieldmerge']
purposes={
 'app_users':'User identities and application roles','survey_campaigns':'Campaign window and source attribution','tree_records':'Stable campaign-scoped tree identity','accepted_versions':'Immutable typed accepted snapshots','form_versions':'Registered immutable document forms','submissions':'Verified intake, retry identity and receipts','field_changes':'Per-field proposal and disposition','review_decisions':'Terminal reviewer intent and receipt','audit_events':'Committed business-workflow evidence','sessions':'Hashed opaque session references','login_attempts':'Authentication-attempt windows','migrations':'Applied version/checksum registry','batch_items':'Independent batch positions and outcomes','intake_batches':'Owner-scoped manifest identity','recovery_events':'Recovery activity history','recovery_jobs':'Durable scheduling, leases and fencing','security_events':'Independent safe HTTP failure evidence'}
page('Relational design and schema inventory',[
 p('The conceptual business design has nine entities. ACCEPTED_VERSION is identified by its owner TREE_RECORD and the partial key version_no; the SQL primary key is (record_id, version_no). Campaigns contain records, users author submissions, submissions contain field changes, and a field change has at most one terminal decision. The completed Chen diagram is maintained separately.'),
 table(['Schema','Relation','Responsibility'],[[a,b,purposes[b]] for a,b in inventory]),
 p('The physical implementation adds two authentication tables, five operational/transport tables and one migration registry. These support the application without changing the nine-entity business scope. Composite same-tree foreign keys and linear predecessor constraints protect version/decision origins. The appendix lists all 146 columns; the companion catalog contains all 239 constraints and complete definitions.'),
 p('The 29 foreign keys are physical constraints, not 29 distinct Chen relationship types. A nullable origin reference permits the baseline. A deferred trigger requires every committed tree to have version 1; an ordinary child foreign key alone cannot enforce that participation rule.')
])
page('Data semantics and normalization',[
 table(['Canonical field','Allowed representation','Meaning'],[
 ['species','Text up to 120 characters or null','Trim/collapse whitespace for comparison; no fuzzy matching or case inference.'],
 ['health','Good, Fair, Poor or null','Controlled category, not a diagnosis.'],
 ['diameter_cm','Exact numeric 0–999999.99 with at most two fractional digits, or null','Storage bound, not biological plausibility. Zero is known data.'],
 ['guard_damage','Boolean or null','False is a known negative report. Null means unknown.']
 ]),
 p('An omitted patch field makes no proposal. Explicit JSON null requests an unknown value. Typed JSON scalar values in field_changes are never SQL NULL; an absent applied_version_no is SQL NULL because no snapshot applied that change. Unknown keys, string booleans and excess decimal precision are rejected.'),
 ('h2','Keys and deliberate redundancy'),
 p('Request identities are unique per authenticated author; decisions are unique per reviewer retry identity and terminal change. Version identity is composite within a tree. record_id is deliberately repeated on field_changes and review_decisions to support declarative same-tree composite foreign keys. These physical tables should not be advertised as strictly third normal form because the guard column is derivable through the parent. Removing it would require another enforcement mechanism.'),
 p('Full immutable snapshots repeat carried values to make accepted reads straightforward. Publication records provenance only for actual changes, so carrying an unchanged field does not steal its source. Current values are not duplicated as mutable columns on tree_records.'),
 ('h2','Executable dictionary'),
 p('output/design/schema-catalog.json captures exact types, nullability, defaults, keys, constraints, indexes, views, explicit triggers, function signatures and MongoDB validators/indexes. It exports no application rows. docs/FieldMerge_Data_Dictionary.md adds a meaning for every column and complete constraint/index definitions. All ten applied migration checksums matched their source files at reconciliation.'),
 p('The baseline has 43 indexes including constraint-supporting indexes, 26 explicit noninternal triggers and 60 functions including helpers. These object counts describe structure, not feature counts or performance guarantees.')
])
page('MongoDB model and database justification',[
 table(['Collection','Responsibility','Permitted mutation'],[
 ['submission_documents','Sealed source envelope, canonical JSON, optional evidence and metadata. _id matches SQL submission_id.','Insert/read; no source rewrite or delete through ordinary service roles.'],
 ['form_definitions','Immutable controlled form definitions agreeing with the SQL registry hash.','Read published definitions; a new definition requires a new version.'],
 ['submission_drafts','Owner-scoped partial envelope, revision, lifecycle and final submission reference.','Create/read/edit/delete while editable; seal before finalization.']
 ]),
 p('PostgreSQL is appropriate for ordered accepted versions, same-record references, uniqueness, authorization and atomic publication. MongoDB is useful for retaining complete versioned source envelopes with optional repeated evidence and metadata, and for draft document operations and aggregation. It does not independently determine accepted truth.'),
 ('h2','Source envelope'),
 code('{\n  "_id": "server submission UUID",\n  "author_id": "authenticated author UUID",\n  "record_id": "known tree UUID",\n  "form_version": "tree-v2",\n  "payload_hash": "canonical content SHA-256",\n  "canonical_payload_json": "deterministic client envelope",\n  "payload": {"patch": {"diameter_cm": 31.25},\n              "observations": [{"category": "trunk",\n                                "note": "Measurement context"}]}\n}'),
 p('This shortened illustration is not a valid executable input: required request/base/timestamp fields are omitted for readability. Actual validators use lowercase UUID strings, BSON dates and Decimal128. The canonical JSON retains exact numeric content and original timestamp spelling beyond BSON millisecond precision.'),
 p('Indexes support unique author/request lookup, record/time and form/time reads, batch grouping, owner/state draft lists and finalizing-draft discovery. MongoDB aggregates group forms/batches, unwind observations and distinguish field presence from explicit null. SQL foreign keys cannot cross into MongoDB: the server verifies identity, canonical content and matching form hashes before publication.')
])
page('Automatic reconciliation and SQL integrity',[
 p('The server validates the complete envelope before deriving the verified scalar projection. Reconciliation locks the tree identity row, rereads the current accepted snapshot and inspects actual field changes between the submitted base and current version. Classification and any publication occur within one SQL transaction.'),
 table(['Condition for a supplied field','Disposition'],[
 ['Proposed value equals the base value','No-change proposal; do not revert a later current value.'],
 ['Proposed value is already represented by current state','No extra publication and no provenance takeover.'],
 ['No intervening accepted edit to the field','Compatible change, unless a clock/campaign warning holds it.'],
 ['An intervening accepted edit conflicts with the proposal','Pending reviewer decision.'],
 ['The field changed and then returned to its base value','Still treated as intervening history; equal endpoints alone are insufficient.'],
 ['Any supplied scalar is invalid','Reject the item without partially publishing its otherwise valid fields.']
 ]),
 p('Compatible fields in a valid item publish together; competing fields remain pending in the same receipt. If no accepted scalar changes, no new version is created. Every accepted snapshot change must have the matching applying field-change link. Deferred consistency triggers check origins, decisions, receipts, live states and audit evidence at transaction completion.'),
 ('h2','Retry identity'),
 p('The authenticated author plus client_submission_id identifies a logical proposal. A deterministic canonicalizer sorts keys while preserving exact scalar/string/array content, rejects duplicate JSON keys, and fingerprints the client envelope. An unchanged retry returns the original reconciliation receipt. Changed content under the same identity fails, including changed supporting evidence or metadata. Transport batch identity is separate.'),
 p('The SQL chain has a same-tree predecessor reference and predecessor arithmetic. Publication locks serialize next-version assignment. Immutable-history triggers and denied direct grants block ordinary rewrite/delete paths; they do not prevent a privileged database administrator from changing the system.')
])
page('Review recovery and safe failure evidence',[
 ('h2','Reviewer publication'),
 p('A reviewer supplies the pending change revision, accepted version, chosen action, nonempty reason and stable client decision identity. The protected function locks the record/change and checks the current context again. A stale action fails rather than silently rebasing. accept_proposal or replace creates a new version only when its chosen value differs; keep_current closes the change without inventing a version.'),
 p('Decision receipt, field disposition, version, provenance and business audit evidence commit together. A repeated identical command returns its earlier receipt. There can be only one committed terminal decision for a proposed field.'),
 ('h2','Recoverable two store coordination'),
 p('Intake reserves the SQL identity before document insertion and verification. Recovery jobs persist independently of a browser session. Bounded claims, token fencing, retry scheduling and quarantine prevent an expired worker from committing as a later claimant. A worker discovers sealed finalizing drafts and resumes the same content. It cannot overwrite a conflicting sealed document or reinterpret it as a new request.'),
 p('The design deliberately avoids two-phase commit. A temporary awaiting_document state can exist, and a committed result can outlive a lost response. Source identity/hash checks and unchanged retries make these states recoverable. The worker must run for unattended progress; it is not installed as a supervised service.'),
 ('h2','Failure evidence and web boundary'),
 p('Handled HTTP failures receive a server-generated X-Request-Id and an independent SQL event after business rollback. Reviewer reads are bounded to 1–100 events. When SQL logging fails, closed-field JSONL fallback files are appended and synced. Bodies, raw URLs/queries, emails, passwords, cookies, tokens, session hashes and raw exception messages are excluded.'),
 p('Fallback allocation is capped at three 5 MiB segments per UTC day and process, with no overwrite. Total retention across days/restarts needs operator management. If both SQL and file persistence fail, a fixed diagnostic is emitted and the original denial still returns. Framework failures outside wrapped handlers and batch-item errors in HTTP 207 are outside this HTTP-failure logger; batch receipts retain their own item outcomes.')
])
page('Advanced database concepts and query demonstrations',[
 table(['Concept','Implemented use or evidence'],[
 ['Transactions and row locks','Atomic accepted publication/review; real lock-controlled races.'],
 ['Stored functions','reconcile_submission, review_change and restricted session-aware wrappers.'],
 ['Triggers','Immutable history; deferred cross-relation integrity at commit.'],
 ['Views','Latest accepted records, pending reviews, submission outcomes, field provenance.'],
 ['CTEs and recursion','Pending workload aggregation and bounded version-parent traversal.'],
 ['JOIN and correlated subquery','Author/current comparison and records with pending species proposals.'],
 ['Window functions','LAG identifies intervening changes, including reversals.'],
 ['Indexes and plans','SQL record/time history and MongoDB record/time evidence lookup.'],
 ['NoSQL aggregation and RUD','Evidence forms/categories/presence; owner/state-aware draft read/update/delete.']
 ]),
 p('The executable SQL catalog contains Q01–Q12 and the MongoDB catalog contains M01–M04. This workload query combines a CTE, GROUP BY, HAVING, JOIN and ordering:'),
 code('WITH workload AS (\n  SELECT record_id, count(*) AS pending_fields\n  FROM fieldmerge.field_changes WHERE state = \'pending\'\n  GROUP BY record_id HAVING count(*) > 1\n)\nSELECT r.source_record_id, w.pending_fields\nFROM workload w\nJOIN fieldmerge.tree_records r USING (record_id)\nORDER BY w.pending_fields DESC, r.record_id LIMIT 20;'),
 p('Administrative inspection connections execute raw SQL demonstrations; the API login cannot directly read these tables. Meaningful INSERT/UPDATE/DELETE operates through guarded workflow transitions and editable MongoDB drafts. CREATE/ALTER/DROP and staging DML are demonstrated in a rolled-back disposable SQL sandbox, preserving immutable accepted history and sealed evidence.')
])
page('Verification results and practical limits',[
 p('Recorded tests use real PostgreSQL/MongoDB and a production Next.js server where applicable. Synthetic fixtures and disposable fault injection are separated from development business records. The counts below belong to distinct suites and are not additive guarantees.'),
 table(['Suite','Recorded outcome','Evidence directory'],[
 ['Database structure and workflows','231 assertions; four actual COMMIT cases; six concurrent SQL scenarios; matching forms','output/database'],
 ['Validation export and logging units','18 passing groups','Tests run with pnpm test:unit'],
 ['API worker and query integration','33 passing groups','output/api'],
 ['Functional acceptance','All AC01–AC35 pass; disposable cleanup completed','output/acceptance'],
 ['Interface','15 browser workflows; nine representative axe checks; no recorded runtime errors','output/browser'],
 ['Transport and security','23 API groups plus five browser checks pass','output/security'],
 ['Query and performance evidence','21 checks pass on a larger synthetic fixture','output/performance'],
 ['Design reconciliation','17 tables / 146 column meanings; ten applied migration checksums match','output/design']
 ]),
 ('h2','Representative fault checks'),
 p('Coverage includes concurrent proposals/reviewers, SQL rollback, lost successful responses, an actual MongoDB service pause, worker process kill/restart, stale/expired claims, wrong-role/owner denial, changed-content retries, exact transport caps, invalid UTF-8/duplicate keys and stored markup rendered as text.'),
 p('Testing found and corrected valid maximum-diameter rejection caused by double-valued MongoDB bounds, recursive parser stack exhaustion on excessive nesting, inconsistent empty-body classification, and acceptance error distinctions for missing bases and unknown patch fields.'),
 p('The production build passed. Source-checksum manifests identify selected tested files and all migrations; they are not signed attestations. Tests are targeted rather than exhaustive. Automated accessibility scans are representative. No production deployment, disaster recovery, disk-loss durability, multi-node partition or hostile-administrator guarantee is claimed.')
])
page('Measured query behavior',[
 p('The saved warmed local benchmark used 10,003 synthetic accepted records, 14,308 immutable snapshots and 4,504 matching SQL/MongoDB sources. It also contains 12,006 field changes, 3,599 pending fields, 402 decisions and 5,501 supporting observations. The generated history used normal guarded workflow functions.'),
 table(['Read comparison','Client median','Inspection evidence'],[
 ['SQL Q03 with record/receipt index','0.932 ms','5 root shared buffer hits plus reads; one server EXPLAIN 0.046 ms.'],
 ['SQL Q03 with that index absent','1.063 ms','79 root shared buffer hits plus reads; one server EXPLAIN 0.163 ms.'],
 ['MongoDB M01 forced natural scan','2.975 ms','4,504 documents examined for three returned references.'],
 ['MongoDB M01 record/time index hint','1.414 ms','Three documents and three keys examined for the same references.']
 ]),
 p('Each normal read had two warm-ups and nine measured executions from one client. SQL statistics were refreshed; scan alternatives were interleaved and restored in the disposable databases. Query plans, parameters, raw samples, versions and settings are saved, enabling inspection beyond elapsed time.'),
 p('The host was Windows 11 with an i5-13450HX and 23.7 GiB usable memory; Docker reported 11.5 GiB. The measured databases were PostgreSQL 18.6 and MongoDB 8.0.34. Times include driver/loopback overhead; one EXPLAIN sample is not a client median. With nine samples, the descriptive nearest-rank p95 equals the maximum and is not a reliable production tail estimate.'),
 p('The smaller SQL client-time difference is not evidence of a large website speedup. The narrower plan and reduced examined work provide a more direct explanation. Full-collection MongoDB aggregates are not claimed to benefit from a point-lookup index. These measurements exclude HTTP/browser concurrency and the later independent HTTP failure logger.'),
 p('Reproduce with pnpm db:evidence followed by pnpm db:evidence:summary. The benchmark uses a separate temporary Compose project and does not modify development business data. The complete report is output/performance/README.md; query/viva explanations are in docs/FieldMerge_Query_Demonstrations.md.')
])
page('Application screenshots',[
 image('output/browser/draft.png',6.5,'Figure 2  Surveyor draft detail showing explicit field intent',(278,385,1092,810)),
 image('output/browser/review.png',6.5,'Figure 3  Reviewer comparison and reasoned decision detail',(278,703,1402,1270)),
 p('These are screenshots from the passing browser workflow suite with synthetic records. Browser tests also inspect actual SQL/MongoDB outcomes, lost-response retries, stale actions, exports, keyboard access and a 390 px mobile layout. Screenshots illustrate the interface; assertions establish the tested behavior.')
])
page('Execution and demonstration',[
 p('Use Windows PowerShell, Node.js 22 or later, pnpm 11 and Docker Desktop with Linux containers. The repository pins the tested database image digests. From the project folder:'),
 code('powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\database.ps1 Setup\npnpm install --frozen-lockfile\npnpm configure:backend\npnpm dev'),
 p('Open http://localhost:3000, matching APP_ORIGIN. Open tmp/database-fixtures/demo-accounts.json privately for generated surveyor/reviewer logins. Keep the fixture file when preserving existing development volumes: regenerating it does not rotate stored account hashes. Never include it or .env in submission materials.'),
 p('Run pnpm worker in a separate terminal for unattended recovery. Use private/incognito browser contexts for separate roles. Setup verifies isolated test databases and applies ordered checksum-protected migrations without resetting existing records. Restart API/worker processes after code changes.'),
 ('h2','Core demonstration sequence'),
 bullets('Open a tree and prepare two drafts from the same base. Finalize a diameter-only change first.', 'Finalize the older-base draft with a different diameter and a health change. Show compatible health publication and pending diameter.', 'As reviewer, compare base/current/proposed values, enter a reason and resolve the pending field.', 'Show version history and field provenance; replay an unchanged upload and demonstrate no extra version.', 'Show a denied wrong-role request and its server correlation event; inspect a source document and independent evidence aggregate.'),
 p('The companion demonstration guide gives repeatability preconditions and evidence checkpoints. Development fixtures have three baseline records; larger examples use the disposable performance fixture. A clean-room release rehearsal, instructor format/deadline confirmation, and the actual demonstration/viva remain separate tasks.')
])
page('Limitations contribution and conclusion',[
 ('h2','Known limitations'),
 bullets('No technician interviews, municipal pilot or user study establishes local adoption or operational savings. Motivation is supported by public product documentation and a reproducible data problem.', 'One campaign, four scalars and two controlled forms bound the model. A complete offline app, entity matching, maps and biological assessment are excluded.', 'There is no distributed atomic commit. Temporary cross-store incompleteness is visible and recoverable through the running worker.', 'Local configuration is demonstrated. Hosted HTTPS, CSP/HSTS, service supervision, backups and restore rehearsal require separate operational work.', 'Targeted tests and local warmed query plans do not establish exhaustive security, complete accessibility or production capacity.'),
 ('h2','Solo contribution and provenance'),
 p('The single-developer project scope includes problem definition, database design/migrations, authenticated API, Next.js workflows, recovery, query analysis, tests and documentation. Git records the progression from the database baseline through interface, acceptance, performance and security milestones. Attribution should describe the actual tooling and assistance used; commit history alone does not certify independent authorship or instructor approval of the solo arrangement.'),
 ('h2','Conclusion and future enhancements'),
 p('The implemented system demonstrates that delayed proposals can preserve independent accepted changes while holding disputed fields for an explicit decision. Databases enforce identity, history, atomicity and review context, while source documents retain optional evidence. A useful next extension is a documented public-data import mapping, followed by supervised worker deployment, backup/restore verification and user evaluation. These enhancements should preserve the existing provenance and retry guarantees.'),
 ('h2','Public references'),
 p('[1] ODK Documentation. Managing Entities in Central, sections on parallel updates and conflicts. https://docs.getodk.org/central-entities/ (consulted 12 November 2026).'),
 p('[2] ODK Documentation. Form Audit Log. https://docs.getodk.org/form-audit-log/ (consulted 12 November 2026).'),
 p('Implementation references: ordered SQL migrations, database/mongodb/model.js, the complete schema catalog/dictionary, and the recorded acceptance, browser, security and performance artifacts identified in this report. The conceptual ER diagram is a separate project deliverable.')
])

# Full typed appendix. Detailed CHECK, FK and index definitions stay in the catalog/dictionary.
groups=[['app_users','survey_campaigns'],['tree_records','accepted_versions'],['form_versions','audit_events'],['submissions'],['field_changes'],['review_decisions'],['sessions','login_attempts','migrations'],['intake_batches','batch_items'],['recovery_jobs'],['recovery_events','security_events']]
dictionary=(ROOT/'docs/FieldMerge_Data_Dictionary.md').read_text(encoding='utf-8')
meanings={}
for line in dictionary.splitlines():
 if line.startswith('| ') and not line.startswith('| Column'):
  cells=[x.strip() for x in re.split(r'(?<!\\)\|',line)[1:-1]]
  if len(cells)==6: meanings[cells[0]]=cells[-1].replace('\\|','|')
for n,names in enumerate(groups,1):
 blocks=[p('Exact column types and nullability from the reconciled PostgreSQL catalog. PK/UQ/FK labels indicate membership in potentially composite constraints; inspect the complete definitions in the companion dictionary. Y means SQL NULL is allowed.')]
 for name in names:
  t=next(t for t in schema['tables'] if t['name']==name)
  cs=[c for c in schema['constraints'] if c['schema']==t['schema'] and c['relation']==name]
  blocks += [('h2',t['schema']+'.'+name),p(purposes[name]+'.')]
  rows=[]
  for c in [c for c in schema['columns'] if c['schema']==t['schema'] and c['relation']==name]:
   keys='/'.join(dict.fromkeys({'p':'PK','u':'UQ','f':'FK'}[k['kind']] for k in cs if k['kind'] in ['p','u','f'] and c['name'] in k['columns']))
   typ=c['type'].replace('timestamp with time zone','timestamptz').replace('character varying','varchar').replace('character(','char(')
   meaning=meanings[c['name']].replace('are in CHECK constraints below','are in the companion CHECK definitions')
   rows.append([c['name'],typ,('Y' if c['nullable'] else 'N')+(' '+keys if keys else ''),meaning])
  blocks.append(table(['Column','Type','Null and keys','Meaning'],rows,[1.42,1.0,.72,3.46]))
  for c in cs:
   if c['kind'] in ['p','u']:
    blocks.append(p(c['definition']+'.'))
 page('Appendix '+str(n)+' SQL data dictionary',blocks)

doc=Document(); sec=doc.sections[0]
sec.page_width=Inches(8.27);sec.page_height=Inches(11.69)
sec.top_margin=Inches(.65);sec.bottom_margin=Inches(.65);sec.left_margin=Inches(.68);sec.right_margin=Inches(.68)
sec.footer_distance=Inches(.28)
styles=doc.styles
for name in ['Normal','Body Text','List Bullet']:
 styles[name].font.name='Calibri';styles[name].font.size=Pt(10.5)
 styles[name].paragraph_format.space_after=Pt(6);styles[name].paragraph_format.line_spacing=1.05
for name,size in [('Title',27),('Heading 1',19),('Heading 2',12)]:
 styles[name].font.name='Calibri';styles[name].font.size=Pt(size);styles[name].font.color.rgb=RGBColor(0,0,0)
 styles[name].paragraph_format.space_after=Pt(9);styles[name].paragraph_format.space_before=Pt(9 if name=='Heading 2' else 0)
 styles[name].paragraph_format.keep_with_next=True
 # Strip latent title/heading borders.
 for border in styles[name]._element.xpath('.//w:pBdr'):border.getparent().remove(border)
styles['Caption'].font.size=Pt(9);styles['Caption'].font.color.rgb=RGBColor(70,70,70)
footer=sec.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.RIGHT
run=footer.add_run();field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');run._r.addnext(field)
doc.core_properties.title='FieldMerge Implementation Report'
doc.core_properties.subject='Database design implementation and verification'
doc.core_properties.author='FieldMerge project author'
doc.core_properties.keywords='FieldMerge PostgreSQL MongoDB DBMS'

def add_table(headers,rows,widths,appendix=False):
 t=doc.add_table(rows=1,cols=len(headers));t.style='Table Grid';t.autofit=False
 widths=widths or ([1.45,1.55,3.6] if len(headers)==3 else [1.45,5.15] if len(headers)==2 else [1.2]*len(headers))
 total=sum(widths);widths=[v*6.9/total for v in widths]
 for i,w in enumerate(widths):t.columns[i].width=Inches(w)
 for i,h in enumerate(headers):t.rows[0].cells[i].text=str(h)
 repeat=OxmlElement('w:tblHeader');t.rows[0]._tr.get_or_add_trPr().append(repeat)
 for row in rows:
  cells=t.add_row().cells
  for i,text in enumerate(row):cells[i].text=str(text)
 for n,row in enumerate(t.rows):
  trPr=row._tr.get_or_add_trPr();cant=OxmlElement('w:cantSplit');trPr.append(cant)
  for i,c in enumerate(row.cells):
   c.width=Inches(widths[i])
   for para in c.paragraphs:
    para.paragraph_format.space_after=Pt(3);para.paragraph_format.space_before=Pt(3);para.paragraph_format.line_spacing=1.0
    for r in para.runs:r.font.size=Pt(8.4 if appendix else 9.3);r.bold=n==0
   if n==0:
    shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'EEEEEE');c._tc.get_or_add_tcPr().append(shade)
 doc.add_paragraph().paragraph_format.space_after=Pt(0)

md=[]
for n,(title,blocks) in enumerate(pages):
 if n:doc.add_page_break()
 doc.add_paragraph(title,'Title' if n==0 else 'Heading 1');md+=['# '+title,'']
 appendix=title.startswith('Appendix')
 for kind,value in blocks:
  if kind=='p':
   para=doc.add_paragraph(value);md += [value,'']
   if appendix:
    para.paragraph_format.space_after=Pt(4)
    for r in para.runs:r.font.size=Pt(9)
  elif kind=='h2':doc.add_paragraph(value,'Heading 2');md += ['## '+value,'']
  elif kind=='list':
   for item in value:doc.add_paragraph(item,'List Bullet');md+=['- '+item]
   md+=['']
  elif kind=='table':
   headers,rows,widths=value;add_table(headers,rows,widths,appendix)
   md+=['| '+' | '.join(headers)+' |','|'+'|'.join(['---']*len(headers))+'|']
   md+=['| '+' | '.join(str(c).replace('|','\\|') for c in row)+' |' for row in rows]+['']
  elif kind=='code':
   for line in value.splitlines():
    para=doc.add_paragraph();para.paragraph_format.space_after=Pt(0);para.paragraph_format.keep_with_next=True
    r=para.add_run(line);r.font.name='Consolas';r.font.size=Pt(8.3)
   doc.add_paragraph().paragraph_format.space_after=Pt(0);md+=['```',value,'```','']
  elif kind=='image':
   path,width,caption,crop=value
   pic=doc.add_paragraph();pic.alignment=WD_ALIGN_PARAGRAPH.CENTER
   run=pic.add_run();sh=run.add_picture(str(ROOT/path),width=Inches(width))
   # Crop the view in Word while preserving the original screenshot bytes.
   if crop:
    source_w,source_h=Image.open(ROOT/path).size
    left,top,right,bottom=crop
    rect=OxmlElement('a:srcRect')
    for key,val in [('l',left/source_w),('t',top/source_h),('r',1-right/source_w),('b',1-bottom/source_h)]:rect.set(key,str(round(val*100000)))
    sh._inline.xpath('.//pic:blipFill')[0].insert(1,rect)
    sh.height=Inches(width*(bottom-top)/(right-left))
   sh._inline.docPr.set('descr',caption)
   doc.add_paragraph(caption,'Caption');md+=['!['+caption+']('+path+')','']
OUT.parent.mkdir(parents=True,exist_ok=True);doc.save(OUT)
(ROOT/'docs/FieldMerge_Implementation_Report.md').write_bytes('\n'.join(md).encode('utf-8'))
(TMP/'expected-pages.json').write_text(json.dumps({'expected_pages':len(pages),'headings':[t for t,_ in pages],'implementation_commit':schema['implementation_commit']},indent=2),encoding='utf-8')
print(f'Created report with {len(pages)} planned pages and the complete 146-column appendix. Render and inspect before delivery.')
