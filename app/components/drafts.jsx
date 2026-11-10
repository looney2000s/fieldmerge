"use client";
import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  parseExact,
  canonical,
  Decimal,
  validateDraftPayload,
  validateSubmission,
} from "@/lib/envelope.mjs";
import {
  api,
  useResource,
  localTime,
  observedTime,
  stored,
  remember,
  downloadText,
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
} from "./ui.jsx";
const categories = ["guard", "trunk", "root", "branch", "other"];
export function ScalarInput({ field, value, onChange, id, disabled = false }) {
  if (field === "health")
    return (
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose health</option>
        {["Good", "Fair", "Poor"].map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
    );
  if (field === "guard_damage")
    return (
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose observation</option>
        <option value="true">Damage observed</option>
        <option value="false">No damage observed</option>
      </select>
    );
  return (
    <input
      id={id}
      value={value}
      disabled={disabled}
      maxLength={field === "species" ? 120 : 32}
      inputMode={field === "diameter_cm" ? "decimal" : undefined}
      placeholder={field === "diameter_cm" ? "0.00 cm" : "Enter species"}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
export function scalar(field, value) {
  if (field === "diameter_cm") {
    if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value))
      throw new RequestError("invalid_diameter", 400);
    return new Decimal(value);
  }
  if (field === "guard_damage") {
    if (!["true", "false"].includes(value))
      throw new Error("Choose a guard observation.");
    return value === "true";
  }
  if (!value.trim())
    throw new Error("Enter a value for " + fields[field] + ".");
  return value;
}
function initialFields(p) {
  return Object.fromEntries(
    Object.keys(fields).map((f) => [
      f,
      {
        mode: !Object.hasOwn(p.patch ?? {}, f)
          ? "omit"
          : p.patch[f] === null
            ? "clear"
            : "set",
        value:
          p.patch?.[f] === null || p.patch?.[f] === undefined
            ? ""
            : String(p.patch[f]),
      },
    ]),
  );
}
export function Drafts() {
  const resource = useResource("/api/drafts");
  return (
    <RoleGate role="surveyor">
      <PageTitle
        eyebrow="YOUR WORK IN PROGRESS"
        title="My drafts"
        description="Save observations against a known base. Finalized content stays sealed."
      >
        <Link className="button primary" href="/records">
          <Icon name="plus" size={17} />
          Choose a record
        </Link>
      </PageTitle>
      <Resource resource={resource}>
        {(data) =>
          data.drafts.length ? (
            <section className="draft-grid">
              {data.drafts.map((d) => (
                <Link
                  className="draft-card"
                  key={d.draft_id}
                  href={"/drafts/" + d.draft_id}
                >
                  <div className="card-top">
                    <span className="draft-symbol">
                      <Icon name="drafts" size={22} />
                    </span>
                    <Status state={d.state} />
                  </div>
                  <h2>
                    {d.source_record_id ?? "Record " + d.record_id.slice(-8)}
                  </h2>
                  <p>
                    Base v{d.base_version_no} <span className="slash">/</span>{" "}
                    {d.form_version} <span className="slash">/</span> Revision{" "}
                    {d.revision_no}
                  </p>
                  <div className="card-bottom">
                    <span>Updated {date(d.updated_at)}</span>
                    <Icon name="arrow" size={18} />
                  </div>
                </Link>
              ))}
            </section>
          ) : (
            <section className="panel">
              <Empty
                title="Your next observation starts here"
                description="Open an accepted record and create a draft from its version."
                href="/records"
                label="Browse records"
              />
            </section>
          )
        }
      </Resource>
    </RoleGate>
  );
}
export function NewDraft({ recordId, version }) {
  const router = useRouter(),
    resource = useResource(
      recordId
        ? "/api/records/" +
            recordId +
            "/snapshot" +
            (version ? "?version=" + version : "")
        : null,
    ),
    [form, setForm] = useState("tree-v2"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function create(s) {
    setBusy(true);
    setError(null);
    try {
      const selected = s.supported_forms.includes(form)
        ? form
        : s.supported_forms[0];
      if (!selected)
        throw new Error("No forms currently support new observations.");
      const r = await api("/api/drafts", {
        method: "POST",
        body: {
          record_id: s.record.record_id,
          base_version_no: s.record.version_no,
          form_version: selected,
          payload: { patch: {} },
        },
      });
      router.replace("/drafts/" + r.draft.draft_id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <RoleGate role="surveyor">
      <Link
        className="back-link"
        href={recordId ? "/records/" + recordId : "/drafts"}
      >
        ← Back
      </Link>
      <PageTitle
        eyebrow="A NEW FIELD OBSERVATION"
        title="Create a draft"
        description="The chosen accepted version remains the base for this proposal."
      />
      {!recordId ? (
        <section className="panel">
          <Empty
            title="Choose a tree first"
            description="Browse the accepted dataset, then start a draft from its snapshot."
            href="/records"
          />
        </section>
      ) : (
        <Resource resource={resource}>
          {(s) => (
            <section className="panel narrow">
              <div className="section-title">
                <h2>{s.record.source_record_id}</h2>
                <span className="version">Base v{s.record.version_no}</span>
              </div>
              <p>
                <Value value={s.record.species} />
              </p>
              <div className="notice info">
                <p>
                  Reference period: {date(s.campaign.starts_at)} —{" "}
                  {date(s.campaign.ends_at)}
                </p>
              </div>
              <ErrorNotice error={error} />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  create(s);
                }}
              >
                <label htmlFor="new-draft-form">Observation form</label>
                <select
                  id="new-draft-form"
                  value={
                    s.supported_forms.includes(form)
                      ? form
                      : (s.supported_forms[0] ?? "")
                  }
                  onChange={(e) => setForm(e.target.value)}
                >
                  {s.supported_forms.map((f) => (
                    <option key={f} value={f}>
                      {f === "tree-v2"
                        ? "Tree survey + repeated observations"
                        : "Tree survey · scalar fields"}
                    </option>
                  ))}
                </select>
                <p className="field-help">
                  You can save a partial draft. Observation time and content are
                  required before finalization.
                </p>
                <button
                  className="button primary"
                  disabled={busy || !s.record.is_active}
                >
                  {busy ? "Creating…" : "Create draft"}
                  <Icon name="arrow" size={17} />
                </button>
                {!s.record.is_active ? (
                  <p className="field-help">
                    This record is retired and cannot receive new proposals.
                  </p>
                ) : null}
              </form>
            </section>
          )}
        </Resource>
      )}
    </RoleGate>
  );
}
export function DraftPage({ id }) {
  const resource = useResource("/api/drafts/" + id);
  return (
    <RoleGate role="surveyor">
      <Resource resource={resource}>
        {(data) =>
          data.draft.canonical_payload_json ? (
            <DraftEditor
              key={data.draft.revision_no + ":" + data.draft.state}
              doc={data.draft}
              base={data.base}
              reload={resource.refresh}
            />
          ) : (
            <ErrorNotice
              error={
                new Error(
                  "This older draft has no canonical saved envelope. Create a new draft from its accepted record.",
                )
              }
            />
          )
        }
      </Resource>
    </RoleGate>
  );
}
function DraftEditor({ doc, base, reload }) {
  const { user } = useSession(),
    router = useRouter(),
    prefix = useId(),
    original = useMemo(
      () => parseExact(doc.canonical_payload_json),
      [doc.canonical_payload_json],
    ),
    [values, setValues] = useState(() => initialFields(original));
  const [time, setTime] = useState(() => localTime(original.observed_at)),
    [timeChanged, setTimeChanged] = useState(false),
    [observations, setObservations] = useState(() =>
      (original.observations ?? []).map((o) => ({
        ...o,
        key: crypto.randomUUID(),
        local: localTime(o.observed_at),
        changed: false,
      })),
    );
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(null),
    [error, setError] = useState(null),
    [pending, setPending] = useState(() =>
      stored(user.user_id + ":finalize:" + doc.draft_id),
    );
  const editable = doc.state === "editable" && !pending;
  useEffect(() => {
    if (!dirty) return;
    const stop = (e) => e.preventDefault();
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [dirty]);
  function changeField(field, part, v) {
    setValues((old) => ({ ...old, [field]: { ...old[field], [part]: v } }));
    setDirty(true);
  }
  function payload() {
    const patch = {};
    for (const f of Object.keys(fields)) {
      if (values[f].mode === "clear") patch[f] = null;
      else if (values[f].mode === "set") patch[f] = scalar(f, values[f].value);
    }
    const p = { patch },
      at = timeChanged ? observedTime(time) : original.observed_at;
    if (at) p.observed_at = at;
    if (original.client_metadata !== undefined)
      p.client_metadata = original.client_metadata;
    if (observations.length || original.observations !== undefined)
      p.observations = observations.map((o) => ({
        category: o.category,
        note: o.note,
        observed_at: o.changed ? observedTime(o.local) : o.observed_at,
      }));
    validateDraftPayload(p, doc.form_version);
    return p;
  }
  function notice(e) {
    return e.code && e.status ? new RequestError(e.code, e.status) : e;
  }
  async function save(e) {
    e.preventDefault();
    setError(null);
    setBusy("save");
    try {
      await api("/api/drafts/" + doc.draft_id, {
        method: "PUT",
        body: { expected_revision_no: doc.revision_no, payload: payload() },
      });
      setDirty(false);
      reload();
    } catch (x) {
      setError(notice(x));
    } finally {
      setBusy(null);
    }
  }
  async function finalize() {
    setError(null);
    let request = pending;
    if (!request) {
      try {
        validateSubmission(original);
      } catch (e) {
        setError(notice(e));
        return;
      }
      request = { revision: doc.revision_no };
      remember(user.user_id + ":finalize:" + doc.draft_id, request);
      setPending(request);
    }
    setBusy("finalize");
    try {
      const r = await api("/api/drafts/" + doc.draft_id + "/finalize", {
        method: "POST",
        body: { expected_revision_no: request.revision },
      });
      remember(user.user_id + ":finalize:" + doc.draft_id, null);
      router.push("/submissions/" + r.receipt.submission_id);
    } catch (x) {
      setError(x);
      if (x.status === 400) {
        remember(user.user_id + ":finalize:" + doc.draft_id, null);
        setPending(null);
        reload();
      }
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    setBusy("delete");
    setError(null);
    try {
      await api("/api/drafts/" + doc.draft_id, {
        method: "DELETE",
        body: { expected_revision_no: doc.revision_no },
      });
      setDirty(false);
      router.push("/drafts");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  function exportFile() {
    setError(null);
    try {
      validateSubmission(original);
      downloadText(
        "[" + doc.canonical_payload_json + "]\n",
        "fieldmerge-proposal-" + doc.draft_id + ".json",
      );
    } catch (e) {
      setError(notice(e));
    }
  }
  function updateObservation(key, part, v) {
    setObservations((rows) =>
      rows.map((o) =>
        o.key === key
          ? { ...o, [part]: v, ...(part === "local" ? { changed: true } : {}) }
          : o,
      ),
    );
    setDirty(true);
  }
  return (
    <>
      <Link className="back-link" href="/drafts">
        ← My drafts
      </Link>
      <PageTitle
        eyebrow="FIELD DRAFT"
        title={base?.record.source_record_id ?? "Saved observation"}
        description={
          <>
            Base v{doc.base_version_no} · Saved revision {doc.revision_no} ·{" "}
            {doc.form_version}
          </>
        }
      >
        <Status state={doc.state} />
        <button
          className="button secondary"
          disabled={!!busy || dirty}
          onClick={exportFile}
        >
          <Icon name="download" size={17} />
          Download upload file
        </button>
      </PageTitle>
      <ErrorNotice error={error} />
      {pending && doc.state === "editable" ? (
        <div className="notice warning">
          <p>
            The last finalization response is unconfirmed. Retry the same saved
            revision before making further changes.
          </p>
        </div>
      ) : null}
      {!editable ? (
        <div className="notice info">
          <div>
            <strong>
              {doc.state === "finalized"
                ? "This draft is finalized."
                : "This saved revision is sealed for finalization."}
            </strong>
            <p>
              Content is preserved. A correction should be a new proposal from
              an accepted snapshot.
            </p>
          </div>
          {doc.final_submission_id ? (
            <Link
              className="button secondary"
              href={"/submissions/" + doc.final_submission_id}
            >
              View outcome
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="draft-layout">
        <form className="draft-form" onSubmit={save}>
          <section className="panel">
            <div className="section-title">
              <h2>Proposed fields</h2>
              {dirty ? (
                <span className="unsaved">Unsaved changes</span>
              ) : (
                <span className="subtle">Saved revision</span>
              )}
            </div>
            <p className="subtle">
              No proposal leaves the accepted field untouched. Clear explicitly
              proposes an unknown value.
            </p>
            <fieldset disabled={!editable || !!busy} className="plain-fieldset">
              {Object.entries(fields).map(([field, label]) => (
                <div className="field-editor" key={field}>
                  <div>
                    <label htmlFor={prefix + "-" + field + "-mode"}>
                      {label}
                      {field === "diameter_cm" ? " (cm)" : ""}
                    </label>
                    <p className="field-help">
                      Base: <Value value={base?.record[field]} field={field} />
                    </p>
                  </div>
                  <div>
                    <select
                      id={prefix + "-" + field + "-mode"}
                      aria-label={label + " action"}
                      value={values[field].mode}
                      onChange={(e) =>
                        changeField(field, "mode", e.target.value)
                      }
                    >
                      <option value="omit">No proposal</option>
                      <option value="set">Set a value</option>
                      <option value="clear">Clear to unknown</option>
                    </select>
                    {values[field].mode === "set" ? (
                      <div className="scalar-input">
                        <label
                          className="sr-only"
                          htmlFor={prefix + "-" + field}
                        >
                          {label} value
                        </label>
                        <ScalarInput
                          field={field}
                          id={prefix + "-" + field}
                          value={values[field].value}
                          onChange={(v) => changeField(field, "value", v)}
                        />
                      </div>
                    ) : values[field].mode === "clear" ? (
                      <p className="field-help">
                        Propose an explicit unknown value.
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </fieldset>
          </section>
          <section className="panel">
            <h2>Observation time</h2>
            <fieldset disabled={!editable || !!busy} className="plain-fieldset">
              <label htmlFor={prefix + "-time"}>
                Observed at (your local time)
              </label>
              <div className="time-row">
                <input
                  id={prefix + "-time"}
                  type="datetime-local"
                  step="1"
                  value={time}
                  onChange={(e) => {
                    setTime(e.target.value);
                    setTimeChanged(true);
                    setDirty(true);
                  }}
                />
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setTime(localTime(new Date().toISOString()));
                    setTimeChanged(true);
                    setDirty(true);
                  }}
                >
                  Use current time
                </button>
              </div>
            </fieldset>
            <p className="field-help">
              Campaign: {date(base?.campaign.starts_at)} —{" "}
              {date(base?.campaign.ends_at)}. Observation times remain claimed
              evidence.
            </p>
          </section>
          {doc.form_version === "tree-v2" ? (
            <section className="panel">
              <div className="section-title">
                <h2>Supporting observations</h2>
                <span className="count">{observations.length} / 20</span>
              </div>
              <p className="subtle">
                Notes support review; they do not silently change scalar fields.
              </p>
              <fieldset
                className="plain-fieldset"
                disabled={!editable || !!busy}
              >
                {observations.map((o, i) => (
                  <div className="observation-editor" key={o.key}>
                    <div className="section-title">
                      <h3>Observation {i + 1}</h3>
                      <button
                        type="button"
                        className="text-button danger"
                        onClick={() => {
                          setObservations((rows) =>
                            rows.filter((x) => x.key !== o.key),
                          );
                          setDirty(true);
                        }}
                      >
                        Remove
                        <span className="sr-only"> observation {i + 1}</span>
                      </button>
                    </div>
                    <div className="two-columns">
                      <div>
                        <label htmlFor={o.key + "-category"}>Category</label>
                        <select
                          id={o.key + "-category"}
                          value={o.category}
                          onChange={(e) =>
                            updateObservation(o.key, "category", e.target.value)
                          }
                        >
                          {categories.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={o.key + "-time"}>
                          Observed time (local)
                        </label>
                        <input
                          id={o.key + "-time"}
                          type="datetime-local"
                          step="1"
                          value={o.local}
                          onChange={(e) =>
                            updateObservation(o.key, "local", e.target.value)
                          }
                        />
                      </div>
                    </div>
                    <label htmlFor={o.key + "-note"}>Observation note</label>
                    <textarea
                      id={o.key + "-note"}
                      maxLength={500}
                      value={o.note}
                      onChange={(e) =>
                        updateObservation(o.key, "note", e.target.value)
                      }
                      rows={3}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="button secondary"
                  disabled={observations.length >= 20}
                  onClick={() => {
                    const at = new Date().toISOString();
                    setObservations((rows) => [
                      ...rows,
                      {
                        key: crypto.randomUUID(),
                        category: "other",
                        note: "",
                        observed_at: at,
                        local: localTime(at),
                        changed: false,
                      },
                    ]);
                    setDirty(true);
                  }}
                >
                  <Icon name="plus" size={16} />
                  Add observation
                </button>
              </fieldset>
            </section>
          ) : null}
          <div className="editor-actions">
            <button
              className="button primary"
              disabled={!editable || !!busy || !dirty}
            >
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="button ghost danger"
              disabled={!editable || !!busy}
              onClick={remove}
            >
              Delete draft
            </button>
          </div>
        </form>
        <aside className="draft-aside">
          <section className="panel sticky-card">
            <p className="eyebrow">READY TO SUBMIT?</p>
            <h2>Finalize saved revision</h2>
            <p>
              Compatible changes publish together. Disagreements are held for
              review.
            </p>
            {dirty ? (
              <p className="field-help">
                Save your changes before finalizing or downloading.
              </p>
            ) : null}
            <button
              className="button primary full"
              disabled={!!busy || dirty || doc.state === "finalized"}
              onClick={finalize}
            >
              {busy === "finalize"
                ? "Finalizing…"
                : pending || doc.state === "finalizing"
                  ? "Retry finalization"
                  : "Finalize draft"}
              <Icon name="arrow" size={17} />
            </button>
            <button
              className="button secondary full"
              disabled={!!busy}
              onClick={reload}
            >
              Reload saved revision
            </button>
            <p className="field-help">
              A finalized envelope cannot be edited. Repeated finalization
              returns its saved outcome.
            </p>
            <div className="login-divider" />
            <span className="subtle">Draft reference</span>
            <p>
              <Reference id={doc.draft_id} />
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
