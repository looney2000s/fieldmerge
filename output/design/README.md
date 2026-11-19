# Reconciled design evidence

The metadata-only catalog captures the implemented SQL/MongoDB structures at baseline 7588773 after migrations 001–010. It includes no application rows, account hashes, sessions, tokens or connection settings. Column *names* referring to credentials are present because those columns are part of the schema; their values are not exported.

- `schema-catalog.json`: 17 SQL tables, 146 columns, 29 FKs, four views, constraints, indexes, identity/default metadata, explicit trigger definitions, function signatures, applied migration checksums and three MongoDB collection validators/indexes.
- `verification.json`: dictionary/count assertions and comparison of all ten applied migration checksums with source.
- `architecture.svg`: code-generated application/data-flow diagram; it is not a replacement for the author's separately maintained Chen ER diagram.
- `report-verification.json`: historical Word-draft digest and layout record; the submission report is the final PDF linked below.

With private local configuration and development services available, regenerate the catalog and full Markdown dictionary using `pnpm design:export`. This reads database metadata and writes documentation/evidence; it does not mutate database records. Re-export after a migration, then review the schema/normalization explanations and report rather than assuming their prose updates automatically.

The [final PDF report](../pdf/FieldMerge_Project_Report.pdf) is the published submission document. It contains 34 visually checked pages, the author-supplied Chen diagram, genuine workflow screenshots, the complete 146-column SQL dictionary and all 29 physical foreign-key references. The earlier Word report and proposal remain private local drafts rather than alternative published submissions.

Historical Word-rendering and layout evidence is retained for provenance. It does not claim that the new PDF was rendered by Word or that report publication reran the application suites.

This is a design/documentation milestone, not a fresh execution of the application suites. Their successful recorded results remain separately identified in output/api, output/acceptance, output/browser, output/security, output/performance and output/release. Main integration is complete. Instructor arrangements, final packaging, the author's own rehearsal and the live viva remain separate in the project checklist.
