import { ApiError, parseExact } from "./canonical.mjs";
import {
  requestContext,
  withSecurityContext,
  recordSecurityEvent,
} from "./security-events.mjs";
export function response(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
export function protectOrigin(request) {
  if (request.headers.get("origin") !== process.env.APP_ORIGIN)
    throw new ApiError(403, "origin_denied");
}
export async function body(request, limit = 262144) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new ApiError(415, "json_required");
  let size = 0;
  const pieces = [];
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "body_required");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large");
    }
    pieces.push(value);
  }
  if (size === 0) throw new ApiError(400, "body_required");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(pieces),
    );
  } catch {
    throw new ApiError(400, "invalid_utf8");
  }
  return parseExact(text);
}
export function handled(fn, { logFailure = recordSecurityEvent } = {}) {
  return async (...args) => {
    const context = requestContext(args[0]);
    return withSecurityContext(context, async () => {
      let result;
      try {
        result = await fn(...args);
      } catch (e) {
        if (e instanceof ApiError)
          result = response({ error: e.code }, e.status);
        else if (
          e.code === "23514" &&
          e.message?.startsWith("workflow integrity:")
        ) {
          result = response({ error: "workflow_integrity_failure" }, 503);
        } else {
          const statuses = {
            28000: 401,
            42501: 403,
            22023: 409,
            40001: 409,
            55000: 409,
            "55P03": 409,
            P0002: 404,
            23503: 400,
            23514: 400,
          };
          result = statuses[e.code]
            ? response(
                {
                  error:
                    e.code === "40001"
                      ? "stale_review_refresh_required"
                      : e.code === "28000"
                        ? "authentication_required"
                        : "operation_denied",
                  code: e.code,
                },
                statuses[e.code],
              )
            : response(
                { error: "service_unavailable_retry_same_request" },
                503,
              );
        }
        const failure = await result.clone().json();
        try {
          await logFailure(
            context,
            result.status,
            failure.error,
            e instanceof ApiError ? null : e.code,
          );
        } catch {
          console.error(
            JSON.stringify({
              event: "security_event_not_persisted",
              request_id: context.request_id,
            }),
          );
        }
      }
      result.headers.set("X-Request-Id", context.request_id);
      return result;
    });
  };
}
