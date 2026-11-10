import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {uuid,object,ApiError} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async(request,{params})=>{protectOrigin(request);const {hash}=await authenticate(request,'reviewer');const p=object(await body(request,8192),['reason']);if(typeof p.reason!=='string'||!p.reason.trim()||p.reason.length>500)throw new ApiError(400,'retry_reason_required');return response(await call('api_recovery_retry',[hash,uuid((await params).id),p.reason]));});
