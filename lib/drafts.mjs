import {randomUUID} from 'node:crypto';
import {BSON,Int32} from 'mongodb';
import {isDeepStrictEqual} from 'node:util';
import {call,mongo} from './database.mjs';
import {bson,submit} from './intake.mjs';
import {ApiError,canonical,parseExact,integer,object,uuid,validateDraftPayload,validateSubmission} from './canonical.mjs';

const payloadKeys=['observed_at','patch','observations','client_metadata'];
async function actor(token){const user=await call('api_me',[token]);if(user.role!=='surveyor')throw new ApiError(403,'role_denied');return user.user_id;}
async function collection(){return(await mongo()).collection('submission_drafts');}
function partial(envelope){return Object.fromEntries(payloadKeys.filter(k=>Object.hasOwn(envelope,k)).map(k=>[k,envelope[k]]));}
function projection(payload){
 const out=bson(payload);
 if(Object.hasOwn(out,'observed_at'))out.observed_at=new Date(payload.observed_at);
 if(out.observations)out.observations=out.observations.map((o,i)=>({...o,observed_at:new Date(payload.observations[i].observed_at)}));
 return out;
}
function encode(envelope){const value=canonical(envelope);if(Buffer.byteLength(value)>262144)throw new ApiError(413,'submission_too_large');return value;}
function envelopeFor(doc,payload){return{client_submission_id:doc.client_submission_id,record_id:doc.record_id,base_version_no:parseExact(String(doc.base_version_no)),form_version:doc.form_version,...payload};}
function readEnvelope(doc){
 if(!doc.canonical_payload_json)throw new ApiError(409,'legacy_draft_save_required');
 const p=parseExact(doc.canonical_payload_json);
 object(p,['client_submission_id','record_id','base_version_no','form_version',...payloadKeys],['client_submission_id','record_id','base_version_no','form_version']);
 validateDraftPayload(partial(p),p.form_version);
 if(p.client_submission_id!==doc.client_submission_id||p.record_id!==doc.record_id||integer(p.base_version_no)!==doc.base_version_no||p.form_version!==doc.form_version
  ||canonical(p)!==doc.canonical_payload_json||!isDeepStrictEqual(BSON.EJSON.serialize(projection(partial(p)),{relaxed:false}),BSON.EJSON.serialize(doc.payload,{relaxed:false})))
  throw new ApiError(503,'draft_integrity_mismatch');
 return p;
}
function view(doc){return{draft_id:doc._id,record_id:doc.record_id,base_version_no:doc.base_version_no,form_version:doc.form_version,
 client_submission_id:doc.client_submission_id,revision_no:doc.revision_no,state:doc.state,created_at:doc.created_at,updated_at:doc.updated_at,
 final_submission_id:doc.final_submission_id,canonical_payload_json:doc.canonical_payload_json??null};}
async function owned(drafts,owner,id){const doc=await drafts.findOne({_id:uuid(id),owner_id:owner});if(!doc)throw new ApiError(404,'draft_not_found');return doc;}
function revision(doc,expected){if(doc.revision_no!==expected)throw new ApiError(409,'stale_draft_refresh_required');}
function editable(doc){if(doc.state!=='editable')throw new ApiError(409,'draft_is_sealed');}

export async function listDrafts(token){
 const owner=await actor(token),drafts=await collection();
 return(await drafts.find({owner_id:owner}).sort({updated_at:-1,_id:1}).limit(100).toArray()).map(view);
}
export async function getDraft(token,id){return view(await owned(await collection(),await actor(token),id));}
export async function createDraft(token,input){
 object(input,['record_id','base_version_no','form_version','payload'],['record_id','base_version_no','form_version']);
 uuid(input.record_id);integer(input.base_version_no);const payload=input.payload??{};
 // Explicit null is invalid even though an omitted payload starts an empty draft.
 if(Object.hasOwn(input,'payload')&&input.payload===null)throw new ApiError(400,'object_required');
 validateDraftPayload(payload,input.form_version);
 const context=await call('api_draft_context',[token,input.record_id,input.base_version_no.toNumber(),input.form_version]);
 const now=new Date(),doc={_id:randomUUID(),owner_id:context.owner_id,client_submission_id:randomUUID(),record_id:input.record_id,
  base_version_no:new Int32(input.base_version_no.toNumber()),form_version:input.form_version,revision_no:new Int32(1),state:'editable',
  payload:projection(payload),created_at:now,updated_at:now,final_submission_id:null};
 doc.canonical_payload_json=encode(envelopeFor(doc,payload));
 await(await collection()).insertOne(doc);
 return view({...doc,base_version_no:doc.base_version_no.valueOf(),revision_no:1});
}
export async function updateDraft(token,id,input){
 object(input,['expected_revision_no','payload']);const expected=integer(input.expected_revision_no);
 const owner=await actor(token),drafts=await collection(),doc=await owned(drafts,owner,id);revision(doc,expected);editable(doc);
 if(expected===2147483647)throw new ApiError(409,'draft_revision_limit');
 validateDraftPayload(input.payload,doc.form_version);
 await call('api_draft_context',[token,doc.record_id,doc.base_version_no,doc.form_version]);
 const clientId=randomUUID(),encoded=encode(envelopeFor({...doc,client_submission_id:clientId},input.payload));
 const updated=await drafts.findOneAndUpdate({_id:doc._id,owner_id:owner,state:'editable',revision_no:expected},
  {$set:{payload:projection(input.payload),canonical_payload_json:encoded,client_submission_id:clientId},$inc:{revision_no:new Int32(1)},$currentDate:{updated_at:true}},
  {returnDocument:'after',includeResultMetadata:false});
 if(!updated)throw new ApiError(409,'stale_draft_refresh_required');return view(updated);
}
export async function deleteDraft(token,id,input){
 object(input,['expected_revision_no']);const expected=integer(input.expected_revision_no);
 const owner=await actor(token),drafts=await collection(),doc=await owned(drafts,owner,id);revision(doc,expected);editable(doc);
 const result=await drafts.deleteOne({_id:doc._id,owner_id:owner,state:'editable',revision_no:expected});
 if(result.deletedCount!==1)throw new ApiError(409,'stale_draft_refresh_required');return{deleted:true,draft_id:doc._id};
}
// Failpoints are injected by tests, never from a route or client body.
export async function finalizeDraft(token,id,input,{afterFreeze,intakeHooks,afterIntake,afterFinalized}={}){
 object(input,['expected_revision_no']);const expected=integer(input.expected_revision_no);
 const owner=await actor(token),drafts=await collection();let doc=await owned(drafts,owner,id);revision(doc,expected);
 let envelope=readEnvelope(doc);validateSubmission(envelope);encode(envelope);
 if(doc.state==='editable'){
  await call('api_draft_context',[token,doc.record_id,doc.base_version_no,doc.form_version]);
  const frozen=await drafts.findOneAndUpdate({_id:doc._id,owner_id:owner,state:'editable',revision_no:expected},
   {$set:{state:'finalizing'},$currentDate:{updated_at:true}},{returnDocument:'after',includeResultMetadata:false});
  // A concurrent finalizer may have won. Read its sealed revision and resume only that exact request.
  doc=frozen??await owned(drafts,owner,id);revision(doc,expected);
  if(doc.state==='editable')throw new ApiError(409,'stale_draft_refresh_required');
  envelope=readEnvelope(doc);
 }
 await afterFreeze?.(doc);
 const receipt=await submit(token,envelope,intakeHooks);await afterIntake?.(receipt);
 const finalized=await drafts.findOneAndUpdate({_id:doc._id,owner_id:owner,state:'finalizing',revision_no:expected},
  {$set:{state:'finalized',final_submission_id:receipt.submission_id},$currentDate:{updated_at:true}},
  {returnDocument:'after',includeResultMetadata:false});
 doc=finalized??await owned(drafts,owner,id);
 if(doc.state!=='finalized'||doc.final_submission_id!==receipt.submission_id)throw new ApiError(503,'draft_integrity_mismatch');
 await afterFinalized?.(doc);
 return{draft:view(doc),receipt};
}
