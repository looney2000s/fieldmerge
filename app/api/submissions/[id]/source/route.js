import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {sourceFor} from '@/lib/intake.mjs';
import {uuid} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async(request,{params})=>{const {hash}=await authenticate(request);return response(await sourceFor(hash,uuid((await params).id)));});
