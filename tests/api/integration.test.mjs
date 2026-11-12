import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {MongoClient} from 'mongodb';
import {submit} from '../../lib/intake.mjs';
import {createDraft,finalizeDraft} from '../../lib/drafts.mjs';
import {parseExact,sha256} from '../../lib/canonical.mjs';
import {closeConnections,pool} from '../../lib/database.mjs';
const base=process.env.API_BASE;
assert(/^fieldmerge_test_[a-f0-9]+$/.test(process.env.FM_TEST_DATABASE));
const accounts=JSON.parse(readFileSync('tmp/database-fixtures/demo-accounts.json','utf8'));
const admin=new pg.Client({host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??15432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.FM_TEST_DATABASE});
const mongoAdmin=new MongoClient(`mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT??27018}/?authSource=admin`);
let surveyor,reviewer,other,submissions=[];
async function request(path,{cookie,method='GET',value,raw,origin=base}={}){
 const headers={};if(cookie)headers.Cookie=cookie;if(method!=='GET'){headers.Origin=origin;headers['Content-Type']='application/json';}
 const res=await fetch(base+path,{method,headers,body:raw??(value===undefined?undefined:JSON.stringify(value))});
 return {status:res.status,body:await res.json(),headers:res.headers};
}
async function signIn(account){const r=await request('/api/auth/login',{method:'POST',value:{email:account.email,password:account.password}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);return r.headers.get('set-cookie').split(';')[0];}
function envelope(patch,{record='30000000-0000-4000-8000-000000000001',version=1}={}){return{client_submission_id:randomUUID(),record_id:record,base_version_no:version,form_version:'tree-v2',observed_at:'2026-06-01T00:00:00Z',patch};}
before(async()=>{
 await admin.connect();await mongoAdmin.connect();surveyor=await signIn(accounts[0]);reviewer=await signIn(accounts[1]);
 const id=randomUUID(),email=id+'@test.invalid';await admin.query('INSERT INTO fieldmerge.app_users(user_id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5)',[id,email,accounts[0].password_hash,'Other surveyor','surveyor']);
 other=await signIn({email,password:accounts[0].password});
});
after(async()=>{await admin.end();await mongoAdmin.close();await closeConnections();});
test('authentication, origin checks and SQL privilege boundary',async()=>{
 assert.equal((await request('/api/records')).status,401);
 assert.equal((await request('/api/auth/login',{method:'POST',origin:'https://evil.invalid',value:{email:accounts[0].email,password:accounts[0].password}})).status,403);
 assert.equal((await request('/api/auth/login',{method:'POST',value:{email:accounts[0].email,password:'incorrect'}})).status,401);
 const me=await request('/api/auth/me',{cookie:surveyor});assert.equal(me.body.user.role,'surveyor');assert.equal(me.body.user.password_hash,undefined);
 const records=await request('/api/records',{cookie:surveyor});assert.equal(records.status,200);assert.equal(records.body.records.length,3);
 await assert.rejects(pool().query('SELECT * FROM fieldmerge.app_users'),e=>e.code==='42501');
 await assert.rejects(pool().query("SELECT fieldmerge.review_change(NULL,NULL,NULL,1,1,'keep_current',NULL,'forged')"),e=>e.code==='42501');
 await assert.rejects(pool().query('SELECT * FROM fieldmerge_auth.sessions'),e=>e.code==='42501');
 await assert.rejects(pool().query('SET ROLE fieldmerge_workflow'),e=>e.code==='42501');
 await assert.rejects(pool().query('SELECT fieldmerge.api_pending($1)',[sha256(surveyor.split('=')[1])]),e=>e.code==='42501');
 await assert.rejects(pool().query("SELECT fieldmerge.api_decide($1,$2,$3,1,1,'keep_current',NULL,'forged')",[sha256(surveyor.split('=')[1]),randomUUID(),randomUUID()]),e=>e.code==='42501');
});
test('verified intake publishes once and rejects changed-content retries',async()=>{
 const p=envelope({diameter_cm:32,guard_damage:false});const first=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});
 assert.equal(first.status,200);assert.equal(first.body.state,'applied');submissions.push(first.body.submission_id);
 const retry=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});assert.deepEqual(retry.body,first.body);
 assert.equal((await request('/api/submissions',{cookie:surveyor,method:'POST',value:{...p,patch:{diameter_cm:33}}})).status,409);
 const source=await request(`/api/submissions/${first.body.submission_id}/source`,{cookie:surveyor});assert.equal(source.status,200);
 const payload=JSON.parse(source.body.canonical_payload_json);assert.equal(payload.patch.guard_damage,false);
 assert.equal((await request(`/api/submissions/${first.body.submission_id}`,{cookie:other})).status,404);
 assert.equal((await request(`/api/submissions/${first.body.submission_id}/source`,{cookie:other})).status,404);
 const row=(await admin.query('SELECT count(*) FROM fieldmerge.submissions WHERE author_id=$1 AND client_submission_id=$2',[accounts[0].user_id,p.client_submission_id])).rows[0];assert.equal(row.count,'1');
});
test('reviewer flow enforces roles, stale tokens, and idempotent approval',async()=>{
 assert.equal((await request('/api/reviews',{cookie:surveyor})).status,403);
 assert.equal((await request('/api/submissions',{cookie:reviewer,method:'POST',value:envelope({health:'Poor'})})).status,403);
 const pending=await request('/api/submissions',{cookie:surveyor,method:'POST',value:envelope({diameter_cm:36})});assert.equal(pending.body.state,'needs_review');
 const queue=await request('/api/reviews',{cookie:reviewer});assert.equal(queue.status,200);const c=queue.body.changes.find(x=>x.submission_id===pending.body.submission_id);assert(c);
 const decision={client_decision_id:randomUUID(),expected_version_no:c.current_version_no,expected_change_revision:c.revision_no,action:'accept_proposal',reason:'Reviewed integration fixture'};
 assert.equal((await request('/api/reviews/'+c.change_id,{cookie:surveyor,method:'POST',value:decision})).status,403);
 assert.equal((await request('/api/reviews/'+c.change_id,{cookie:reviewer,method:'POST',value:{...decision,expected_version_no:1}})).status,409);
 const accepted=await request('/api/reviews/'+c.change_id,{cookie:reviewer,method:'POST',value:decision});assert.equal(accepted.status,200);assert.equal(accepted.body.state,'resolved');
 assert.deepEqual((await request('/api/reviews/'+c.change_id,{cookie:reviewer,method:'POST',value:decision})).body,accepted.body);
 const history=await request('/api/records/'+c.record_id+'/history',{cookie:surveyor});assert.equal(history.status,200);assert(history.body.provenance.some(p=>p.field_name==='diameter_cm'&&p.reviewer_id===accounts[1].user_id));
});
test('strict JSON input rejects forged identities, duplicate keys and excess precision',async()=>{
 const p=envelope({health:'Fair'});
 assert.equal((await request('/api/submissions',{cookie:surveyor,method:'POST',value:{...p,author_id:accounts[1].user_id}})).status,400);
 assert.equal((await request('/api/submissions',{cookie:surveyor,method:'POST',raw:'{"record_id":"a","record_id":"b"}'})).status,400);
 const raw=JSON.stringify(envelope({diameter_cm:30})).replace('"diameter_cm":30','"diameter_cm":30.000000000000000001');
 assert.equal((await request('/api/submissions',{cookie:surveyor,method:'POST',raw})).status,400);
 const missingBase=await request('/api/submissions',{cookie:surveyor,method:'POST',value:envelope({health:'Poor'},{version:999})});assert.equal(missingBase.status,400);assert.equal(missingBase.body.error,'base_version_not_found');
});
test('evidence-only source, explicit null/zero and independent batch items',async()=>{
 const p=envelope({});p.observations=[{category:'guard',note:'Unknown condition',observed_at:p.observed_at}];
 const evidence=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});assert.equal(evidence.status,200);assert.equal(evidence.body.state,'no_change');
 const batch=await request('/api/submissions/batch',{cookie:surveyor,method:'POST',value:[envelope({diameter_cm:0,health:null},{record:'30000000-0000-4000-8000-000000000002'}),envelope({diameter_cm:-1})]});
 assert.equal(batch.status,207);assert.equal(batch.body.results[0].ok,true);assert.equal(batch.body.results[1].ok,false);
 const snapshot=await request('/api/records/30000000-0000-4000-8000-000000000002',{cookie:surveyor});assert.equal(snapshot.body.record.diameter_cm,0);assert.equal(snapshot.body.record.health,null);
});
test('interrupted intake and lost responses recover once against real stores',async()=>{
 const hash=sha256(surveyor.split('=')[1]);const db=mongoAdmin.db(process.env.MONGODB_DATABASE);
 for(const stage of ['afterReserve','afterInsert','beforeFinish','afterFinish']){
  const current=(await admin.query("SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id='30000000-0000-4000-8000-000000000003'")).rows[0].n;
  const p=envelope({species:'Recovery '+stage},{record:'30000000-0000-4000-8000-000000000003',version:current});
  await assert.rejects(submit(hash,parseExact(JSON.stringify(p)),{[stage]:()=>{throw new Error('injected interruption');}}),/injected interruption/);
  const row=(await admin.query('SELECT * FROM fieldmerge.submissions WHERE author_id=$1 AND client_submission_id=$2',[accounts[0].user_id,p.client_submission_id])).rows[0];
  assert.equal(row.state,stage==='afterFinish'?'applied':'awaiting_document');
  assert.equal(await db.collection('submission_documents').countDocuments({_id:row.submission_id}),stage==='afterReserve'?0:1);
  if(stage==='afterReserve')assert.equal((await request(`/api/submissions/${row.submission_id}/recover`,{cookie:surveyor,method:'POST'})).status,409);
  if(stage==='afterInsert'||stage==='beforeFinish'){
   assert.equal((await request(`/api/submissions/${row.submission_id}/recover`,{cookie:other,method:'POST'})).status,404);
   assert.equal((await request(`/api/submissions/${row.submission_id}/recover`,{cookie:surveyor,method:'POST'})).status,200);
  }
  const retry=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});assert.equal(retry.status,200);
  assert.equal(await db.collection('submission_documents').countDocuments({_id:row.submission_id}),1);
  assert.equal((await admin.query("SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='submission_reconciled'",[row.submission_id])).rows[0].count,'1');
 }
});
test('tampered source evidence blocks publication',async()=>{
 const hash=sha256(surveyor.split('=')[1]);const p=envelope({species:'Tamper fixture'},{record:'30000000-0000-4000-8000-000000000003'});
 let id;await assert.rejects(submit(hash,parseExact(JSON.stringify(p)),{afterInsert:s=>{id=s.submission_id;throw new Error('pause');}}));
 const docs=mongoAdmin.db(process.env.MONGODB_DATABASE).collection('submission_documents');await docs.updateOne({_id:id},{$set:{payload_hash:'b'.repeat(64)}});
 const retry=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});assert.equal(retry.status,503);assert.equal(retry.body.error,'source_integrity_mismatch');
 assert.equal((await admin.query('SELECT state FROM fieldmerge.submissions WHERE submission_id=$1',[id])).rows[0].state,'awaiting_document');
});
test('disabled account, expired session and logout revoke access',async()=>{
 const cookie=await signIn(accounts[0]);const hash=sha256(cookie.split('=')[1]);
 await admin.query('UPDATE fieldmerge.app_users SET is_active=false WHERE user_id=$1',[accounts[0].user_id]);
 assert.equal((await request('/api/auth/me',{cookie})).status,401);
 await admin.query('UPDATE fieldmerge.app_users SET is_active=true WHERE user_id=$1',[accounts[0].user_id]);
 await admin.query("UPDATE fieldmerge_auth.sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash]);
 assert.equal((await request('/api/auth/me',{cookie})).status,401);
 const fresh=await signIn(accounts[0]);assert.equal((await request('/api/auth/logout',{cookie:fresh,method:'POST'})).status,200);
 assert.equal((await request('/api/auth/me',{cookie:fresh})).status,401);
});
test('login attempts are limited persistently at the database boundary',async()=>{
 const email=randomUUID()+'@missing.invalid';
 for(let i=0;i<10;i++)assert.equal((await request('/api/auth/login',{method:'POST',value:{email,password:'invalid'}})).status,401);
 assert.equal((await request('/api/auth/login',{method:'POST',value:{email,password:'invalid'}})).status,429);
});

async function currentDraftInput(payload={}){
 const record='30000000-0000-4000-8000-000000000003';
 const version=(await admin.query('SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1',[record])).rows[0].n;
 return{record_id:record,base_version_no:version,form_version:'tree-v2',payload};
}
const draftPath=id=>'/api/drafts/'+id;
test('draft CRUD enforces ownership, roles, references and explicit revisions',async()=>{
 assert.equal((await request('/api/drafts')).status,401);
 assert.equal((await request('/api/drafts',{cookie:reviewer})).status,403);
 const input=await currentDraftInput();
 for(const bad of [{...input,owner_id:accounts[1].user_id},{...input,payload:null},{...input,payload:{patch:{diameter_cm:-1}}}])assert.equal((await request('/api/drafts',{cookie:surveyor,method:'POST',value:bad})).status,400);
 assert.equal((await request('/api/drafts',{cookie:surveyor,method:'POST',value:{...input,base_version_no:999999}})).status,409);
 const created=await request('/api/drafts',{cookie:surveyor,method:'POST',value:input});assert.equal(created.status,201);
 const d=created.body.draft;assert.equal(d.state,'editable');assert.equal(d.revision_no,1);
 for(const method of ['GET','PUT','DELETE','POST']){
  const path=draftPath(d.draft_id)+(method==='POST'?'/finalize':'');
  const value=method==='GET'?undefined:method==='PUT'?{expected_revision_no:1,payload:{}}:{expected_revision_no:1};
  assert.equal((await request(path,{cookie:other,method,value})).status,404);
 }
 // A well-shaped finalize body also hides another owner's draft.
 assert.equal((await request(draftPath(d.draft_id)+'/finalize',{cookie:other,method:'POST',value:{expected_revision_no:1}})).status,404);
 assert.equal((await request(draftPath(d.draft_id),{cookie:reviewer})).status,403);
 assert.equal((await request('/api/drafts',{cookie:other})).body.drafts.some(x=>x.draft_id===d.draft_id),false);
 assert.equal((await request(draftPath(d.draft_id)+'/finalize',{cookie:surveyor,method:'POST',value:{expected_revision_no:1}})).status,400);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor})).body.draft.state,'editable');
 assert.equal((await admin.query('SELECT count(*) FROM fieldmerge.submissions WHERE client_submission_id=$1',[d.client_submission_id])).rows[0].count,'0');
 const payload={observed_at:'2026-06-01T00:00:00Z',patch:{guard_damage:false,health:null}};
 const edited=await request(draftPath(d.draft_id),{cookie:surveyor,method:'PUT',value:{expected_revision_no:1,payload}});assert.equal(edited.status,200);assert.equal(edited.body.draft.revision_no,2);
 assert.notEqual(edited.body.draft.client_submission_id,d.client_submission_id);
 assert.equal(JSON.parse(edited.body.draft.canonical_payload_json).patch.guard_damage,false);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'PUT',value:{expected_revision_no:1,payload:{}}})).status,409);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'DELETE',value:{expected_revision_no:1}})).status,409);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'DELETE',value:{expected_revision_no:2}})).status,200);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor})).status,404);
 await assert.rejects(pool().query('SELECT fieldmerge.api_draft_context($1,$2,1,$3)',[sha256(reviewer.split('=')[1]),input.record_id,input.form_version]),e=>e.code==='42501');
});

test('concurrent draft edits reject lost updates',async()=>{
 const created=await request('/api/drafts',{cookie:surveyor,method:'POST',value:await currentDraftInput()});const id=created.body.draft.draft_id;
 const edits=await Promise.all(['Good','Poor'].map(health=>request(draftPath(id),{cookie:surveyor,method:'PUT',value:{expected_revision_no:1,payload:{patch:{health}}}})));
 assert.deepEqual(edits.map(x=>x.status).sort(),[200,409]);
 const saved=(await request(draftPath(id),{cookie:surveyor})).body.draft;assert.equal(saved.revision_no,2);
 assert.equal(JSON.parse(saved.canonical_payload_json).patch.health,JSON.parse(edits.find(x=>x.status===200).body.draft.canonical_payload_json).patch.health);
});

test('concurrent finalization seals one request and publishes once',async()=>{
 const payload={observed_at:'2026-06-01T01:30:00.123456789+01:30',patch:{species:'Finalization fixture',diameter_cm:0,guard_damage:false}};
 const created=await request('/api/drafts',{cookie:surveyor,method:'POST',value:await currentDraftInput(payload)});const d=created.body.draft;
 const results=await Promise.all([1,2].map(()=>request(draftPath(d.draft_id)+'/finalize',{cookie:surveyor,method:'POST',value:{expected_revision_no:1}})));
 for(const r of results){assert.equal(r.status,200);assert.equal(r.body.draft.state,'finalized');}
 assert.deepEqual(results[0].body.receipt,results[1].body.receipt);
 const id=results[0].body.receipt.submission_id;
 assert.equal((await admin.query('SELECT count(*) FROM fieldmerge.submissions WHERE author_id=$1 AND client_submission_id=$2',[accounts[0].user_id,d.client_submission_id])).rows[0].count,'1');
 assert.equal((await admin.query("SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='submission_reconciled'",[id])).rows[0].count,'1');
 const source=await request('/api/submissions/'+id+'/source',{cookie:surveyor});assert.equal(source.body.canonical_payload_json,d.canonical_payload_json);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'PUT',value:{expected_revision_no:1,payload:{}}})).status,409);
 assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'DELETE',value:{expected_revision_no:1}})).status,409);
 assert.deepEqual((await request(draftPath(d.draft_id)+'/finalize',{cookie:surveyor,method:'POST',value:{expected_revision_no:1}})).body.receipt,results[0].body.receipt);
});

test('frozen drafts resume across interruption boundaries with the same identity',async()=>{
 const token=sha256(surveyor.split('=')[1]);
 const stages=[['afterFreeze',{}],['afterReserve',{intakeHooks:{afterReserve:()=>{throw new Error('injected');}}}],['afterInsert',{intakeHooks:{afterInsert:()=>{throw new Error('injected');}}}],['afterIntake',{}],['afterFinalized',{}]];
 for(const [stage,extra]of stages){
  const input=await currentDraftInput({observed_at:'2026-06-01T00:00:00Z',patch:{species:'Draft recovery '+stage}});
  const d=await createDraft(token,parseExact(JSON.stringify(input)));
  const hooks=Object.keys(extra).length?extra:{[stage]:()=>{throw new Error('injected');}};
  await assert.rejects(finalizeDraft(token,d.draft_id,parseExact('{"expected_revision_no":1}'),hooks),/injected/);
  const read=(await request(draftPath(d.draft_id),{cookie:surveyor})).body.draft;
  assert.equal(read.state,stage==='afterFinalized'?'finalized':'finalizing');
  assert.equal(read.canonical_payload_json,d.canonical_payload_json);
  assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'PUT',value:{expected_revision_no:1,payload:{}}})).status,409);
  assert.equal((await request(draftPath(d.draft_id),{cookie:surveyor,method:'DELETE',value:{expected_revision_no:1}})).status,409);
  const recovered=await request(draftPath(d.draft_id)+'/finalize',{cookie:surveyor,method:'POST',value:{expected_revision_no:1}});assert.equal(recovered.status,200);
  assert.equal(recovered.body.draft.state,'finalized');
  const id=recovered.body.receipt.submission_id;
  assert.equal((await admin.query('SELECT count(*) FROM fieldmerge.submissions WHERE client_submission_id=$1 AND author_id=$2',[d.client_submission_id,accounts[0].user_id])).rows[0].count,'1');
  assert.equal((await admin.query("SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='submission_reconciled'",[id])).rows[0].count,'1');
 }
});

test('editing or deleting while finalization races has one winning transition',async()=>{
 for(const method of ['PUT','DELETE']){
  const created=await request('/api/drafts',{cookie:surveyor,method:'POST',value:await currentDraftInput({observed_at:'2026-06-01T00:00:00Z',patch:{species:'Race '+method}})});
  const d=created.body.draft,path=draftPath(d.draft_id);
  const value=method==='PUT'?{expected_revision_no:1,payload:{observed_at:'2026-06-01T00:00:00Z',patch:{species:'Edited race'}}}:{expected_revision_no:1};
  const [mutation,finalized]=await Promise.all([request(path,{cookie:surveyor,method,value}),request(path+'/finalize',{cookie:surveyor,method:'POST',value:{expected_revision_no:1}})]);
  if(finalized.status===200){assert.equal(mutation.status,409);assert.equal(finalized.body.draft.state,'finalized');}
  else {assert.equal(mutation.status,200);assert([404,409].includes(finalized.status));}
  const rows=(await admin.query('SELECT count(*) FROM fieldmerge.submissions WHERE author_id=$1 AND client_submission_id=$2',[accounts[0].user_id,d.client_submission_id])).rows[0];
  assert.equal(rows.count,finalized.status===200?'1':'0');
 }
});

test('commit-time integrity rejection is operational and retry preserves one publication',async()=>{
 const input=await currentDraftInput(),p=envelope({species:'API integrity '+randomUUID()},{record:input.record_id,version:input.base_version_no});
 await admin.query(`CREATE FUNCTION public.api_test_corrupt_snapshot() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
  IF NEW.version_no>1 THEN NEW.health:=CASE WHEN NEW.health IS DISTINCT FROM 'Poor' THEN 'Poor' ELSE 'Good' END;END IF;RETURN NEW;END $f$;
  CREATE TRIGGER api_test_corrupt_snapshot BEFORE INSERT ON fieldmerge.accepted_versions FOR EACH ROW EXECUTE FUNCTION public.api_test_corrupt_snapshot();`);
 try{
  const failed=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});assert.equal(failed.status,503);assert.equal(failed.body.error,'workflow_integrity_failure');
  const row=(await admin.query('SELECT state,source_verified_at,reconciliation_result FROM fieldmerge.submissions WHERE author_id=$1 AND client_submission_id=$2',[accounts[0].user_id,p.client_submission_id])).rows[0];
  assert.equal(row.state,'awaiting_document');assert.equal(row.source_verified_at,null);assert.equal(row.reconciliation_result,null);
  assert.equal((await admin.query('SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1',[input.record_id])).rows[0].n,input.base_version_no);
 }finally{
  await admin.query('DROP TRIGGER api_test_corrupt_snapshot ON fieldmerge.accepted_versions;DROP FUNCTION public.api_test_corrupt_snapshot();');
 }
 const retried=await request('/api/submissions',{cookie:surveyor,method:'POST',value:p});assert.equal(retried.status,200);assert.equal(retried.body.state,'applied');
 assert.equal((await admin.query("SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='submission_reconciled'",[retried.body.submission_id])).rows[0].count,'1');
 assert.equal((await admin.query('SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1',[input.record_id])).rows[0].n,input.base_version_no+1);
});
