import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
import {MongoClient} from 'mongodb';
import {submit} from '../../lib/intake.mjs';
import {createDraft,finalizeDraft} from '../../lib/drafts.mjs';
import {parseExact,sha256} from '../../lib/canonical.mjs';
import {closeConnections} from '../../lib/database.mjs';
import {recoveryConnections} from '../../lib/recovery-database.mjs';
import {createRecoveryWorker} from '../../lib/recovery.mjs';
assert(/^fieldmerge_test_[a-f0-9]+$/.test(process.env.FM_TEST_DATABASE));
const accounts=JSON.parse(readFileSync('tmp/database-fixtures/demo-accounts.json','utf8')),base=process.env.API_BASE;
const admin=new pg.Client({host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??15432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.FM_TEST_DATABASE});
const rootMongo=new MongoClient(`mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT??27018}/?authSource=admin`);
let surveyor,reviewer,token,db;
const workers=[];
function worker(options={}){const w=createRecoveryWorker(options);workers.push(w);return w;}
async function request(path,{cookie=reviewer,method='GET',value}={}){
 const r=await fetch(base+path,{method,headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
 return{status:r.status,body:await r.json()};
}
before(async()=>{
 await admin.connect();await rootMongo.connect();db=rootMongo.db(process.env.MONGODB_DATABASE);
 for(const account of accounts){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:account.email,password:account.password})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];if(account.role==='surveyor')surveyor=cookie;else reviewer=cookie;}
 token=sha256(surveyor.split('=')[1]);
});
beforeEach(async()=>{
 // Park unrelated incomplete fixtures from earlier tests in this disposable database.
 await admin.query("UPDATE fieldmerge_ops.recovery_jobs SET status='blocked',lease_token=NULL,lease_expires_at=NULL,claimed_by=NULL WHERE status<>'completed'");
});
after(async()=>{await Promise.all(workers.map(x=>x.close()));await admin.end();await rootMongo.close();await closeConnections();});
async function proposal(label){
 const record='30000000-0000-4000-8000-000000000003',version=(await admin.query('SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1',[record])).rows[0].n;
 return{client_submission_id:randomUUID(),record_id:record,base_version_no:version,form_version:'tree-v2',observed_at:'2026-06-01T00:00:00Z',patch:{species:label+' '+randomUUID()}};
}
async function interrupted(p,stage='afterInsert'){
 await assert.rejects(submit(token,parseExact(JSON.stringify(p)),{[stage]:()=>{throw new Error('interrupted fixture');}}),/interrupted fixture/);
 return(await admin.query("SELECT j.* FROM fieldmerge_ops.recovery_jobs j JOIN fieldmerge.submissions s USING(submission_id) WHERE s.author_id=$1 AND s.client_submission_id=$2 AND j.job_kind='submission'",[accounts[0].user_id,p.client_submission_id])).rows[0];
}
const job=async id=>(await admin.query('SELECT * FROM fieldmerge_ops.recovery_jobs WHERE job_id=$1',[id])).rows[0];
async function onePublication(id){assert.equal((await admin.query("SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='submission_reconciled'",[id])).rows[0].count,'1');}
const crash=()=>{const e=new Error('injected worker death');e.injectedCrash=true;throw e;};

test('worker privileges and reviewer operation views exclude session/lease secrets',async()=>{
 const limited=new pg.Client({connectionString:process.env.WORKER_DATABASE_URL});await limited.connect();
 try{for(const sql of ['SELECT * FROM fieldmerge.app_users','SELECT * FROM fieldmerge_ops.recovery_jobs','SET ROLE fieldmerge_workflow',"SELECT fieldmerge.api_create_session('10000000-0000-4000-8000-000000000001',repeat('a',64))"]){await assert.rejects(limited.query(sql),e=>e.code==='42501');}}
 finally{await limited.end();}
 const connections=recoveryConnections();
 try{const mongo=await connections.mongo();await assert.rejects(mongo.collection('submission_documents').updateOne({_id:randomUUID()},{$set:{payload_hash:'a'.repeat(64)}}),e=>e.code===13);await assert.rejects(mongo.collection('submission_drafts').deleteOne({_id:randomUUID()}),e=>e.code===13);}
 finally{await connections.close();}
 const j=await interrupted(await proposal('operations'));
 assert.equal((await request('/api/operations/recovery',{cookie:surveyor})).status,403);
 const listing=await request('/api/operations/recovery');assert.equal(listing.status,200);assert(listing.body.jobs.some(x=>x.job_id===j.job_id));
 const detail=await request('/api/operations/recovery/'+j.job_id);assert.equal(detail.status,200);assert.equal(detail.body.job.lease_token,undefined);assert.equal(detail.body.job.claimed_by,undefined);
 assert.equal(detail.body.job.canonical_payload_json,undefined);assert(detail.body.events.some(x=>x.event_type==='queued'));
 assert.equal((await request('/api/operations/recovery/'+j.job_id+'/retry',{cookie:surveyor,method:'POST',value:{reason:'Unauthorized'}})).status,403);
});

test('stored source recovers without a user session and publishes once',async()=>{
 const p=await proposal('automatic source'),j=await interrupted(p),w=worker();
 const result=await w.runOne();assert.equal(result.status,'completed');assert.equal(result.receipt.submission_id,j.submission_id);
 assert.equal((await job(j.job_id)).status,'completed');await onePublication(j.submission_id);
 assert.equal(await w.runOne(),null);
 assert.equal((await admin.query('SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1',[p.record_id])).rows[0].n,p.base_version_no+1);
});

test('missing source waits for original content and an attributed retry',async()=>{
 const p=await proposal('missing source'),j=await interrupted(p,'afterReserve'),w=worker();
 const failed=await w.runOne();assert.equal(failed.code,'source_missing');assert.equal((await job(j.job_id)).status,'waiting_source');
 assert.equal(await db.collection('submission_documents').countDocuments({_id:j.submission_id}),0);assert.equal(await w.runOne(),null);
 await interrupted(p); // Original envelope arrives, with another interruption before SQL finish.
 const retried=await request('/api/operations/recovery/'+j.job_id+'/retry',{method:'POST',value:{reason:'Original evidence is now stored'}});assert.equal(retried.status,200);
 assert.equal((await w.runOne()).status,'completed');await onePublication(j.submission_id);
 const detail=await request('/api/operations/recovery/'+j.job_id);assert(detail.body.events.some(e=>e.event_type==='retry_requested'&&e.actor_id===accounts[1].user_id));
});

test('source mismatches are quarantined without overwriting evidence',async()=>{
 const p=await proposal('quarantine'),j=await interrupted(p),w=worker();
 await db.collection('submission_documents').updateOne({_id:j.submission_id},{$set:{payload_hash:'b'.repeat(64)}});
 assert.equal((await w.runOne()).code,'source_integrity_mismatch');assert.equal((await job(j.job_id)).status,'quarantined');assert.equal(await w.runOne(),null);
 assert.equal((await db.collection('submission_documents').findOne({_id:j.submission_id})).payload_hash,'b'.repeat(64));
 assert.equal((await admin.query('SELECT state FROM fieldmerge.submissions WHERE submission_id=$1',[j.submission_id])).rows[0].state,'awaiting_document');
 const detail=await request('/api/operations/recovery/'+j.job_id);assert.equal(detail.body.job.last_error_code,'source_integrity_mismatch');
});

test('finalizing drafts recover before reservation and after SQL commit',async()=>{
 for(const stage of ['afterFreeze','afterIntake']){
  const p=await proposal('draft '+stage),{client_submission_id,...input}=p;
  const {record_id,base_version_no,form_version,...payload}=input;
  const d=await createDraft(token,parseExact(JSON.stringify({record_id,base_version_no,form_version,payload})));
  await assert.rejects(finalizeDraft(token,d.draft_id,parseExact('{"expected_revision_no":1}'),{[stage]:crash}),/injected worker death/);
  const w=worker();await w.discover();
  for(let i=0;i<3;i++){if(!await w.runOne())break;}
  const saved=await db.collection('submission_drafts').findOne({_id:d.draft_id});assert.equal(saved.state,'finalized');assert.equal(saved.canonical_payload_json,d.canonical_payload_json);await onePublication(saved.final_submission_id);
  assert.equal((await admin.query("SELECT status FROM fieldmerge_ops.recovery_jobs WHERE job_kind='draft' AND target_id=$1",[d.draft_id])).rows[0].status,'completed');
 }
});

test('concurrent workers respect a live lease and expired workers are fenced',async()=>{
 const p=await proposal('fenced'),j=await interrupted(p);let release,announce;
 const acquired=new Promise(r=>announce=r),gate=new Promise(r=>release=r);
 const first=worker({hooks:{afterClaim:async()=>{announce();await gate;}}}),second=worker();
 const running=first.runOne();await acquired;assert.equal(await second.runOne(),null);
 await admin.query("UPDATE fieldmerge_ops.recovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[j.job_id]);
 const successor=await second.runOne();assert.equal(successor.status,'completed');release();assert.equal((await running).status,'claim_lost');
 await onePublication(j.submission_id);assert.equal((await job(j.job_id)).attempts,2);
});

test('inactive authors block recovery until an explicit reviewed retry',async()=>{
 const j=await interrupted(await proposal('inactive author')),w=worker();
 await admin.query('UPDATE fieldmerge.app_users SET is_active=false WHERE user_id=$1',[accounts[0].user_id]);
 try{assert.equal((await w.runOne()).code,'actor_inactive');assert.equal((await job(j.job_id)).status,'blocked');}
 finally{await admin.query('UPDATE fieldmerge.app_users SET is_active=true WHERE user_id=$1',[accounts[0].user_id]);}
 assert.equal((await request('/api/operations/recovery/'+j.job_id+'/retry',{method:'POST',value:{reason:'Account active again'}})).status,200);
 assert.equal((await w.runOne()).status,'completed');await onePublication(j.submission_id);
});

test('a real connection failure records backoff and recovers after connectivity returns',async()=>{
 const j=await interrupted(await proposal('connection failure')),uri=new URL(process.env.WORKER_MONGODB_URI);uri.port='9';
 const unavailable=worker({connections:recoveryConnections({...process.env,WORKER_MONGODB_URI:uri.toString()})});
 const failed=await unavailable.runOne();assert.equal(failed.code,'service_unavailable');
 const saved=await job(j.job_id);assert.equal(saved.status,'retry');assert(saved.next_attempt_at>new Date());assert.equal(saved.lease_token,null);
 assert.equal((await admin.query('SELECT state FROM fieldmerge.submissions WHERE submission_id=$1',[j.submission_id])).rows[0].state,'awaiting_document');
 assert.equal((await request('/api/operations/recovery/'+j.job_id+'/retry',{method:'POST',value:{reason:'Connectivity restored'}})).status,200);
 assert.equal((await worker().runOne()).status,'completed');await onePublication(j.submission_id);
});

test('a killed worker process leaves a lease that a restarted CLI can recover',async()=>{
 const p=await proposal('process restart'),j=await interrupted(p),uri=new URL(process.env.WORKER_MONGODB_URI);uri.port='9';
 const child=spawn(process.execPath,['scripts/recovery-worker.mjs','--once'],{env:{...process.env,WORKER_MONGODB_URI:uri.toString()},stdio:['ignore','pipe','pipe'],windowsHide:true});
 const exited=once(child,'exit');let leased=false;
 try{
  for(let i=0;i<120;i++){if((await job(j.job_id)).status==='leased'){leased=true;break;}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
  assert(leased,'process must persist its lease before termination');
 }finally{child.kill('SIGKILL');await exited;}
 assert.equal((await job(j.job_id)).status,'leased');
 // Advance the server-side expiry in this disposable fixture instead of sleeping 60 seconds.
 await admin.query("UPDATE fieldmerge_ops.recovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",[j.job_id]);
 const restart=spawn(process.execPath,['scripts/recovery-worker.mjs','--once'],{env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';restart.stdout.on('data',x=>output+=x.toString());restart.stderr.on('data',x=>output+=x.toString());
 assert.equal((await once(restart,'exit'))[0],0);assert.match(output,/recovery_cycle/);assert(!output.includes(process.env.WORKER_POSTGRES_PASSWORD));
 assert.equal((await job(j.job_id)).status,'completed');await onePublication(j.submission_id);
});
