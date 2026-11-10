"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { canonical, parseExact } from "@/lib/envelope.mjs";
import {
  api,
  useResource,
  query,
  stored,
  remember,
  pendingReviews,
  observedTime,
  RequestError,
} from "./client.mjs";
import { useSession, RoleGate } from "./session.jsx";
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
  Pager,
} from "./ui.jsx";
import { ScalarInput, scalar } from "./drafts.jsx";
import { SourceEvidence } from "./activity.jsx";
export function Reviews({ recordId = "" }) {
  const { user } = useSession(),
    [unconfirmed, setUnconfirmed] = useState(() =>
      pendingReviews(user.user_id),
    );
  const [filters, setFilters] = useState({
      record_id: recordId,
      field: "",
      author_id: "",
      from: "",
      to: "",
    }),
    [applied, setApplied] = useState({ record_id: recordId }),
    [cursors, setCursors] = useState([null]),
    [selected, setSelected] = useState(null);
  const resource = useResource(
      "/api/reviews?" + query({ ...applied, limit: 20, after: cursors.at(-1) }),
    ),
    authors = useResource("/api/reviews/authors");
  const change = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  function filter(e) {
    e.preventDefault();
    setApplied({
      ...filters,
      from: observedTime(filters.from),
      to: observedTime(filters.to),
    });
    setCursors([null]);
  }
  return (
    <RoleGate role="reviewer">
      <PageTitle
        eyebrow="CONSIDERED DECISIONS"
        title="Review queue"
        description="Compare the base, current accepted value, and proposal before deciding."
      >
        <button className="button secondary" onClick={resource.refresh}>
          Refresh queue
        </button>
      </PageTitle>
      <form className="panel filters review-filters" onSubmit={filter}>
        <div className="filter-fields">
          <div>
            <label htmlFor="review-record">Record reference</label>
            <input
              id="review-record"
              value={filters.record_id}
              placeholder="Optional full reference"
              onChange={(e) => change("record_id", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="review-field">Field</label>
            <select
              id="review-field"
              value={filters.field}
              onChange={(e) => change("field", e.target.value)}
            >
              <option value="">All fields</option>
              {Object.entries(fields).map(([f, label]) => (
                <option key={f} value={f}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="review-author">Surveyor</label>
            <select
              id="review-author"
              value={filters.author_id}
              onChange={(e) => change("author_id", e.target.value)}
            >
              <option value="">All surveyors</option>
              {(authors.data?.authors ?? []).map((a) => (
                <option key={a.user_id} value={a.user_id}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="review-from">Received from (local)</label>
            <input
              id="review-from"
              type="datetime-local"
              value={filters.from}
              onChange={(e) => change("from", e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="review-to">Received before (local)</label>
            <input
              id="review-to"
              type="datetime-local"
              value={filters.to}
              onChange={(e) => change("to", e.target.value)}
            />
          </div>
        </div>
        <button className="button primary">Apply filters</button>
      </form>
      {unconfirmed.length ? (
        <div className="notice warning">
          <div>
            <strong>Unconfirmed decisions</strong>
            <p>
              Open the saved attempt to retry its exact request, even if the
              field has left the queue.
            </p>
            {unconfirmed.map((c) => (
              <button
                className="button secondary small"
                key={c.change_id}
                onClick={() => setSelected(c.change_id)}
              >
                Resume {c.source_record_id} · {fields[c.field_name]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <Resource resource={resource}>
        {(data) =>
          data.changes.length ? (
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>
                  Pending fields{" "}
                  <span className="count">
                    {data.changes.length} on this page
                  </span>
                </h2>
                <span className="subtle">
                  Each field is reviewed separately
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">Pending field proposals</caption>
                  <thead>
                    <tr>
                      <th>Record / field</th>
                      <th>Current</th>
                      <th>Proposed</th>
                      <th>Received</th>
                      <th>Compare</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.changes.map((c) => (
                      <tr
                        key={c.change_id}
                        className={
                          selected === c.change_id ? "selected-row" : ""
                        }
                      >
                        <td>
                          <Link
                            className="record-name"
                            href={"/records/" + c.record_id}
                          >
                            {c.source_record_id}
                          </Link>
                          <span className="cell-secondary">
                            {fields[c.field_name]}
                          </span>
                        </td>
                        <td>
                          <Value value={c.current_value} field={c.field_name} />
                        </td>
                        <td>
                          <strong>
                            <Value
                              value={c.proposed_value}
                              field={c.field_name}
                            />
                          </strong>
                        </td>
                        <td>{date(c.received_at)}</td>
                        <td>
                          <button
                            className="button secondary small"
                            onClick={() => setSelected(c.change_id)}
                          >
                            Compare
                            <span className="sr-only">
                              {" "}
                              {c.source_record_id} {fields[c.field_name]}
                            </span>
                            <Icon name="arrow" size={15} />
                          </button>
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
            <section className="panel">
              <Empty
                title="No pending fields in this view"
                description="All matching proposals have a disposition, or no matching proposals have arrived."
              />
            </section>
          )
        }
      </Resource>
      {selected ? (
        <ReviewPanel
          key={selected}
          id={selected}
          onDecision={() => {
            resource.refresh();
            setUnconfirmed(pendingReviews(user.user_id));
          }}
        />
      ) : (
        <div className="quiet-note">
          <Icon name="review" />
          <p>
            Select a pending field to open its source evidence and comparison.
          </p>
        </div>
      )}
    </RoleGate>
  );
}
function ReviewPanel({ id, onDecision }) {
  const { user } = useSession(),
    [restored] = useState(() => stored(user.user_id + ":review:" + id)),
    resource = useResource(restored ? null : "/api/reviews/" + id);
  if (restored?.comparison)
    return (
      <DecisionForm
        initial={restored.comparison}
        initialAttempt={restored}
        onDecision={onDecision}
      />
    );
  return (
    <Resource resource={resource}>
      {(data) => (
        <DecisionForm
          initial={data.change}
          initialAttempt={null}
          onDecision={onDecision}
        />
      )}
    </Resource>
  );
}
function DecisionForm({ initial, initialAttempt, onDecision }) {
  const panel = useRef(null);
  useEffect(() => {
    const heading = panel.current?.querySelector("h2");
    heading?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);
  const { user } = useSession(),
    [comparison, setComparison] = useState(initial),
    [attempt, setAttempt] = useState(initialAttempt),
    [receipt, setReceipt] = useState(null),
    [error, setError] = useState(null),
    [stale, setStale] = useState(false),
    [gone, setGone] = useState(false),
    [busy, setBusy] = useState(false);
  const recovered = initialAttempt ? parseExact(initialAttempt.raw) : null;
  const [action, setAction] = useState(recovered?.action ?? "accept_proposal"),
    [reason, setReason] = useState(recovered?.reason ?? ""),
    [replacement, setReplacement] = useState(
      recovered?.chosen_value === null
        ? ""
        : String(recovered?.chosen_value ?? ""),
    ),
    [clear, setClear] = useState(
      recovered?.action === "replace" && recovered.chosen_value === null,
    );
  const evidence = useResource(
      "/api/submissions/" + initial.submission_id + "/source",
    ),
    key = user.user_id + ":review:" + initial.change_id,
    locked = !!attempt || busy || stale || gone || !!receipt;
  async function decide(e) {
    e.preventDefault();
    setError(null);
    let command = attempt;
    try {
      if (!command) {
        if (!reason.trim())
          throw new Error("Enter a reason for this decision.");
        const body = {
          client_decision_id: crypto.randomUUID(),
          expected_version_no: comparison.current_version_no,
          expected_change_revision: comparison.revision_no,
          action,
          reason,
        };
        if (action === "replace")
          body.chosen_value = clear
            ? null
            : scalar(comparison.field_name, replacement);
        command = { raw: canonical(body), comparison };
        setAttempt(command);
        remember(key, command);
      }
      setBusy(true);
      const result = await api("/api/reviews/" + comparison.change_id, {
        method: "POST",
        raw: command.raw,
      });
      remember(key, null);
      setAttempt(null);
      setReceipt(result);
      onDecision();
    } catch (x) {
      setError(x.code && x.status ? new RequestError(x.code, x.status) : x);
      if (x.status === 409) setStale(true);
      if (x.status === 400) {
        setAttempt(null);
        remember(key, null);
      }
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/api/reviews/" + comparison.change_id);
      setComparison(r.change);
      setAttempt(null);
      remember(key, null);
      setAction("accept_proposal");
      setReason("");
      setReplacement("");
      setClear(false);
      setStale(false);
      setGone(false);
    } catch (e) {
      if (e.status === 404) {
        setGone(true);
        remember(key, null);
        setAttempt(null);
        setError(
          new Error(
            "This field has already been resolved. Open its submission to inspect the saved outcome.",
          ),
        );
      } else setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      ref={panel}
      className="panel review-panel"
      aria-labelledby="comparison-title"
    >
      <div className="section-title">
        <div>
          <p className="eyebrow">FIELD COMPARISON</p>
          <h2 id="comparison-title" tabIndex={-1}>
            {comparison.source_record_id} · {fields[comparison.field_name]}
          </h2>
        </div>
        <Status state={receipt ? receipt.field_state : "pending"} />
      </div>
      <p className="subtle">
        Submitted by {comparison.author_name ?? "surveyor"} · Observed{" "}
        {date(comparison.observed_at)}
      </p>
      <div className="comparison-grid">
        <div>
          <span>Base · v{comparison.base_version_no}</span>
          <strong>
            <Value
              value={comparison.base_value}
              field={comparison.field_name}
            />
          </strong>
        </div>
        <div>
          <span>
            {receipt ? "Reviewed accepted" : "Current accepted"} · v
            {comparison.current_version_no}
          </span>
          <strong>
            <Value
              value={comparison.current_value}
              field={comparison.field_name}
            />
          </strong>
        </div>
        <div className="proposed">
          <span>Proposed</span>
          <strong>
            <Value
              value={comparison.proposed_value}
              field={comparison.field_name}
            />
          </strong>
        </div>
      </div>
      <ErrorNotice error={error} />
      {stale ? (
        <div className="notice warning">
          <div>
            <strong>Refresh and reconsider before deciding.</strong>
            <p>
              The original comparison and approval tokens have been kept. They
              will not be changed automatically.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={refresh}
          >
            Refresh comparison
          </button>
        </div>
      ) : null}
      {attempt && !stale && !receipt ? (
        <div className="notice warning">
          <p>
            The last response is unconfirmed. Retry sends the exact same
            decision, reason, and version references.
          </p>
        </div>
      ) : null}
      {receipt ? (
        <div className="notice success" role="status">
          <div>
            <strong>Decision recorded</strong>
            <p>
              {receipt.version_no
                ? "Accepted version " + receipt.version_no + " was published."
                : "No new accepted version was needed."}
            </p>
          </div>
          <Link
            className="button secondary"
            href={"/submissions/" + comparison.submission_id}
          >
            View saved outcome
          </Link>
        </div>
      ) : (
        <form onSubmit={decide}>
          <fieldset disabled={locked} className="plain-fieldset">
            <legend className="label">Choose a disposition</legend>
            <div className="decision-options">
              {[
                [
                  "accept_proposal",
                  "Accept proposal",
                  "Use the submitted value.",
                ],
                [
                  "keep_current",
                  "Keep current",
                  "Reject this proposal and retain the accepted value.",
                ],
                [
                  "replace",
                  "Supply a replacement",
                  "Record another valid value with your reason.",
                ],
              ].map(([v, label, help]) => (
                <label
                  className={`radio-card ${action === v ? "chosen" : ""}`}
                  key={v}
                >
                  <input
                    type="radio"
                    name={"action-" + comparison.change_id}
                    value={v}
                    checked={action === v}
                    onChange={() => setAction(v)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{help}</small>
                  </span>
                </label>
              ))}
            </div>
            {action === "replace" ? (
              <div className="replacement">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={clear}
                    onChange={(e) => setClear(e.target.checked)}
                  />
                  Clear to unknown
                </label>
                {!clear ? (
                  <>
                    <label htmlFor={"replacement-" + comparison.change_id}>
                      Replacement {fields[comparison.field_name]}
                    </label>
                    <ScalarInput
                      id={"replacement-" + comparison.change_id}
                      field={comparison.field_name}
                      value={replacement}
                      onChange={setReplacement}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
            <label htmlFor={"reason-" + comparison.change_id}>
              Decision reason
            </label>
            <textarea
              id={"reason-" + comparison.change_id}
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </fieldset>
          <div className="editor-actions">
            <button className="button primary" disabled={busy || stale || gone}>
              {busy
                ? "Recording…"
                : attempt
                  ? "Retry exact decision"
                  : "Record decision"}
              <Icon name="review" size={17} />
            </button>
            <Link
              className="text-link"
              href={"/submissions/" + comparison.submission_id}
            >
              Open submission
            </Link>
            {!stale && !attempt ? (
              <button
                className="text-button"
                type="button"
                disabled={busy || gone}
                onClick={refresh}
              >
                Refresh comparison
              </button>
            ) : null}
          </div>
        </form>
      )}
      <details className="review-evidence" open>
        <summary>Original supporting evidence</summary>
        <SourceEvidence resource={evidence} />
      </details>
      <p className="field-help">
        Only this pending field receives a disposition. Other proposals remain
        in their own review queue.
      </p>
    </section>
  );
}
