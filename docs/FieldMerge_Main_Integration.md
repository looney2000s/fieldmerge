# FieldMerge main integration

Reviewed 13 November 2026. The full application and its verification/documentation milestones are integrated into main by a fast-forward from the earlier database foundation. Existing milestone commits and feature branches are retained. No application logic, migration or test was changed to perform this integration.

## Reviewed revisions

| Revision | Commit | Meaning |
|---|---|---|
| Previous main | fe77fcd573e389593154145854e287b7f5ba1325 | Database foundation and workflow baseline. |
| Reviewed feature tip | 59df5195d1b55ae33fbbea7862d6a237d5663fcd | Full implementation plus clean-checkout evidence. |
| Fresh tested application | 62236a28927ae8e02b8c4adf651621cdea71be5f | Exact GitHub revision rebuilt with fresh credentials/databases; all 17 stages passed. |

The additional integration commit records this review and updates current-status documentation. Git's main history and the remote main ref identify the published integration revision; no file attempts to contain its own commit hash.

## Review evidence

- All 122 application/database/test/configuration Git blobs are byte-for-byte identical to the fresh tested application revision. The corresponding retained tested files also match their recorded digests. Checkout-only CRLF/LF differences were checked separately rather than misclassified as code changes.
- All 43 curated release artifact digests match. The implementation DOCX digest agrees with its earlier layout/credential audit; the document is unchanged.
- All 246 changed committed files were screened against generated development and clean-checkout credentials. No private environment/account fixture was added. Targeted authentication, HTTP error/origin and SQL security-event boundaries were also read during review; this does not replace an exhaustive independent source/security audit.
- The remote main was fetched before review. It is an ancestor of the release tip, so no conflict resolution, squash, rebase or force push is required.

The review record is [output/integration/review.json](../output/integration/review.json). [Fresh release results](../output/release/README.md) retain the database, API, browser, acceptance, security, query and cleanup evidence, including the earlier driver failures and their corrections. GitHub-hosted CI is not configured by this milestone; the recorded verification ran locally against real isolated services.

## Included milestone branches

These are all ancestors of the reviewed release tip; merging them separately would add no application changes.

| Branch | Milestone commit |
|---|---|
| codex/acceptance-audit | 0ff36a8 |
| codex/design-report | 62236a2 |
| codex/drafts-finalization | 857422d |
| codex/query-export-batches | 9ee4ab4 |
| codex/query-performance | 6614abd |
| codex/recovery-worker | bb37797 |
| codex/release-verification | 59df519 |
| codex/security-boundaries | 7588773 |
| codex/workflow-integrity | 970478b |
| codex/workflow-interface | 8e990be |
| feature/authenticated-api | fc9d359 |

## Run the published project

Clone or update the repository's main branch, then follow README for Docker setup, pnpm installation and restricted backend configuration. Run pnpm dev and open http://localhost:3000 with the generated private surveyor/reviewer accounts. Keep pnpm worker running in another terminal for unattended recovery. Publishing the GitHub source does not start those local processes or create a hosted deployment.

## Remaining work

The author still needs to rehearse the live demonstration/query explanation, confirm instructor arrangements and assemble the final submission with the already completed ER diagram. This integration does not submit coursework or perform the student's viva.
