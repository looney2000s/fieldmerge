# Security boundary evidence

See [the security guide](../../docs/FieldMerge_Security.md) for the tested scope, reproduction commands, failure-log inspection, and limitations.

- `verification.json`: successful production-server security run and captured safe output; check its timestamp.
- `checks.json`: named S01–S23 transport/API cases and individual status.
- `browser.json`: five browser checks and runtime-error list.
- `escaped-record.png`: synthetic stored markup displayed as text in the accepted record.
- `source-checksums.json`: SHA-256 manifest of selected implementation/test files and all SQL migrations at the successful run.

Run `pnpm build` followed by `pnpm test:security`, with Docker development services running. Generated credentials, cookies and fallback runtime files are excluded from these artifacts. Browser assertion failures emit only a fixed failure label and completed-check count because raw Playwright page snapshots can include password-input values. Failures exit nonzero; a previously saved successful report remains historical and must not be mistaken for a later failed run. This is targeted coverage, not an exhaustive security assessment.
