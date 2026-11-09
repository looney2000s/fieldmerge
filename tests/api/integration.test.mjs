import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {MongoClient} from 'mongodb';
import {submit} from '../../lib/intake.mjs';
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
 assert.equal((await request('/api/submissions',{cookie:surveyor,method:'POST',value:envelope({health:'Poor'},{version:999})})).status,409);
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
