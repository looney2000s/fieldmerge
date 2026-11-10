import { handled, body, protectOrigin, response } from "@/lib/http.mjs";
import { authenticate } from "@/lib/auth.mjs";
import { createDraft, listDrafts } from "@/lib/drafts.mjs";
import { call } from "@/lib/database.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handled(async (request) => {
  const { hash } = await authenticate(request, "surveyor");
  const drafts = await listDrafts(hash),
    labels = await call("api_record_labels", [
      hash,
      drafts.map((d) => d.record_id),
    ]);
  return response({
    drafts: drafts.map((d) => ({
      ...d,
      source_record_id: labels[d.record_id],
    })),
  });
});
export const POST = handled(async (request) => {
  protectOrigin(request);
  const { hash } = await authenticate(request, "surveyor");
  return response({ draft: await createDraft(hash, await body(request)) }, 201);
});
