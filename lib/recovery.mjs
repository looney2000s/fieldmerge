import {randomUUID} from 'node:crypto';
import {ApiError,canonical,parseExact,sha256,validateSubmission} from './canonical.mjs';
import {payloadDocument,verifySource,verifyDefinition} from './intake.mjs';
import {readEnvelope,completeDraft} from './drafts.mjs';
import {recoveryConnections} from './recovery-database.mjs';

function envelope(text){
 try{const p=parseExact(text);validateSubmission(p);if(canonical(p)!==text||Buffer.byteLength(text)>262144)throw new Error('noncanonical');return p;}
 catch{throw new ApiError(503,'invalid_stored_envelope');}
}
export function recoveryCode(error){
 const known=['source_integrity_mismatch','form_integrity_mismatch','draft_integrity_mismatch','invalid_stored_envelope','draft_missing','source_missing'];
 if(error instanceof ApiError&&known.includes(error.code))return error.code;
 if(error.code==='23514'&&error.message?.startsWith('workflow integrity:'))return 'workflow_integrity_failure';
 if(error.code==='22023')return 'request_identity_conflict';
 if(error.code==='42501')return 'actor_inactive';
 if(error.code==='55000')return 'prerequisite_unavailable';
 if(error.code==='55P03')return 'processing_busy';
 return 'service_unavailable';
}
export function createRecoveryWorker({connections=recoveryConnections(),workerId=randomUUID(),hooks={}}={}){
 let cursor=null;
 async function discover(){
  const db=await connections.mongo();
  const docs=await db.collection('submission_drafts').find({state:'finalizing',...(cursor?{_id:{$gt:cursor}}:{})},
   {projection:{_id:1,owner_id:1}}).sort({_id:1}).limit(50).toArray();
  let registered=0,failed=0;
  for(const doc of docs){try{await connections.call('worker_register_draft',[doc._id,doc.owner_id]);registered++;}catch{failed++;}cursor=doc._id;}
  if(docs.length<50)cursor=null;
  return{registered,failed};
 }
 async function processJob(job){
  const context=await connections.call('worker_context',[job.job_id,job.lease_token]),db=await connections.mongo();
  let source=context.submission,doc;
  if(job.job_kind==='draft'){
   doc=await db.collection('submission_drafts').findOne({_id:job.target_id,owner_id:job.owner_id});
   if(!doc)throw new ApiError(503,'draft_missing');
   if(!['finalizing','finalized'].includes(doc.state))throw new ApiError(503,'draft_integrity_mismatch');
   let p;try{p=readEnvelope(doc);validateSubmission(p);}catch{throw new ApiError(503,'draft_integrity_mismatch');}
   const text=canonical(p);if(Buffer.byteLength(text)>262144)throw new ApiError(503,'invalid_stored_envelope');
   await verifyDefinition(db,await connections.call('worker_form',[p.form_version]));
   source=await connections.call('worker_reserve_draft',[job.job_id,job.lease_token,p.client_submission_id,p.record_id,p.base_version_no.toNumber(),p.form_version,sha256(text),p.observed_at]);
   await hooks.afterReserve?.(job,source);
   const sealed={_id:source.submission_id,author_id:source.author_id,client_submission_id:source.client_submission_id,record_id:source.record_id,
    form_version:source.form_version,received_at:new Date(source.received_at),payload_hash:source.payload_hash,canonical_payload_json:text,payload:payloadDocument(p)};
   try{await db.collection('submission_documents').insertOne(sealed);}catch(e){if(e.code!==11000)throw e;}
   await hooks.afterInsert?.(job,source);
  }
  if(!source)throw new ApiError(503,'source_missing');
  const stored=await db.collection('submission_documents').findOne({_id:source.submission_id});
  if(!stored)throw new ApiError(503,'source_missing');
  const p=envelope(stored.canonical_payload_json),encoded=canonical(p);
  await verifyDefinition(db,await connections.call('worker_form',[source.form_version]));
  verifySource(stored,source,encoded,payloadDocument(p));
  const receipt=await connections.call('worker_finish_submission',[job.job_id,job.lease_token,sha256(encoded),canonical(p.patch)]);
  await hooks.afterFinish?.(job,receipt);
  if(doc){await completeDraft(db.collection('submission_drafts'),doc,receipt.submission_id);await hooks.afterDraftComplete?.(job,receipt);}
  await connections.call('worker_complete',[job.job_id,job.lease_token]);
  return receipt;
 }
 async function runOne(){
  const job=await connections.call('worker_claim',[workerId]);if(!job)return null;
  // A thrown failpoint simulates a dead worker: leave its persisted lease for a successor.
  await hooks.afterClaim?.(job);
  try{return{job_id:job.job_id,status:'completed',receipt:await processJob(job)};}
  catch(error){
   if(error?.injectedCrash)throw error;
   const code=recoveryCode(error),saved=await connections.call('worker_fail',[job.job_id,job.lease_token,code]);
   return{job_id:job.job_id,status:saved?'deferred':'claim_lost',code};
  }
 }
 async function tick(){
  let discovered=0,discoveryFailed=false;
  try{const found=await discover();discovered=found.registered;discoveryFailed=found.failed>0;}catch{discoveryFailed=true;}
  const results=[];for(let i=0;i<10;i++){const result=await runOne();if(!result)break;results.push(result);}
  return{discovered,discovery_failed:discoveryFailed,processed:results.length,results};
 }
 return{discover,runOne,tick,close:()=>connections.close()};
}
