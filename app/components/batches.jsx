"use client";
import { useState } from "react";
import Link from "next/link";
import { parseExact } from "@/lib/envelope.mjs";
import {
  api,
  useResource,
  stored,
  remember,
  explain,
  RequestError,
} from "./client.mjs";
import { useSession } from "./session.jsx";
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
export function Batches() {
  const { user } = useSession(),
    resource = useResource("/api/batches");
  return (
    <>
      <PageTitle
        eyebrow="DELAYED FIELD UPLOADS"
        title={user.role === "surveyor" ? "Batch uploads" : "Upload batches"}
        description="Each item keeps its own request identity and outcome. A failed item does not undo successful items."
      />
      {user.role === "surveyor" ? (
        <BatchUpload onUploaded={resource.refresh} />
      ) : null}
      <Resource resource={resource}>
        {(data) =>
          data.batches.length ? (
            <section className="panel table-panel">
              <div className="panel-heading">
                <h2>Recent batches</h2>
                <span className="subtle">Latest 100 visible uploads</span>
              </div>
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">Batch upload history</caption>
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>Created</th>
                      <th>Processed</th>
                      <th>Needs attention</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.batches.map((b) => (
                      <tr key={b.batch_id}>
                        <td>
                          <Reference id={b.batch_id} />
                          <span className="cell-secondary">{b.owner_name}</span>
                        </td>
                        <td>{date(b.created_at)}</td>
                        <td>
                          {b.processed_items} / {b.item_count}
                        </td>
                        <td>{b.error_items}</td>
                        <td>
                          <Link
                            className="text-link"
                            href={"/batches/" + b.batch_id}
                          >
                            View batch
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
                title="No upload batches yet"
                description={
                  user.role === "surveyor"
                    ? "Download an upload file from a saved draft, or choose a prepared survey file above."
                    : "Batches appear after surveyors upload their prepared files."
                }
              />
            </div>
          )
        }
      </Resource>
    </>
  );
}
function BatchUpload({ onUploaded }) {
  const { user } = useSession(),
    [file, setFile] = useState(null),
    [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState(null),
    [result, setResult] = useState(null);
  async function choose(e) {
    const selected = e.target.files?.[0];
    setError(null);
    setResult(null);
    setFile(null);
    if (!selected) return;
    setReading(true);
    try {
      if (selected.size > 5 * 1024 * 1024)
        throw new Error("Choose a JSON file no larger than 5 MiB.");
      const raw = await selected.text(),
        items = parseExact(raw);
      if (!Array.isArray(items) || !items.length || items.length > 100)
        throw new Error(
          "The upload file must contain an array of 1–100 submission envelopes.",
        );
      const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(raw),
        ),
        digest = Array.from(new Uint8Array(bytes), (x) =>
          x.toString(16).padStart(2, "0"),
        ).join("");
      const key = user.user_id + ":batch-file:" + digest,
        previous = stored(key),
        clientBatchId = previous?.clientBatchId ?? crypto.randomUUID();
      remember(key, { clientBatchId, name: selected.name });
      setFile({
        raw,
        name: selected.name,
        count: items.length,
        clientBatchId,
        key,
      });
    } catch (x) {
      setError(x.code ? new RequestError(x.code, x.status) : x);
    } finally {
      setReading(false);
    }
  }
  async function upload() {
    setError(null);
    setBusy(true);
    try {
      const data = await api("/api/submissions/batch", {
        method: "POST",
        raw: file.raw,
        headers: { "X-FieldMerge-Batch-Id": file.clientBatchId },
      });
      setResult(data);
      remember(file.key, {
        clientBatchId: file.clientBatchId,
        name: file.name,
        batchId: data.batch_id,
      });
      onUploaded();
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel upload-panel">
      <div className="upload-intro">
        <span className="upload-symbol">
          <Icon name="upload" size={28} />
        </span>
        <div>
          <h2>Upload prepared observations</h2>
          <p className="subtle">
            Choose a JSON array. Original request IDs and base versions are
            preserved.
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      <label className="drop-zone" htmlFor="batch-file">
        <strong>
          {reading
            ? "Reading file…"
            : file
              ? file.name
              : "Choose an upload file"}
        </strong>
        <span>
          {file
            ? `${file.count} item${file.count === 1 ? "" : "s"} · retry identity retained for this file`
            : "JSON · up to 100 items · maximum 5 MiB"}
        </span>
        <input
          id="batch-file"
          type="file"
          accept=".json,application/json"
          disabled={busy || reading}
          onChange={choose}
        />
      </label>
      <div className="editor-actions">
        <button
          className="button primary"
          disabled={!file || busy || reading}
          onClick={upload}
        >
          {busy ? "Uploading…" : result ? "Retry same file" : "Upload batch"}
          <Icon name="upload" size={17} />
        </button>
        {result ? (
          <Link className="text-link" href={"/batches/" + result.batch_id}>
            Inspect durable batch outcome
            <Icon name="arrow" size={15} />
          </Link>
        ) : null}
      </div>
      <p className="field-help">
        An unchanged retry uses the same batch identity. Corrected reserved
        content needs a new submission; it never overwrites sealed evidence.
      </p>
      {result ? (
        <div className="upload-results" aria-live="polite">
          <h3>Upload results</h3>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">
                Independent batch item results
              </caption>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Outcome</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.index}>
                    <td>{r.index + 1}</td>
                    <td>
                      {r.ok ? (
                        <Status state={r.result.state} />
                      ) : (
                        <span className="status red">Upload error</span>
                      )}
                    </td>
                    <td>
                      {r.ok ? (
                        <Link href={"/submissions/" + r.result.submission_id}>
                          Open submission
                        </Link>
                      ) : (
                        explain(r.error)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
export function BatchDetails({ id }) {
  const resource = useResource("/api/batches/" + id);
  return (
    <>
      <Link className="back-link" href="/batches">
        ← Upload batches
      </Link>
      <Resource resource={resource}>
        {(b) => (
          <>
            <PageTitle
              eyebrow="DURABLE UPLOAD OUTCOME"
              title={
                <>
                  Batch <Reference id={b.batch_id} />
                </>
              }
              description={
                b.item_count + " items · Created " + date(b.created_at)
              }
            >
              <button className="button secondary" onClick={resource.refresh}>
                Refresh outcomes
              </button>
            </PageTitle>
            <div className="notice info">
              <p>
                A batch tracks upload positions. A repeated logical submission
                keeps its original source and accepted effects.
              </p>
            </div>
            <section className="panel table-panel">
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Persisted batch item outcomes
                  </caption>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Current outcome</th>
                      <th>Attempt detail</th>
                      <th>Submission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.items.map((i) => (
                      <tr key={i.index}>
                        <td>{i.index + 1}</td>
                        <td>
                          <Status
                            state={
                              i.state ??
                              (i.error ? "upload_error" : "awaiting_upload")
                            }
                          />
                        </td>
                        <td>
                          {i.error ? (
                            <span
                              className={i.processed ? "subtle" : "error-text"}
                            >
                              {i.processed ? "Earlier attempt: " : ""}
                              {explain(i.error)}
                            </span>
                          ) : i.processed ? (
                            "Processed"
                          ) : (
                            "Waiting for original upload or recovery"
                          )}
                        </td>
                        <td>
                          {i.submission_id ? (
                            <Link href={"/submissions/" + i.submission_id}>
                              View outcome <Reference id={i.submission_id} />
                            </Link>
                          ) : (
                            "No source reserved"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </Resource>
    </>
  );
}
