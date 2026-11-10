"use client";
import { useState } from "react";
import Link from "next/link";
import { api, useResource, explain } from "./client.mjs";
import { RoleGate } from "./session.jsx";
import {
  PageTitle,
  Resource,
  Empty,
  Status,
  Reference,
  date,
  ErrorNotice,
  Icon,
} from "./ui.jsx";
export function Recovery() {
  const resource = useResource("/api/operations/recovery");
  return (
    <RoleGate role="reviewer">
      <PageTitle
        eyebrow="OPERATIONAL INSPECTION"
        title="Recovery"
        description="Inspect incomplete intake and sealed drafts. Retrying never changes original evidence."
      >
        <button className="button secondary" onClick={resource.refresh}>
          Refresh jobs
        </button>
      </PageTitle>
      <Resource resource={resource}>
        {(data) =>
          data.jobs.length ? (
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>Recovery jobs</h2>
                <span className="subtle">Latest 100 · incomplete first</span>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Persistent recovery job status
                  </caption>
                  <thead>
                    <tr>
                      <th>Job / target</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Latest error</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.map((j) => (
                      <tr key={j.job_id}>
                        <td>
                          <Reference id={j.job_id} />
                          <span className="cell-secondary">
                            {j.job_kind} <Reference id={j.target_id} />
                          </span>
                        </td>
                        <td>
                          <Status state={j.status} />
                        </td>
                        <td>
                          {j.attempts}
                          <span className="cell-secondary">
                            {j.failure_count} consecutive failures
                          </span>
                        </td>
                        <td>
                          {j.last_error_code ? explain(j.last_error_code) : "—"}
                        </td>
                        <td>
                          <Link
                            className="text-link"
                            href={"/recovery/" + j.job_id}
                          >
                            Inspect
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
            <section className="panel">
              <Empty
                title="No recovery jobs yet"
                description="Jobs appear as new source submissions are reserved. A running worker recovers eligible incomplete items."
              />
            </section>
          )
        }
      </Resource>
      <div className="quiet-note">
        <Icon name="recovery" />
        <p>
          Missing source waits for the original upload. Integrity mismatches
          stay quarantined until their cause is investigated.
        </p>
      </div>
    </RoleGate>
  );
}
export function RecoveryDetail({ id }) {
  const resource = useResource("/api/operations/recovery/" + id),
    [reason, setReason] = useState(""),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function retry(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await api("/api/operations/recovery/" + id + "/retry", {
        method: "POST",
        body: { reason },
      });
      setReason("");
      setMessage("The same job is queued for another recovery check.");
      resource.refresh();
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }
  return (
    <RoleGate role="reviewer">
      <Link className="back-link" href="/recovery">
        ← Recovery jobs
      </Link>
      <Resource resource={resource}>
        {({ job: j, events }) => (
          <>
            <PageTitle
              eyebrow="RECOVERY JOB"
              title={
                <>
                  Job <Reference id={j.job_id} />
                </>
              }
              description={j.job_kind + " · Updated " + date(j.updated_at)}
            >
              <Status state={j.status} />
              <button className="button secondary" onClick={resource.refresh}>
                Refresh status
              </button>
            </PageTitle>
            <ErrorNotice error={error} />
            {message ? (
              <div className="notice success" role="status">
                <p>{message}</p>
              </div>
            ) : null}
            <div className="two-columns">
              <section className="panel">
                <h2>Current status</h2>
                <dl className="metadata">
                  <dt>Target</dt>
                  <dd>
                    <Reference id={j.target_id} />
                  </dd>
                  <dt>Lifetime attempts</dt>
                  <dd>{j.attempts}</dd>
                  <dt>Consecutive failures</dt>
                  <dd>{j.failure_count}</dd>
                  <dt>Last error</dt>
                  <dd>
                    {j.last_error_code ? explain(j.last_error_code) : "None"}
                  </dd>
                  <dt>Next eligible time</dt>
                  <dd>{date(j.next_attempt_at)}</dd>
                  <dt>Worker claim expires</dt>
                  <dd>
                    {j.lease_expires_at
                      ? date(j.lease_expires_at)
                      : "No active claim"}
                  </dd>
                </dl>
                {j.submission_id ? (
                  <Link
                    className="text-link"
                    href={"/submissions/" + j.submission_id}
                  >
                    Inspect source outcome
                    <Icon name="arrow" size={15} />
                  </Link>
                ) : (
                  <p className="subtle">
                    No SQL source has been reserved for this draft yet.
                  </p>
                )}
              </section>
              <section className="panel">
                <h2>Schedule a reviewed retry</h2>
                <p className="subtle">
                  Investigate the cause first. A retry inspects the same
                  evidence and preserves its identity.
                </p>
                <form onSubmit={retry}>
                  <label htmlFor="recovery-reason">Reason for retry</label>
                  <textarea
                    id="recovery-reason"
                    rows={3}
                    maxLength={500}
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={busy || j.status === "completed"}
                  />
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      j.status === "completed" ||
                      (j.status === "leased" &&
                        new Date(j.lease_expires_at) > new Date())
                    }
                  >
                    {busy ? "Scheduling…" : "Queue same job"}
                    <Icon name="recovery" size={17} />
                  </button>
                </form>
                <p className="field-help">
                  A live worker claim cannot be interrupted. Completed jobs
                  cannot be rescheduled.
                </p>
              </section>
            </div>
            <section className="panel">
              <h2>Operational event history</h2>
              <ol className="timeline">
                {events.map((e) => (
                  <li key={e.event_id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{e.event_type.replaceAll("_", " ")}</strong>
                      <time>{date(e.created_at)}</time>
                      {e.event_data.code ? (
                        <p>{explain(e.event_data.code)}</p>
                      ) : null}
                      {e.event_data.reason ? (
                        <p>{e.event_data.reason}</p>
                      ) : null}
                      {e.actor_id ? (
                        <p className="subtle">
                          Reviewer <Reference id={e.actor_id} />
                        </p>
                      ) : null}
                      {e.event_data.attempt ? (
                        <small className="subtle">
                          Attempt {e.event_data.attempt}
                        </small>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="field-help">
                Latest 30 recorded events. Failed publication and operational
                error recording use separate transactions.
              </p>
            </section>
          </>
        )}
      </Resource>
    </RoleGate>
  );
}
