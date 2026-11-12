# FieldMerge demonstration and viva guide

This is a rehearsal script for the implemented local system at baseline 7588773. Running these UI actions intentionally creates new immutable survey history. Use clearly synthetic records, keep their existing history, and never reset a development volume merely to repeat the demonstration. The separate performance suite supplies a larger disposable dataset when needed.

## Prepare the workstation

With Docker Desktop running, open PowerShell in the project folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\database.ps1 Setup
pnpm install --frozen-lockfile
pnpm configure:backend
pnpm dev
```

Open http://localhost:3000, matching APP_ORIGIN in the private .env. In a second terminal run `pnpm worker`. Keep both running during the demonstration. Open the ignored `tmp/database-fixtures/demo-accounts.json` privately for credentials; do not project that file. Use a normal browser context for the surveyor and a private/incognito context for the reviewer. Keep passwords and cookies out of screenshots and submission materials.

Initial Setup downloads database images and needs network access. Rehearse before the assessment. Existing fixtures are dated for the 2026 campaign. For a later year, explicitly prepare a matching campaign fixture; do not silently change a clock/campaign-warning assertion. Regenerating the account fixture does not rotate existing stored password hashes.

## Demonstrate the core problem in about ten minutes

1. **Explain the record and base.** Select a synthetic tree. Note its current version and values; do not assume it is still version 1. Explain why an older downloaded snapshot remains a valid proposal base but does not authorize overwrite. Show the supplied Chen diagram alongside the SQL mapping.
2. **Create two saved drafts from that same version before finalizing either.** Call them A and B in your notes. Choose two valid, different diameter values that also differ from the displayed current value (for example 31 and 32 cm when current is 30). In A propose only the first diameter. In B propose the other diameter and a different valid health category. Use a current, in-window observation time. Leave other fields at No proposal. Add a categorized note to B using tree-v2. Download B's complete upload file before finalization and retain it for replay.
3. **Publish A, then finalize B without rebasing it.** Show that A creates the next snapshot. B's independent health change publishes, while its competing diameter remains pending. Read the per-field receipt and original evidence. If an earlier demonstration already produced pending proposals, select the exact new submission/change IDs rather than assuming the first queue row belongs to this run.
4. **Resolve B as reviewer.** Filter to this record/submission; display base/current/proposed diameter. Choose a disposition and give a reason. Accept B's different diameter to show another version; alternatively keep current to show a terminal decision without a new version. Explain the difference. No outcome is biological proof.
5. **Verify history and retry.** Compare version count before/after. Inspect value provenance: B's health source and the responsible diameter source/decision must be shown, while untouched fields retain older origins. As surveyor, upload B's saved unchanged file. It must reference the same logical source without creating a new accepted version. Repeat the same file to demonstrate durable transport replay. Do not change its content under the old request ID.
6. **Show an authorization boundary.** As surveyor, a GET to `/api/reviews` is denied; inspect the Network response and its X-Request-Id. As reviewer, read `/api/operations/security-events?limit=10` with the authenticated browser/API session and find the safe failure event. The endpoint has no dedicated UI screen; its response is JSON. It contains no body, password or cookie.
7. **Connect both databases to the outcome.** Show the SQL current snapshot, field changes and decision through the prepared query examples, and the MongoDB source/observation aggregate. Accepted totals come from SQL; evidence totals come from MongoDB. Do not display configuration URLs, session tables or credential fixtures.

For stale-review behavior, open the same pending comparison in two reviewer contexts, make a competing accepted change, then submit the older context. The old action must fail and request refresh; do not auto-repeat it with fresh tokens. Use the acceptance/browser artifacts for this evidence if time or available pending fields makes a live extra scenario impractical.

## Verify the expected database effects

| Action | SQL checkpoint | MongoDB checkpoint |
|---|---|---|
| Save editable draft | Accepted version unchanged. | Owner draft exists with revision. |
| Finalize A | One source intake and one actual changed snapshot. | One sealed source under the same submission UUID. |
| Finalize B | Health applies, diameter remains pending; initial receipt retained. | Both proposed values and optional note remain sealed. |
| Resolve B | One terminal decision; optional new version and matching applying link. | Original evidence is unchanged. |
| Replay unchanged B | Same logical submission/receipt, no extra publication. | No second source and no overwritten source. |
| Denied surveyor review read | Independent safe security event. | No source/draft mutation. |

## Reproduce recorded evidence

```powershell
pnpm test:unit
pnpm build
pnpm test:api
pnpm test:acceptance
pnpm test:security
pnpm test:browser
pnpm db:evidence
pnpm db:evidence:summary
```

Run the HTTP suites sequentially: they share temporary port 3100. Browser tests require the Chromium download described in README. Acceptance and performance create disposable Compose projects; API/security/browser tests use unique databases on the development services. Do not run an intentional outage against normal development containers. The performance run takes additional time and is best completed before the presentation, with saved plans ready to inspect.

On this Windows machine, sustained repeated suites have encountered memory pressure. Stop unused test-profile services with the explicit `postgres-test mongo-test` service names, keep suites sequential, and rerun failed checks after resolving the resource condition. Never relabel a failed run as passing. The recorded successful security/acceptance refresh followed cleanup and a local database restart; it did not require changing a requirement or weakening a test.

## Viva questions to prepare

| Question | Explanation and evidence |
|---|---|
| Why two paradigms? | SQL accepted truth and local atomic workflow; MongoDB complete versioned source/evidence and editable draft documents. See architecture/model guides. |
| Why not last-write-wins? | Receipt order does not reveal which field value should be accepted; show B's old base and held competing value. |
| Is the schema completely in 3NF? | No blanket claim: record_id guard redundancy on changes/decisions enables declarative same-tree references; immutable snapshots repeat carried values deliberately. |
| How are races handled? | Target tree lock, current-state recheck, atomic version assignment and deferred consistency; inspect AC16/AC20. |
| Why both version and revision? | Accepted state and pending review context can change independently; reviewer intent must match both. |
| How does a retry remain safe after a lost response? | Stable authenticated request identity plus canonical fingerprint and immutable original receipt. |
| Why no distributed transaction? | Reserve/store/verify/publish plus durable recovery makes temporary incompleteness explicit; no cross-store atomicity claim. |
| What do triggers add beyond the interface? | Database-level mutation and commit-time consistency protection, even if a caller bypasses UI validation. |
| What does an index measurement prove? | Same-result access path/work comparison on a documented warmed fixture, not production throughput or statistically significant website speedup. |
| What is left operationally? | Clean-room release rehearsal, packaging and instructor arrangements; optional hosting, supervision and backup/restore work. |

For a small live modification, adjust only a read-only demonstration's `HAVING count(*) > 1` threshold in a disposable inspection session and explain how the result changes. Re-run its read and inspect the plan. Do not weaken publication constraints or rewrite a checksum-protected migration during the viva.

The author still needs to rehearse these actions and confirm the instructor's submission format, deadline and solo arrangement. A prepared script is not evidence that a live rehearsal or viva has taken place.
