import {handled,body,protectOrigin,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {submit} from '@/lib/intake.mjs';
import {ApiError,canonical,sha256,uuid} from '@/lib/canonical.mjs';
import {call} from '@/lib/database.mjs';
import {randomUUID} from 'node:crypto';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async request=>{
  protectOrigin(request);const {hash}=await authenticate(request,'surveyor');const items=await body(request,5*1024*1024);
  if(!Array.isArray(items)||!items.length||items.length>100)throw new ApiError(400,'batch_requires_1_to_100_items');
  const clientBatch=uuid(request.headers.get('x-fieldmerge-batch-id')??randomUUID());
  const batch=await call('api_register_batch',[hash,clientBatch,JSON.stringify(items.map(x=>sha256(canonical(x))))]);
  const results=[];
  for(let index=0;index<items.length;index++){
    try{results.push({index,ok:true,result:await submit(hash,items[index],{batch:{id:batch.batch_id,index}})});}
    catch(e){
      const error=e instanceof ApiError?e.code:e.code==='22023'?'idempotency_conflict':e.code==='23514'&&e.message?.startsWith('workflow integrity:')?'workflow_integrity_failure':'item_failed_retry_same_request';
      // Keep a returned error distinct from an error that could not be durably recorded.
      await call('api_batch_error',[hash,batch.batch_id,index,error]);results.push({index,ok:false,error});
    }
  }
  return response({...batch,results},207);
});
