import {Decimal128,Int32,BSON} from 'mongodb';
import {isDeepStrictEqual} from 'node:util';
import {call,mongo} from './database.mjs';
import {canonical,sha256,validateSubmission,Decimal,ApiError,parseExact} from './canonical.mjs';

export function bson(value){
  if(value instanceof Decimal)return Decimal128.fromString(value.toString());
  if(Array.isArray(value))return value.map(bson);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,bson(v)]));
  return value;
}
export function payloadDocument(p){
  const out=bson(p);out.base_version_no=new Int32(p.base_version_no.toNumber());out.observed_at=new Date(p.observed_at);
  if(out.observations)out.observations=out.observations.map((o,i)=>({...o,observed_at:new Date(p.observations[i].observed_at)}));
  return out;
}
function plain(v){
  if(v instanceof Decimal128)return Number(v.toString());
  if(Array.isArray(v))return v.map(plain);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,plain(x)]));
  return v;
}
export function verifySource(doc,s,canonicalPayload,payload){
  if(!doc||doc._id!==s.submission_id||doc.author_id!==s.author_id||doc.client_submission_id!==s.client_submission_id
    ||doc.record_id!==s.record_id||doc.form_version!==s.form_version||doc.payload_hash!==s.payload_hash
    ||doc.canonical_payload_json!==canonicalPayload||sha256(doc.canonical_payload_json)!==s.payload_hash
    ||new Date(doc.received_at).getTime()!==new Date(s.received_at).getTime()
    ||!isDeepStrictEqual(BSON.EJSON.serialize(doc.payload,{relaxed:false}),BSON.EJSON.serialize(payload,{relaxed:false})))
    throw new ApiError(503,'source_integrity_mismatch');
}
export async function verifyDefinition(db,registry){
  if(!registry)throw new ApiError(503,'form_definition_unavailable');
  const definition=await db.collection('form_definitions').findOne({_id:registry.definition_id});
  if(!definition)throw new ApiError(503,'form_definition_unavailable');
  const definitionBody={_id:definition._id,form_version:definition.form_version,canonical_fields:plain(definition.canonical_fields),optional_sections:plain(definition.optional_sections)};
  if(definition.schema_hash!==registry.schema_hash||sha256(JSON.stringify(definitionBody))!==registry.schema_hash)throw new ApiError(503,'form_integrity_mismatch');
}
// Hooks are dependency-injection failpoints for integration tests, never read from HTTP.
export async function submit(token,p,{afterReserve,afterInsert,beforeFinish,afterFinish}={}){
  validateSubmission(p);
  const encoded=canonical(p);if(Buffer.byteLength(encoded)>262144)throw new ApiError(413,'submission_too_large');
  const hash=sha256(encoded),registry=await call('api_form',[token,p.form_version]),db=await mongo();
  if(!registry)throw new ApiError(400,'unsupported_form');
  await verifyDefinition(db,registry);
  const s=await call('api_reserve_submission',[token,p.client_submission_id,p.record_id,p.base_version_no.toNumber(),p.form_version,hash,p.observed_at]);
  await afterReserve?.(s);
  const payload=payloadDocument(p),collection=db.collection('submission_documents');
  const source={_id:s.submission_id,author_id:s.author_id,client_submission_id:s.client_submission_id,record_id:s.record_id,
    form_version:s.form_version,received_at:new Date(s.received_at),payload_hash:hash,canonical_payload_json:encoded,payload};
  try{await collection.insertOne(source);}catch(e){if(e.code!==11000)throw e;}
  await afterInsert?.(s);
  verifySource(await collection.findOne({_id:s.submission_id}),s,encoded,payload);
  await beforeFinish?.(s);
  // SQL marks ready and invokes reconciliation in the same transaction.
  const result=await call('api_finish_submission',[token,s.submission_id,hash,canonical(p.patch)]);
  await afterFinish?.(s);
  return result;
}
export async function sourceFor(token,id){
  const allowed=await call('api_submission',[token,id]);
  if(!allowed)throw new ApiError(404,'submission_not_found');
  const doc=await(await mongo()).collection('submission_documents').findOne({_id:id});
  if(!doc)throw new ApiError(503,'source_unavailable');
  return {canonical_payload_json:doc.canonical_payload_json,received_at:doc.received_at};
}
export async function recover(token,id){
  const allowed=await call('api_submission',[token,id]);if(!allowed)throw new ApiError(404,'submission_not_found');
  const doc=await(await mongo()).collection('submission_documents').findOne({_id:id});
  if(!doc)throw new ApiError(409,'source_missing_retry_original_upload');
  return submit(token,parseExact(doc.canonical_payload_json));
}
