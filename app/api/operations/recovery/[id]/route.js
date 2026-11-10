import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {uuid,ApiError} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async(request,{params})=>{const {hash}=await authenticate(request,'reviewer');const result=await call('api_recovery_detail',[hash,uuid((await params).id)]);if(!result)throw new ApiError(404,'recovery_job_not_found');return response(result);});
