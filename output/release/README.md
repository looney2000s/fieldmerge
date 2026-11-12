# FieldMerge clean published checkout results

Verified 13 November 2026: all 17 verification stages passed for published commit **62236a28927ae8e02b8c4adf651621cdea71be5f** from **codex/design-report**. The fresh production build and all application/database suites passed without changing implementation source or the lockfile. This is a local rebuild/test rehearsal; main integration and the author's live demonstration remain separate.

## Recorded results

| Suite | Outcome |
|---|---|
| Database structure/workflows | 231 assertions, four actual COMMIT cases, six concurrent SQL cases; matching form hashes. |
| Unit tests | 18 groups passed. |
| Production build | Passed; new build ID m1_2YF-bZLTfDZLGV6ik6. |
| API/worker/query integration | 33 groups passed. |
| Functional acceptance | All 35 scenarios passed; disposable cleanup complete. |
| Transport/security | 23 API groups and five browser checks passed. |
| Interface | 15 workflows and nine representative axe page checks; no reported violations or browser runtime errors. |
| Query/performance evidence | 21 checks passed; raw measurements/plans retained separately. |
| Catalog/dictionary | 17 SQL tables, 146 columns, 29 FKs, three MongoDB collections; migration checksums match. |
| Cleanup | Only newly created verification projects/volumes removed; original development container IDs unchanged. |

Environment: Windows 10.0.26200; Node v26.13.0; pnpm 11.28.11; Next.js 16.4.5; Playwright 1.65.0; Docker 29.9.2. HTTP suites ran sequentially with fresh restricted database credentials. Exact versions/settings for the new query run are in evidence/performance/environment.json.

## Freshness and isolation

The source was cloned directly from GitHub and checked against the full expected SHA. The initial checkout contained no .env, node_modules, .next or tmp inputs. Dependency installation used the frozen lockfile and a standard package-download cache; project dependencies/build output were not copied. Chromium was installed into the new checkout. Private fixtures and database credentials were generated anew. A unique Compose name and separate loopback ports isolated all databases from the normal development project.

Setup and execution used only process-local environment adjustments for Windows PATH, native PowerShell modules and memory/concurrency limits. The private checkout is retained for diagnosis; its new database volumes were removed after verification. Development configuration was neither loaded nor overwritten. The conceptual ER diagram and implementation DOCX were not edited by this check.

## Evidence and stages

[Top-level status](verification.json), [source digests](source-checksums.json), [artifact digests](artifact-checksums.json), [production build output](evidence/production-build.txt), [unit output](evidence/unit-tests.txt), and the fresh evidence subdirectories identify this run. Artifact digests were independently rechecked after collection. Generated database/demo credentials were screened out of published evidence. Raw diagnostics remain ignored/private. Absolute workstation/checkout paths in published logs are normalized; test outcomes are unchanged. Published artifact text uses LF without a UTF-8 BOM, and terminal padding/blank endings are removed; artifact digests cover these published bytes. Source digests describe the verified Windows checkout's file bytes.

| Stage | Result | Seconds |
|---|---|---:|
| docker ready | Passed | 0.15 |
| clone published revision | Passed | 2.44 |
| install frozen dependencies | Passed | 4.17 |
| generate private configuration | Passed | 0.32 |
| database setup and verification | Passed | 48.06 |
| restricted backend configuration | Passed | 0.89 |
| unit tests | Passed | 0.78 |
| production build | Passed | 28.42 |
| install chromium | Passed | 47.76 |
| api integration | Passed | 20.84 |
| functional acceptance | Passed | 27.79 |
| transport and security | Passed | 13.71 |
| browser workflows | Passed | 21.26 |
| query and performance evidence | Passed | 42.69 |
| schema dictionary reconciliation | Passed | 0.95 |
| source integrity and public evidence | Passed | 0.43 |
| isolated environment cleanup | Passed | 1.59 |

## Retained failed attempts

3 earlier verification-driver attempts remain in attempts/. They caught Windows PATH casing, native Windows PowerShell module-path inheritance, and a Git stderr warning incorrectly parsed as a changed filename. The last of these occurred after all application suites had passed. The source-integrity predicate was retained; stdout/stderr separation was corrected, then a completely fresh full run passed. No application requirement was weakened and no application code was patched to obtain these results.

The successful run started at 2026-11-12T19:00:47.118Z and finished at 2026-11-12T19:05:09.382Z. No old committed runtime report was accepted in place of its fresh suite output. The published packet has 43 artifacts. An inherited development-smoke JSON file, not reexecuted here, was excluded during publication; current browser evidence is checks.json and verification.json. Earlier design-report layout evidence was not copied as a new layout inspection.

## Remaining release work

Review and integrate the implementation branches into main, rehearse the author's demonstration/query modification, confirm instructor arrangements, and package the final report/source/evidence with the already completed ER diagram. Hosting is optional unless separately required. This run does not establish exhaustive security/accessibility, production capacity or disaster-recovery guarantees. [Procedure and limits](../../docs/FieldMerge_Release_Verification.md).
