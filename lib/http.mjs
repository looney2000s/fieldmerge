import {ApiError,parseExact} from './canonical.mjs';
export function response(value,status=200,headers={}){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});}
export function protectOrigin(request){
  if(request.headers.get('origin')!==process.env.APP_ORIGIN)throw new ApiError(403,'origin_denied');
}
export async function body(request,limit=262144){
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new ApiError(415,'json_required');
  let size=0;const pieces=[];const reader=request.body?.getReader();
  if(!reader)throw new ApiError(400,'body_required');
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new ApiError(413,'body_too_large');}pieces.push(value);}
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(pieces));}catch{throw new ApiError(400,'invalid_utf8');}
  return parseExact(text);
}
export function handled(fn){return async (...args)=>{
  try{return await fn(...args);}catch(e){
    if(e instanceof ApiError)return response({error:e.code},e.status);
    const statuses={'28000':401,'42501':403,'22023':409,'40001':409,'55000':409,'55P03':409,'P0002':404,'23503':400,'23514':400};
    if(statuses[e.code])return response({error:e.code==='40001'?'stale_review_refresh_required':e.code==='28000'?'authentication_required':'operation_denied',code:e.code},statuses[e.code]);
    console.error('FieldMerge operation failed',{name:e.name,code:e.code??'unavailable'});
    return response({error:'service_unavailable_retry_same_request'},503);
  }
};}
