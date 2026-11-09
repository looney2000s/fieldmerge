import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {uuid} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async(request,{params})=>{const {hash}=await authenticate(request);return response(await call('api_history',[hash,uuid((await params).id)]));});
