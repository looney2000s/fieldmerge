import { handled, response } from "@/lib/http.mjs";
import { authenticate } from "@/lib/auth.mjs";
import { call } from "@/lib/database.mjs";
import { parameters } from "@/lib/read-queries.mjs";
import { ApiError } from "@/lib/canonical.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handled(async (request) => {
  const { hash } = await authenticate(request, "reviewer"),
    q = parameters(request.url, ["limit"]);
  const text = q.get("limit") ?? "50";
  if (!/^[1-9]\d{0,2}$/.test(text) || Number(text) > 100)
    throw new ApiError(400, "invalid_event_limit");
  return response({
    events: await call("api_security_events", [hash, Number(text)]),
  });
});
