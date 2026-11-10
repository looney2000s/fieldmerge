import { handled, body, protectOrigin, response } from "@/lib/http.mjs";
import { authenticate } from "@/lib/auth.mjs";
import { getDraft, updateDraft, deleteDraft } from "@/lib/drafts.mjs";
import { call } from "@/lib/database.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handled(async (request, { params }) => {
  const { hash } = await authenticate(request, "surveyor");
  const draft = await getDraft(hash, (await params).id);
  return response({
    draft,
    base: await call("api_snapshot_download", [
      hash,
      draft.record_id,
      draft.base_version_no,
    ]),
  });
});
export const PUT = handled(async (request, { params }) => {
  protectOrigin(request);
  const { hash } = await authenticate(request, "surveyor");
  return response({
    draft: await updateDraft(hash, (await params).id, await body(request)),
  });
});
export const DELETE = handled(async (request, { params }) => {
  protectOrigin(request);
  const { hash } = await authenticate(request, "surveyor");
  return response(
    await deleteDraft(hash, (await params).id, await body(request, 8192)),
  );
});
