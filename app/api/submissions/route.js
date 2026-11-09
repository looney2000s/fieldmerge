import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {submit} from '@/lib/intake.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async request=>{protectOrigin(request);const {hash}=await authenticate(request,'surveyor');return response(await submit(hash,await body(request)));});
