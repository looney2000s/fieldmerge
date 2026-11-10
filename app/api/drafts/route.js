import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {createDraft,listDrafts} from '@/lib/drafts.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>{const {hash}=await authenticate(request,'surveyor');return response({drafts:await listDrafts(hash)});});
export const POST=handled(async request=>{protectOrigin(request);const {hash}=await authenticate(request,'surveyor');return response({draft:await createDraft(hash,await body(request))},201);});
