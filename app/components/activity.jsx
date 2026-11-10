"use client";
import { useState } from "react";
import Link from "next/link";
import { api, useResource, query, explain } from "./client.mjs";
import { useSession } from "./session.jsx";
import { parseExact, canonical } from "@/lib/envelope.mjs";
import {
  PageTitle,
  Resource,
  Empty,
  Status,
  Value,
  Reference,
  date,
  fields,
  ErrorNotice,
  Icon,
} from "./ui.jsx";
export function Activity({ recordId = "" }) {
  const { user } = useSession(),
    [state, setState] = useState(""),
    [record, setRecord] = useState(recordId),
    [applied, setApplied] = useState({ record_id: recordId, state: "" });
  const resource = useResource("/api/submissions?" + query(applied));
  return (
    <>
      <PageTitle
        eyebrow="PROPOSALS & OUTCOMES"
        title={user.role === "reviewer" ? "Submissions" : "My submissions"}
        description="Follow each proposal from its source evidence to its accepted outcome."
      >
        <button className="button secondary" onClick={resource.refresh}>
          Refresh
        </button>
      </PageTitle>
      <form
        className="panel filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ record_id: record, state });
        }}
      >
        <div className="filter-fields compact">
          <div>
            <label htmlFor="activity-state">Outcome</label>
            <select
              id="activity-state"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">All outcomes</option>
              {[
                "awaiting_document",
                "ready",
                "processing",
                "needs_review",
                "partially_applied",
                "applied",
                "no_change",
                "resolved",
                "rejected",
              ].map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="activity-record">Record reference (optional)</label>
            <input
              id="activity-record"
              value={record}
              onChange={(e) => setRecord(e.target.value)}
              placeholder="Full record reference"
            />
          </div>
        </div>
        <button className="button primary">Apply filters</button>
      </form>
      <Resource resource={resource}>
        {(data) =>
          data.submissions.length ? (
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>Recent submissions</h2>
                <span className="subtle">Latest 100 matching proposals</span>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Submitted proposals and current outcomes
                  </caption>
                  <thead>
                    <tr>
                      <th>Record</th>
                      <th>Received</th>
                      <th>Outcome</th>
                      <th>Fields</th>
                      <th>Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.submissions.map((s) => (
                      <tr key={s.submission_id}>
                        <td>
                          <Link
                            className="record-name"
                            href={"/records/" + s.record_id}
                          >
                            {s.source_record_id}
                          </Link>
                          <span className="cell-secondary">
                            Base v{s.base_version_no} · {s.author_name}
                          </span>
                        </td>
                        <td>{date(s.received_at)}</td>
                        <td>
                          <Status state={s.state} />
                        </td>
                        <td>
                          {s.applied_fields} applied{" "}
                          <span className="cell-secondary">
                            {s.pending_fields} pending
                          </span>
                        </td>
                        <td>
                          <Link
                            className="text-link"
                            href={"/submissions/" + s.submission_id}
                          >
                            View outcome
                            <span className="sr-only"> {s.submission_id}</span>
                            <Icon name="arrow" size={15} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <div className="panel">
              <Empty
                title="No submissions found"
                description="Saved drafts appear here after finalization or upload."
                href={user.role === "surveyor" ? "/drafts" : undefined}
                label="Open my drafts"
              />
            </div>
          )
        }
      </Resource>
    </>
  );
}
export function SourceEvidence({ resource }) {
  return (
    <Resource resource={resource}>
      {(data) => {
        let p;
        try {
          p = parseExact(data.canonical_payload_json);
        } catch {
          return (
            <ErrorNotice
              error={new Error("The stored source could not be read.")}
            />
          );
        }
        return (
          <>
            <div className="source-meta">
              <span>
                Form <strong>{p.form_version}</strong>
              </span>
              <span>
                Observed <strong>{date(p.observed_at)}</strong>
              </span>
              <span>
                Received <strong>{date(data.received_at)}</strong>
              </span>
            </div>
            {p.observations?.length ? (
              <div className="observation-list">
                {p.observations.map((o, i) => (
                  <article key={i}>
                    <div>
                      <span className="category">{o.category}</span>
                      <time dateTime={o.observed_at}>
                        {date(o.observed_at)}
                      </time>
                    </div>
                    <p>{o.note}</p>
                    <small className="subtle">{o.observed_at}</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="subtle">No optional observations were included.</p>
            )}
            <details className="source-details">
              <summary>Original envelope and metadata</summary>
              <pre>{canonical(p)}</pre>
            </details>
          </>
        );
      }}
    </Resource>
  );
}
export function SubmissionDetails({ id }) {
  const { user } = useSession(),
    resource = useResource("/api/submissions/" + id),
    source = useResource("/api/submissions/" + id + "/source"),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  async function recover() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/submissions/" + id + "/recover", { method: "POST" });
      resource.refresh();
      source.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" href="/activity">
        ← Submissions
      </Link>
      <Resource resource={resource}>
        {({ submission: s, changes }) => (
          <>
            <PageTitle
              eyebrow="SUBMISSION OUTCOME"
              title={
                <>
                  Proposal <Reference id={s.submission_id} />
                </>
              }
              description={
                <>
                  Base version {s.base_version_no} · Received{" "}
                  {date(s.received_at)}
                </>
              }
            >
              <Status state={s.state} />
              <button
                className="button secondary"
                onClick={() => {
                  resource.refresh();
                  source.refresh();
                }}
              >
                Refresh outcome
              </button>
            </PageTitle>
            <ErrorNotice error={error} />
            {s.warnings?.length ? (
              <div className="notice warning">
                <strong>Review context</strong>
                <p>
                  {s.warnings
                    .map((w) =>
                      w === "clock_warning"
                        ? "The claimed observation time is ahead of receipt."
                        : w === "campaign_warning"
                          ? "The observation is outside the campaign reference window."
                          : explain(w),
                    )
                    .join(" ")}{" "}
                  Actual changes require review.
                </p>
              </div>
            ) : null}
            {s.state === "rejected" ? (
              <div className="notice error">
                <strong>Proposal rejected</strong>
                <p>{s.rejection_reason}</p>
              </div>
            ) : null}
            {["awaiting_document", "ready", "processing"].includes(s.state) ? (
              <div className="notice warning">
                <div>
                  <strong>Intake is incomplete.</strong>
                  <p>
                    Stored evidence can be recovered by the worker. If evidence
                    was never stored, upload the unchanged original file.
                  </p>
                </div>
                {user.role === "surveyor" && user.user_id === s.author_id ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={recover}
                  >
                    {busy ? "Checking…" : "Recover stored evidence"}
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="detail-toolbar">
              <Link className="text-link" href={"/records/" + s.record_id}>
                Open accepted record
                <Icon name="arrow" size={15} />
              </Link>
              {user.role === "reviewer" &&
              changes.some((c) => c.state === "pending") ? (
                <Link
                  className="text-link"
                  href={"/reviews?record_id=" + s.record_id}
                >
                  Review pending fields
                  <Icon name="arrow" size={15} />
                </Link>
              ) : null}
            </div>
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>Per-field outcomes</h2>
                <span className="subtle">Compared at initial processing</span>
              </div>
              {changes.length ? (
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">
                      Proposed fields and reconciliation outcomes
                    </caption>
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Base</th>
                        <th>At processing</th>
                        <th>Proposed</th>
                        <th>Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((c) => (
                        <tr key={c.change_id}>
                          <th scope="row">{fields[c.field_name]}</th>
                          <td>
                            <Value value={c.base_value} field={c.field_name} />
                          </td>
                          <td>
                            <Value
                              value={c.compared_value}
                              field={c.field_name}
                            />
                          </td>
                          <td>
                            <Value
                              value={c.proposed_value}
                              field={c.field_name}
                            />
                          </td>
                          <td>
                            <Status state={c.state} />
                            <span className="cell-secondary">
                              {c.pending_reason
                                ? explain(c.pending_reason)
                                : c.applied_version_no
                                  ? "Published in v" + c.applied_version_no
                                  : c.classification.replaceAll("_", " ")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="panel-inner">
                  <p className="subtle">
                    {s.state === "no_change"
                      ? "This evidence-only proposal created no scalar changes."
                      : "No field outcomes have been recorded."}
                  </p>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="section-title">
                <h2>Original source evidence</h2>
                <span className="subtle">Preserved as submitted</span>
              </div>
              <SourceEvidence resource={source} />
            </section>
            <details className="panel references">
              <summary>References and timing</summary>
              <dl className="metadata">
                <dt>Submission</dt>
                <dd>
                  <code>{s.submission_id}</code>
                </dd>
                <dt>Record</dt>
                <dd>
                  <code>{s.record_id}</code>
                </dd>
                <dt>Author</dt>
                <dd>
                  {s.author_id === user.user_id ? (
                    "You"
                  ) : (
                    <code>{s.author_id}</code>
                  )}
                </dd>
                <dt>Observed time</dt>
                <dd>{s.observed_at}</dd>
                <dt>First intake batch</dt>
                <dd>
                  {s.batch_id ? (
                    <Link href={"/batches/" + s.batch_id}>{s.batch_id}</Link>
                  ) : (
                    "Single submission"
                  )}
                </dd>
              </dl>
            </details>
          </>
        )}
      </Resource>
    </>
  );
}
