import {handled,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {recover} from '@/lib/intake.mjs';
import {uuid} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async(request,{params})=>{protectOrigin(request);const {hash}=await authenticate(request,'surveyor');return response(await recover(hash,uuid((await params).id)));});
