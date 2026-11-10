"use client";
import { useState } from "react";
import { useResource, download, query } from "./client.mjs";
import { RoleGate } from "./session.jsx";
import { PageTitle, Resource, ErrorNotice, Icon, fields } from "./ui.jsx";
import { RecordFilterFields, initialRecordFilters } from "./records.jsx";
function Counts({ title, rows, label = "state" }) {
  const max = Math.max(1, ...rows.map((x) => x.count));
  return (
    <section className="panel">
      <h2>{title}</h2>
      {rows.length ? (
        <div className="count-bars">
          {rows.map((r) => (
            <div key={r[label]}>
              <div>
                <span>{String(r[label]).replaceAll("_", " ")}</span>
                <strong>{r.count}</strong>
              </div>
              <div className="bar-track" aria-hidden="true">
                <span style={{ width: (100 * r.count) / max + "%" }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="subtle">No matching activity yet.</p>
      )}
    </section>
  );
}
export function Reports() {
  const resource = useResource("/api/reports/summary"),
    [filters, setFilters] = useState(initialRecordFilters),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(null);
  async function exportFile(format) {
    setError(null);
    setBusy(format);
    try {
      await download(
        "/api/reports/accepted." + format + "?" + query(filters),
        "fieldmerge-accepted." + format,
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <RoleGate role="reviewer">
      <PageTitle
        eyebrow="SEPARATE SOURCES, CLEAR MEANINGS"
        title="Reports & exports"
        description="Accepted state comes from SQL. Source evidence is counted separately."
      >
        <button className="button secondary" onClick={resource.refresh}>
          Refresh summaries
        </button>
      </PageTitle>
      <Resource resource={resource}>
        {({ sql, evidence }) => (
          <>
            <section className="metric-grid">
              <div className="metric">
                <span>Accepted records</span>
                <strong>{sql.accepted_records}</strong>
                <small>{sql.active_records} active</small>
              </div>
              <div className="metric">
                <span>Records awaiting review</span>
                <strong>{sql.unresolved_record_count}</strong>
                <small>With at least one pending field</small>
              </div>
              <div className="metric">
                <span>Stored source envelopes</span>
                <strong>
                  {evidence.available ? evidence.source_count : "—"}
                </strong>
                <small>
                  {evidence.available
                    ? "Includes unverified or held evidence"
                    : "Evidence store unavailable"}
                </small>
              </div>
              <div className="metric">
                <span>Sources with observations</span>
                <strong>
                  {evidence.available &&
                  evidence.observation_coverage_pct !== null
                    ? evidence.observation_coverage_pct.toFixed(1) + "%"
                    : "—"}
                </strong>
                <small>Optional supporting observations</small>
              </div>
            </section>
            <div className="two-columns">
              <Counts title="Submission states" rows={sql.submissions} />
              <Counts title="Field dispositions" rows={sql.field_outcomes} />
            </div>
            <div className="two-columns">
              <Counts
                title="Initial classifications"
                rows={sql.classifications}
                label="classification"
              />
              <Counts
                title="Reviewer actions"
                rows={sql.review_actions}
                label="action"
              />
            </div>
            <section className="panel">
              <div className="section-title">
                <h2>Source evidence aggregates</h2>
                <span className="subtle">
                  {evidence.available
                    ? evidence.source_count + " stored documents"
                    : "Unavailable"}
                </span>
              </div>
              {!evidence.available ? (
                <div className="notice warning">
                  <p>
                    Source evidence is temporarily unavailable. SQL totals above
                    remain available; missing evidence counts have not been
                    replaced with zero.
                  </p>
                </div>
              ) : (
                <>
                  <p className="subtle">
                    These are stored document counts, not accepted observations
                    or resolved conflicts. Reads from the two databases are
                    independent.
                  </p>
                  <div className="two-columns">
                    <div className="table-scroll">
                      <table>
                        <caption>By form version</caption>
                        <thead>
                          <tr>
                            <th>Form</th>
                            <th>Sources</th>
                            <th>Observations</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evidence.by_form.map((r) => (
                            <tr key={r.form_version}>
                              <td>{r.form_version}</td>
                              <td>{r.source_count}</td>
                              <td>{r.observation_count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!evidence.by_form.length ? (
                        <p className="subtle">No source documents yet.</p>
                      ) : null}
                    </div>
                    <div className="table-scroll">
                      <table>
                        <caption>Observation categories</caption>
                        <thead>
                          <tr>
                            <th>Category</th>
                            <th>Count</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evidence.observation_categories.map((r) => (
                            <tr key={r.category}>
                              <td>{r.category}</td>
                              <td>{r.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <details className="source-details">
                    <summary>
                      Batch attribution and patch-field presence
                    </summary>
                    <div className="two-columns">
                      <table>
                        <caption>First-intake batch</caption>
                        <thead>
                          <tr>
                            <th>Batch</th>
                            <th>Sources</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evidence.by_first_batch.map((r) => (
                            <tr key={r.batch_id ?? "unbatched"}>
                              <td className="wrap-reference">
                                {r.batch_id ?? "Unbatched"}
                              </td>
                              <td>{r.source_count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <table>
                        <caption>Proposed field presence</caption>
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th>Sources</th>
                            <th>Explicit unknowns</th>
                          </tr>
                        </thead>
                        <tbody>
                          {evidence.patch_field_presence.map((r) => (
                            <tr key={r.field}>
                              <td>{fields[r.field]}</td>
                              <td>{r.count}</td>
                              <td>{r.explicit_nulls}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {evidence.batch_groups_truncated ? (
                      <p className="field-help">
                        Only the first 100 batch groups are shown.
                      </p>
                    ) : null}
                    <p className="field-help">
                      Batch counts describe first attribution. Patch presence is
                      not accepted-record completeness.
                    </p>
                  </details>
                </>
              )}
            </section>
          </>
        )}
      </Resource>
      <section className="panel">
        <p className="eyebrow">ACCEPTED DATASET</p>
        <h2>Export accepted records</h2>
        <p className="subtle">
          Download all matching latest records, up to 5,000. A larger match is
          rejected rather than truncated.
        </p>
        <RecordFilterFields
          value={filters}
          onChange={setFilters}
          prefix="export"
        />
        <ErrorNotice error={error} />
        <div className="editor-actions">
          <button
            className="button primary"
            disabled={!!busy}
            onClick={() => exportFile("csv")}
          >
            <Icon name="download" size={17} />
            {busy === "csv" ? "Preparing…" : "Download CSV"}
          </button>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => exportFile("json")}
          >
            <Icon name="download" size={17} />
            {busy === "json" ? "Preparing…" : "Download JSON"}
          </button>
        </div>
        <p className="field-help">
          JSON retains exact decimal text and original strings. CSV prefixes
          formula-like text for spreadsheet display.
        </p>
      </section>
    </RoleGate>
  );
}
