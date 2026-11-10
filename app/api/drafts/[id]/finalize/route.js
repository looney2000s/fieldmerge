import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {finalizeDraft} from '@/lib/drafts.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async(request,{params})=>{protectOrigin(request);const {hash}=await authenticate(request,'surveyor');return response(await finalizeDraft(hash,(await params).id,await body(request,8192)));});
