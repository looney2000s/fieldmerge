import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const [docker,root,database]=process.argv.slice(2);
assert(/^fieldmerge_test_[a-f0-9]+$/.test(database));
const run=promisify(execFile);
const args=['compose','--project-directory',root,'-f',root+'/compose.yaml','exec','-T','postgres-test',
 'psql','-X','-qAt','-U','fieldmerge_owner','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-c'];
const sql=async q=>(await run(docker,[...args,q],{timeout:20000})).stdout.trim();
const reviewer='10000000-0000-4000-8000-000000000002',other=randomUUID();
await sql(`INSERT INTO fieldmerge.app_users(user_id,email,password_hash,display_name,role) VALUES('${other}','${other}@test.invalid','no-login-test-fixture','Second reviewer','reviewer')`);
async function pending(){
 const tree=randomUUID(),s=randomUUID();
 const c=await sql(`BEGIN;
 INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) VALUES('${tree}','20000000-0000-4000-8000-000000000001','${tree}');
 INSERT INTO fieldmerge.accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES('${tree}',1,30,'${reviewer}');
 INSERT INTO fieldmerge.submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES('${s}','10000000-0000-4000-8000-000000000001','${randomUUID()}','${tree}',1,'tree-v1',repeat('a',64),'2026-06-01T00:10:00Z','2026-06-01','ready',now(),'{"diameter_cm":36}');
 DO $x$ BEGIN PERFORM fieldmerge.reconcile_submission('${s}',repeat('a',64)); END $x$;
 SELECT change_id FROM fieldmerge.field_changes WHERE submission_id='${s}';COMMIT;`);
 return {tree,s,c};
}
function review(c,key,actor=reviewer){return `SELECT fieldmerge.review_change('${actor}','${key}','${c}',1,1,'accept_proposal',NULL,'Concurrent fixture')`;}
async function overlap(firstQuery,secondQuery,expectedError){
 const app='review_'+randomUUID().replaceAll('-','');
 const first=sql(`BEGIN;SET LOCAL application_name='${app}';${firstQuery};SELECT pg_sleep(2);COMMIT;`);
 first.catch(()=>{});
 let barrier=false;
 for(let i=0;i<40;i++){
  barrier=(await sql(`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='${app}' AND wait_event='PgSleep')`))==='t';
  if(barrier)break;await new Promise(r=>setTimeout(r,50));
 }
 assert(barrier,'first review holds tree/key locks at test barrier');
 const second=sql(secondQuery);
 if(expectedError){await assert.rejects(second,e=>e.stderr.includes(expectedError));await first;}
 else {const [a,b]=await Promise.all([first,second]);assert.deepEqual(JSON.parse(a.split('\n')[0]),JSON.parse(b));}
}
let x=await pending();
await overlap(review(x.c,randomUUID()),review(x.c,randomUUID(),other),'55000');
assert.equal(await sql(`SELECT count(*) FROM fieldmerge.review_decisions WHERE change_id='${x.c}'`),'1');
assert.equal(await sql(`SELECT count(*) FROM fieldmerge.accepted_versions WHERE record_id='${x.tree}'`),'2');
x=await pending();let key=randomUUID();
await overlap(review(x.c,key),review(x.c,key));
assert.equal(await sql(`SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id='${x.s}' AND event_type='field_reviewed'`),'1');
x=await pending();const y=await pending();key=randomUUID();
await overlap(review(x.c,key),review(y.c,key),'22023');
assert.equal(await sql(`SELECT state FROM fieldmerge.field_changes WHERE change_id='${y.c}'`),'pending');
// Reviewer publishes first while an automatic stale proposal waits for the same tree.
x=await pending();const s=randomUUID();
await sql(`INSERT INTO fieldmerge.submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES('${s}','10000000-0000-4000-8000-000000000001','${randomUUID()}','${x.tree}',1,'tree-v1',repeat('a',64),'2026-06-01','2026-06-01','ready',now(),'{"diameter_cm":40}');`);
const app='mixed_'+randomUUID().replaceAll('-','');
const first=sql(`BEGIN;SET LOCAL application_name='${app}';${review(x.c,randomUUID())};SELECT pg_sleep(2);COMMIT;`);first.catch(()=>{});
let barrier=false;
for(let i=0;i<40;i++){barrier=(await sql(`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='${app}' AND wait_event='PgSleep')`))==='t';if(barrier)break;await new Promise(r=>setTimeout(r,50));}
assert(barrier);
const second=sql(`SELECT fieldmerge.reconcile_submission('${s}',repeat('a',64))`);
await Promise.all([first,second]);
assert.equal(await sql(`SELECT state FROM fieldmerge.submissions WHERE submission_id='${s}'`),'needs_review');
assert.equal(await sql(`SELECT diameter_cm FROM fieldmerge.latest_accepted_records WHERE record_id='${x.tree}'`),'36');
console.log('Concurrent reviewer scenarios passed: 4 (competing reviewers, identical retry, cross-tree key reuse, review versus automatic publication).');
