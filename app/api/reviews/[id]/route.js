import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {uuid,object,integer,canonical,ApiError} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async(request,{params})=>{
  protectOrigin(request);const {hash}=await authenticate(request,'reviewer');
  const p=object(await body(request,8192),['client_decision_id','expected_version_no','expected_change_revision','action','chosen_value','reason'],['client_decision_id','expected_version_no','expected_change_revision','action','reason']);
  if(!['accept_proposal','keep_current','replace'].includes(p.action)||typeof p.reason!=='string'||!p.reason.trim()||p.reason.length>2000)throw new ApiError(400,'invalid_decision');
  if((p.action==='replace')!==Object.hasOwn(p,'chosen_value'))throw new ApiError(400,'replacement_value_required_only_for_replace');
  return response(await call('api_decide',[hash,uuid(p.client_decision_id),uuid((await params).id),integer(p.expected_version_no),integer(p.expected_change_revision),p.action,p.action==='replace'?canonical(p.chosen_value):null,p.reason]));
});
