import Link from "next/link";
export const fields = {
  species: "Species",
  health: "Health",
  diameter_cm: "Trunk diameter",
  guard_damage: "Guard damage",
};
export const short = (id) => (id ? `…${id.slice(-8)}` : "—");
export function date(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not recorded";
}
export function valueText(value, field) {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "boolean")
    return field === "guard_damage"
      ? value
        ? "Damage observed"
        : "No damage observed"
      : value
        ? "Yes"
        : "No";
  return String(value) + (field === "diameter_cm" ? " cm" : "");
}
export function Value({ value, field }) {
  return (
    <span className={value === null || value === undefined ? "unknown" : ""}>
      {valueText(value, field)}
    </span>
  );
}
export function Status({ state }) {
  const tone = [
    "applied",
    "resolved",
    "finalized",
    "completed",
    "compatible",
  ].includes(state)
    ? "green"
    : [
          "needs_review",
          "partially_applied",
          "pending",
          "finalizing",
          "queued",
          "leased",
          "waiting_source",
          "ready",
          "processing",
        ].includes(state)
      ? "amber"
      : ["rejected", "blocked", "quarantined", "upload_error"].includes(state)
        ? "red"
        : "neutral";
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true" className="status-dot" />
      {String(state ?? "unknown").replaceAll("_", " ")}
    </span>
  );
}
export function Icon({ name = "tree", size = 20 }) {
  const paths = {
    tree: (
      <>
        <path d="m12 2 7 8h-4l5 6H4l5-6H5l7-8Z" />
        <path d="M12 16v6" />
      </>
    ),
    records: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M4 10h16M10 10v10" />
      </>
    ),
    drafts: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6M8 14h8M8 17h5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      </>
    ),
    review: (
      <>
        <path d="M9 4H5v16h14V4h-4M9 2h6v4H9zM8 12l3 3 5-6" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </>
    ),
    reports: (
      <>
        <path d="M4 20h16M7 16V9m5 7V4m5 12v-5" />
      </>
    ),
    recovery: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    logout: (
      <>
        <path d="M9 4H4v16h5m5-4 4-4-4-4m-5 4h12" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.records}
    </svg>
  );
}
export function PageTitle({ eyebrow, title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="description">{description}</p> : null}
      </div>
      {children ? <div className="heading-actions">{children}</div> : null}
    </div>
  );
}
export function Loading({ label = "Loading workspace…" }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
export function ErrorNotice({ error, retry }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      <div>
        <strong>We couldn’t complete that action.</strong>
        <p>{error.message ?? String(error)}</p>
      </div>
      {retry ? (
        <button className="button secondary small" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
export function Empty({
  title = "Nothing here yet",
  description,
  href,
  label,
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="tree" size={28} />
      </span>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {href ? (
        <Link className="button primary" href={href}>
          {label ?? "Browse records"}
          <Icon name="arrow" size={17} />
        </Link>
      ) : null}
    </div>
  );
}
export function Resource({ resource, children }) {
  if (resource.loading) return <Loading />;
  if (resource.error)
    return <ErrorNotice error={resource.error} retry={resource.refresh} />;
  return children(resource.data);
}
export function Reference({ id }) {
  return (
    <code className="reference" title={id ?? ""}>
      {short(id)}
    </code>
  );
}
export function Pager({ next, canPrevious, onNext, onPrevious }) {
  return (
    <div className="pager">
      <span>Live results · ordered by reference</span>
      <div className="button-group">
        <button
          className="button secondary small"
          disabled={!canPrevious}
          onClick={onPrevious}
        >
          Previous
        </button>
        <button
          className="button secondary small"
          disabled={!next}
          onClick={onNext}
        >
          Next page
        </button>
      </div>
    </div>
  );
}
