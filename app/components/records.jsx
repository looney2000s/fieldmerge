"use client";
import { useState } from "react";
import Link from "next/link";
import { useResource, query, download } from "./client.mjs";
import { useSession } from "./session.jsx";
import {
  PageTitle,
  Resource,
  Empty,
  Value,
  Status,
  Icon,
  Pager,
  ErrorNotice,
  fields,
  date,
  Reference,
} from "./ui.jsx";
export const initialRecordFilters = {
  source_record_id: "",
  species: "",
  health: "",
  active: "true",
};
export function RecordFilterFields({ value, onChange, prefix = "records" }) {
  const change = (key, v) => onChange({ ...value, [key]: v });
  return (
    <div className="filter-fields">
      <div>
        <label htmlFor={prefix + "-source"}>Record ID</label>
        <input
          id={prefix + "-source"}
          value={value.source_record_id}
          onChange={(e) => change("source_record_id", e.target.value)}
          placeholder="e.g. DEMO-1"
          maxLength={120}
        />
      </div>
      <div>
        <label htmlFor={prefix + "-species"}>Species</label>
        <input
          id={prefix + "-species"}
          value={value.species}
          onChange={(e) => change("species", e.target.value)}
          placeholder="Search species"
          maxLength={120}
        />
      </div>
      <div>
        <label htmlFor={prefix + "-health"}>Health</label>
        <select
          id={prefix + "-health"}
          value={value.health}
          onChange={(e) => change("health", e.target.value)}
        >
          <option value="">Any health</option>
          {["Good", "Fair", "Poor"].map((x) => (
            <option key={x}>{x}</option>
          ))}
          <option value="unknown">Unknown</option>
        </select>
      </div>
      <div>
        <label htmlFor={prefix + "-active"}>Records</label>
        <select
          id={prefix + "-active"}
          value={value.active}
          onChange={(e) => change("active", e.target.value)}
        >
          <option value="true">Active</option>
          <option value="all">All records</option>
          <option value="false">Retired</option>
        </select>
      </div>
    </div>
  );
}
export function Records() {
  const { user } = useSession(),
    [filters, setFilters] = useState(initialRecordFilters),
    [applied, setApplied] = useState(initialRecordFilters),
    [cursors, setCursors] = useState([null]);
  const resource = useResource(
    "/api/records?" + query({ ...applied, limit: 20, after: cursors.at(-1) }),
  );
  function filter(e) {
    e.preventDefault();
    setApplied(filters);
    setCursors([null]);
  }
  return (
    <>
      <PageTitle
        eyebrow="THE ACCEPTED DATASET"
        title="Records"
        description="Start with an accepted snapshot. Every proposal keeps its base version."
      />
      <form className="panel filters" onSubmit={filter}>
        <RecordFilterFields value={filters} onChange={setFilters} />
        <button className="button primary">Apply filters</button>
      </form>
      <Resource resource={resource}>
        {(data) =>
          data.records.length ? (
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>
                  Accepted records{" "}
                  <span className="count">
                    {data.records.length} on this page
                  </span>
                </h2>
                <span className="subtle">Latest published values</span>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Accepted tree survey records
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Record / species</th>
                      <th scope="col">Health</th>
                      <th scope="col">Diameter</th>
                      <th scope="col">Guard</th>
                      <th scope="col">Version</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map((r) => (
                      <tr key={r.record_id}>
                        <td>
                          <Link
                            className="record-name"
                            href={"/records/" + r.record_id}
                          >
                            {r.source_record_id}
                          </Link>
                          <span className="cell-secondary">
                            <Value value={r.species} />
                          </span>
                        </td>
                        <td>
                          <span
                            className={`health ${r.health?.toLowerCase() ?? "unknown"}`}
                          >
                            <Value value={r.health} />
                          </span>
                        </td>
                        <td>
                          <Value value={r.diameter_cm} field="diameter_cm" />
                        </td>
                        <td>
                          <Value value={r.guard_damage} field="guard_damage" />
                        </td>
                        <td>
                          <span className="version">v{r.version_no}</span>
                          {!r.is_active ? (
                            <small className="cell-secondary">Retired</small>
                          ) : null}
                        </td>
                        <td>
                          <div className="row-actions">
                            <Link
                              className="text-link"
                              href={"/records/" + r.record_id}
                            >
                              Open
                              <span className="sr-only">
                                {" "}
                                record {r.source_record_id}
                              </span>
                              <Icon name="arrow" size={15} />
                            </Link>
                            {user.role === "surveyor" && r.is_active ? (
                              <Link
                                className="text-link"
                                href={`/drafts/new?record_id=${r.record_id}&version=${r.version_no}`}
                              >
                                New draft
                                <span className="sr-only">
                                  {" "}
                                  for {r.source_record_id}
                                </span>
                              </Link>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                next={data.next_cursor}
                canPrevious={cursors.length > 1}
                onNext={() => setCursors([...cursors, data.next_cursor])}
                onPrevious={() => setCursors(cursors.slice(0, -1))}
              />
            </section>
          ) : (
            <div className="panel">
              <Empty
                title="No matching records"
                description="Try a broader species or record filter, or include retired records."
              />
              {cursors.length > 1 ? (
                <button
                  className="button secondary"
                  onClick={() => setCursors([null])}
                >
                  Return to first page
                </button>
              ) : null}
            </div>
          )
        }
      </Resource>
      <div className="quiet-note">
        <Icon name="tree" size={18} />
        <p>
          Propose only the fields you observed. Other accepted values remain
          part of the shared record.
        </p>
      </div>
    </>
  );
}
export function RecordDetails({ id }) {
  const { user } = useSession(),
    [version, setVersion] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const snapshot = useResource(
      "/api/records/" +
        id +
        "/snapshot" +
        (version ? "?version=" + version : ""),
    ),
    history = useResource("/api/records/" + id + "/history");
  async function save(v) {
    setBusy(true);
    setError(null);
    try {
      await download(
        `/api/records/${id}/snapshot?version=${v}`,
        `fieldmerge-snapshot-${id}-v${v}.json`,
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" href="/records">
        ← Records
      </Link>
      <Resource resource={snapshot}>
        {(s) => (
          <>
            <PageTitle
              eyebrow={version ? "HISTORICAL SNAPSHOT" : "ACCEPTED SNAPSHOT"}
              title={s.record.source_record_id}
              description={
                <>
                  <Value value={s.record.species} />{" "}
                  <span className="slash">/</span>{" "}
                  <span className="version">Version {s.record.version_no}</span>{" "}
                  {!s.record.is_active ? <Status state="retired" /> : null}
                </>
              }
            >
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => save(s.record.version_no)}
              >
                <Icon name="download" size={17} />
                Download snapshot
              </button>
              {user.role === "surveyor" && s.record.is_active ? (
                <Link
                  className="button primary"
                  href={`/drafts/new?record_id=${id}&version=${s.record.version_no}`}
                >
                  <Icon name="plus" size={17} />
                  Draft from this version
                </Link>
              ) : null}
            </PageTitle>
            <ErrorNotice error={error} />
            <section className="value-grid">
              {Object.entries(fields).map(([field, label]) => (
                <div className="value-card" key={field}>
                  <span>{label}</span>
                  <strong>
                    <Value value={s.record[field]} field={field} />
                  </strong>
                </div>
              ))}
            </section>
            <section className="panel context-panel">
              <div>
                <p className="eyebrow">SURVEY CONTEXT</p>
                <h2>{s.campaign.name}</h2>
                <p>
                  {date(s.campaign.starts_at)} — {date(s.campaign.ends_at)}
                </p>
              </div>
              <div>
                <span className="subtle">
                  Published {date(s.record.created_at)}
                </span>
                <p>
                  Record reference <Reference id={id} />
                </p>
                <Link className="text-link" href={"/activity?record_id=" + id}>
                  View submissions
                  <Icon name="arrow" size={15} />
                </Link>
              </div>
            </section>
          </>
        )}
      </Resource>
      <Resource resource={history}>
        {(h) => (
          <div className="two-columns history-columns">
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>Version history</h2>
                <span className="subtle">Latest 100 snapshots</span>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Immutable version history
                  </caption>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Published</th>
                      <th>Origin</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.versions.map((v) => (
                      <tr key={v.version_no}>
                        <td>
                          <strong>v{v.version_no}</strong>
                        </td>
                        <td>{date(v.created_at)}</td>
                        <td>
                          {v.origin_submission_id ? (
                            <Link
                              href={"/submissions/" + v.origin_submission_id}
                            >
                              Submission{" "}
                              <Reference id={v.origin_submission_id} />
                            </Link>
                          ) : (
                            "Baseline import"
                          )}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => setVersion(v.version_no)}
                          >
                            View v{v.version_no}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel">
              <div className="section-title">
                <h2>Value provenance</h2>
                <span className="version">Latest accepted version</span>
              </div>
              <p className="subtle">
                Carried-forward values retain their original source.
              </p>
              <div className="provenance-list">
                {h.provenance.map((p) => (
                  <div key={p.field_name}>
                    <div>
                      <strong>{fields[p.field_name]}</strong>
                      <Value value={p.value} field={p.field_name} />
                    </div>
                    <p>
                      Origin v{p.origin_version_no} ·{" "}
                      {p.origin_submission_id ? (
                        <Link href={"/submissions/" + p.origin_submission_id}>
                          Submission <Reference id={p.origin_submission_id} />
                        </Link>
                      ) : (
                        "Baseline import"
                      )}
                    </p>
                    {p.decision_id ? (
                      <p>
                        Reviewer decision <Reference id={p.decision_id} />
                        {p.reason ? " · " + p.reason : ""}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </Resource>
    </>
  );
}
