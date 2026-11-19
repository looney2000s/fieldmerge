# FieldMerge clean checkout verification

This check rebuilds the published project in a new Git clone and exercises its databases, API, browser workflows and query evidence. It is separate from the earlier incremental development runs and does not merge or deploy the project.

## Reproduce the check

With Node.js, pnpm 11, Git and Docker Desktop available, start Docker Desktop using Linux containers. From the normal project folder:

```powershell
node scripts/verify-release.mjs --ref codex/design-report --commit 62236a28927ae8e02b8c4adf651621cdea71be5f
```

The full commit argument must match the branch fetched from GitHub. A moved branch does not silently substitute different code: the check fails if HEAD differs. For a later candidate, supply its published branch and full commit. This runner currently targets Windows, matching the project's verified workstation.

## What is isolated

The runner creates a unique ignored `tmp/fieldmerge-release-<UUID>/checkout` directory and clones directly from GitHub. It asserts an initially clean tree with no `.env`, `node_modules`, `.next` or `tmp` inputs. Dependencies are installed with the frozen lockfile; an existing pnpm package-download cache is allowed, but project dependencies and build output are not copied from development. Chromium is installed into the new checkout's own browser directory.

It generates fresh local database/demo credentials and selects separate loopback ports. Setup and tests inherit a unique COMPOSE_PROJECT_NAME, also retained in the private checkout's .env, which overrides the Compose file's default project name; nested acceptance/performance runs use their own explicit `-p` projects. These isolation mechanisms follow [Docker's documented project-name precedence](https://docs.docker.com/compose/how-tos/project-name/). The runner verifies the resolved volume names before setup and checks that the original `fieldmerge` container IDs are unchanged afterward. It does not target development volumes or load the development `.env`.

The driver inherits a Windows PATH without creating conflicting Path/PATH keys and gives native Windows PowerShell its own module directory rather than the parent PowerShell 7 module paths. These are process-local settings. The dependency install uses one child at a time and Node uses a 1 GiB heap limit; HTTP suites run sequentially on temporary port 3100. No system settings are changed.

## Sequence and evidence

1. Confirm Docker readiness and the exact published revision.
2. Install frozen dependencies and generate private configuration.
3. Run the real database Setup/verification and provision restricted API/worker accounts.
4. Run the 18 unit groups and produce a fresh production build.
5. Install Chromium, then run API, acceptance, security and browser suites sequentially.
6. Run query/performance demonstrations and regenerate the catalog-backed dictionary.
7. Check that the lockfile and implementation source are unchanged; gather fresh evidence and screen it for generated credentials.
8. Remove only this run's labelled disposable projects, including its newly created volumes, then verify development container identities.

The latest top-level status, exact commit, versions, stage results, durations and cleanup result are in [output/release/verification.json](../output/release/verification.json). Each completed attempt is retained under output/release/attempts. A failed stage remains failed; cleanup success alone cannot turn it into a passing release check. Raw diagnostics and generated account files stay in the ignored private directory.

Fresh suite artifacts are under output/release/evidence, with digests in artifact-checksums.json and a selected source-file manifest in source-checksums.json. Previously committed report timestamps cannot satisfy the runtime suite freshness checks. Publication also excludes inherited ancillary evidence such as development-smoke.json that was not reexecuted, normalizes absolute log paths and text line endings, and refreshes the published artifact digests. The top-level report records these publication transformations separately from test outcomes. Design report layout verification from the earlier milestone is not copied as a newly performed check. This runtime check did not edit the earlier Word draft or measurement report. The published submission report is now the [final PDF](../output/pdf/FieldMerge_Project_Report.pdf).

The private checkout is retained for diagnosis after its containers/volumes are removed. To repeat verification, use the runner command above, which creates another isolated checkout, rather than manually starting the default Compose project from that private directory. The main development folder remains the documented place to run the application.

## Limits and remaining work

This is a repeatable local rebuild and test rehearsal on Windows, not proof of arbitrary-machine support, exhaustive security, complete accessibility or production capacity. Query timings remain warmed local measurements with the sample-size limits described in their own report. Existing Docker images and pnpm downloads may be cached; private application configuration, databases and fixtures are newly generated.

Passing this check does not establish instructor approval of solo work, perform a student's live demonstration/query explanation, merge branches into main, publish a hosted service, or create the final submission package. Those steps remain explicit in the [project checklist](FieldMerge_Project_Checklist.md).
