# Reconciled design evidence

The metadata-only catalog captures the implemented SQL/MongoDB structures at baseline 7588773 after migrations 001–010. It includes no application rows, account hashes, sessions, tokens or connection settings. Column *names* referring to credentials are present because those columns are part of the schema; their values are not exported.

- `schema-catalog.json`: 17 SQL tables, 146 columns, 29 FKs, four views, constraints, indexes, identity/default metadata, explicit trigger definitions, function signatures, applied migration checksums and three MongoDB collection validators/indexes.
- `verification.json`: dictionary/count assertions and comparison of all ten applied migration checksums with source.
- `architecture.svg`: code-generated application/data-flow diagram; it is not a replacement for the author's separately maintained Chen ER diagram.
- `report-verification.json`: final DOCX digest, page-count/appendix checks and visual-review record.

With private local configuration and development services available, regenerate the catalog and full Markdown dictionary using `pnpm design:export`. This reads database metadata and writes documentation/evidence; it does not mutate database records. Re-export after a migration, then review the schema/normalization explanations and report rather than assuming their prose updates automatically.

The DOCX builder is `scripts/build-report.py`, run in this task with the bundled Python runtime and python-docx/Pillow. It reads the catalog, dictionary, recorded test evidence and genuine browser screenshots. The retained original proposal is not an input template and is unchanged. The report's conceptual diagram remains a separate author deliverable, per instruction.

The standard bundled DOCX renderer was attempted and diagnosed as unavailable because this Windows runtime has no LibreOffice executable. Layout verification therefore used a hidden Microsoft Word PDF export via `scripts/render-report.ps1`, followed by bundled Poppler PNG rasterization and inspection. Intermediate PDF/PNGs remain under ignored tmp/implementation-report; they are not submission deliverables. Word document cropping preserves original screenshot bytes and enlarges the relevant workflow detail.

This is a design/documentation milestone, not a clean-room release rehearsal or a fresh execution of all application suites. Their successful prior results remain separately timestamped in output/api, output/acceptance, output/browser, output/security and output/performance. Instructor arrangements, branch integration, final packaging, rehearsal and the live viva remain open in the project checklist.
