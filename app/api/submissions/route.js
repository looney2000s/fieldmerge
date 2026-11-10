import { handled, body, protectOrigin, response } from "@/lib/http.mjs";
import { authenticate } from "@/lib/auth.mjs";
import { submit } from "@/lib/intake.mjs";
import { call } from "@/lib/database.mjs";
import { parameters } from "@/lib/read-queries.mjs";
import { uuid, ApiError } from "@/lib/canonical.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handled(async (request) => {
  const { hash } = await authenticate(request),
    q = parameters(request.url, ["record_id", "state"]);
  const state = q.get("state");
  if (
    state !== null &&
    ![
      "awaiting_document",
      "ready",
      "processing",
      "needs_review",
      "partially_applied",
      "applied",
      "no_change",
      "resolved",
      "rejected",
    ].includes(state)
  )
    throw new ApiError(400, "invalid_submission_state");
  return response({
    submissions: await call("api_submission_list", [
      hash,
      q.has("record_id") ? uuid(q.get("record_id")) : null,
      state,
      100,
    ]),
  });
});
export const POST = handled(async (request) => {
  protectOrigin(request);
  const { hash } = await authenticate(request, "surveyor");
  return response(await submit(hash, await body(request)));
});
