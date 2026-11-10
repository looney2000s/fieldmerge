import { useCallback, useEffect, useState } from "react";
import { canonical } from "@/lib/envelope.mjs";
const messages = {
  authentication_required: "Your session ended. Sign in again.",
  invalid_credentials: "The email address or password was not recognised.",
  login_rate_limited: "Too many sign-in attempts. Try again in five minutes.",
  network_unavailable:
    "The service could not be reached. Keep this page open and retry the same request.",
  service_unavailable_retry_same_request:
    "The service is temporarily unavailable. Retry the same request.",
  stale_draft_refresh_required:
    "This draft changed. Reload the saved revision before editing or finalizing.",
  draft_is_sealed: "This draft is sealed and cannot be edited.",
  stale_review_refresh_required:
    "The accepted record changed. Refresh the comparison and reconsider your decision.",
  source_unavailable: "Original evidence is not available yet.",
  source_missing_retry_original_upload:
    "The original evidence is missing. Upload the unchanged original file.",
  workflow_integrity_failure:
    "Publication was stopped by an integrity check. No accepted changes were committed.",
  source_integrity_mismatch:
    "The stored evidence does not match the reserved source. Publication is on hold.",
  export_too_large_use_filters:
    "More than 5,000 records match. Narrow the filters before exporting.",
  empty_submission: "Select at least one proposed field or add an observation.",
  unexpected_or_missing_fields:
    "Complete the required fields before finalizing.",
  invalid_diameter:
    "Enter a diameter from 0 to 999999.99 with at most two decimal places.",
  invalid_timestamp: "Enter a valid observation date and time.",
  invalid_calendar_date: "Enter a real calendar date.",
  operation_denied:
    "This operation is not available in the current state. Refresh and check the latest status.",
  role_denied: "Your role does not permit this action.",
  draft_not_found:
    "This draft was not found or is not available to your account.",
  submission_not_found:
    "This submission was not found or is not available to your account.",
  batch_not_found:
    "This batch was not found or is not available to your account.",
};
export class RequestError extends Error {
  constructor(code, status) {
    super(
      messages[code] ??
        code?.replaceAll("_", " ") ??
        "The operation could not be completed.",
    );
    this.code = code;
    this.status = status;
  }
}
export const explain = (code) =>
  messages[code] ?? String(code ?? "Unknown error").replaceAll("_", " ");
async function checked(response, path) {
  if (response.ok) return response;
  let data;
  try {
    data = await response.json();
  } catch {}
  if (response.status === 401 && !path.startsWith("/api/auth/login"))
    window.dispatchEvent(new Event("fieldmerge:unauthorized"));
  throw new RequestError(
    data?.error ?? "service_unavailable_retry_same_request",
    response.status,
  );
}
export async function api(
  path,
  { method = "GET", body, raw, headers = {}, signal } = {},
) {
  let r;
  try {
    r = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        ...(body !== undefined || raw !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      body: raw ?? (body === undefined ? undefined : canonical(body)),
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new RequestError("network_unavailable", 0);
  }
  await checked(r, path);
  return r.json();
}
export function useResource(path) {
  const [revision, setRevision] = useState(0),
    [state, setState] = useState({ data: null, error: null, loading: true });
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState({ data: null, error: null, loading: true });
    api(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ data: null, error, loading: false });
      });
    return () => controller.abort();
  }, [path, revision]);
  return { ...state, refresh };
}
export function downloadText(text, name, type = "application/json") {
  const href = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
export async function download(path, name) {
  const r = await checked(
    await fetch(path, { credentials: "same-origin", cache: "no-store" }),
    path,
  );
  downloadText(
    await r.text(),
    name,
    r.headers.get("content-type") ?? "application/json",
  );
}
export function stored(key) {
  try {
    return JSON.parse(sessionStorage.getItem("fieldmerge:v1:" + key));
  } catch {
    return null;
  }
}
export function remember(key, value) {
  try {
    if (value === null) sessionStorage.removeItem("fieldmerge:v1:" + key);
    else sessionStorage.setItem("fieldmerge:v1:" + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function clearUserStorage(userId) {
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("fieldmerge:v1:" + userId + ":"))
        sessionStorage.removeItem(key);
  } catch {}
}
export function pendingReviews(userId) {
  try {
    const prefix = "fieldmerge:v1:" + userId + ":review:";
    return Object.keys(sessionStorage)
      .filter((k) => k.startsWith(prefix))
      .slice(0, 100)
      .flatMap((k) => {
        const value = JSON.parse(sessionStorage.getItem(k));
        return value?.raw && value?.comparison?.change_id
          ? [value.comparison]
          : [];
      });
  } catch {
    return [];
  }
}
export function localTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const observedTime = (value) => {
  if (!value) return undefined;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime()))
    throw new Error("Enter a valid date and time.");
  return d.toISOString();
};
export const query = (values) => {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== "" && value !== null && value !== undefined)
      p.set(key, String(value));
  return p.toString();
};
