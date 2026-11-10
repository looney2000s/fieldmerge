import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {uuid,ApiError} from '@/lib/canonical.mjs';
import {snapshotVersion} from '@/lib/read-queries.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async(request,{params})=>{const {hash}=await authenticate(request),id=uuid((await params).id);const snapshot=await call('api_snapshot_download',[hash,id,snapshotVersion(request.url)]);if(!snapshot)throw new ApiError(404,'snapshot_not_found');return response(snapshot,200,{'Content-Disposition':`attachment; filename="fieldmerge-${id}-v${snapshot.record.version_no}.json"`});});
