import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {uuid,ApiError} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async(request,{params})=>{const {hash}=await authenticate(request);const result=await call('api_batch_detail',[hash,uuid((await params).id)]);if(!result)throw new ApiError(404,'batch_not_found');return response(result);});
