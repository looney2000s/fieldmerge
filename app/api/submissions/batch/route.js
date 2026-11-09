import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {submit} from '@/lib/intake.mjs';
import {ApiError} from '@/lib/canonical.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async request=>{
  protectOrigin(request);const {hash}=await authenticate(request,'surveyor');const items=await body(request,5*1024*1024);
  if(!Array.isArray(items)||!items.length||items.length>100)throw new ApiError(400,'batch_requires_1_to_100_items');
  const results=[];
  for(let index=0;index<items.length;index++){
    try{results.push({index,ok:true,result:await submit(hash,items[index])});}
    catch(e){results.push({index,ok:false,error:e instanceof ApiError?e.code:e.code==='22023'?'idempotency_conflict':'item_failed_retry_same_request'});}
  }
  return response({results},207);
});
