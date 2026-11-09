import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const [docker,root,database]=process.argv.slice(2);
assert(/^fieldmerge_test_[a-f0-9]+$/.test(database));
const run=promisify(execFile);
const compose=['compose','--project-directory',root,'-f',root+'/compose.yaml','exec','-T','postgres-test',
 'psql','-X','-qAt','-U','fieldmerge_owner','-d',database,'-v','ON_ERROR_STOP=1','-c'];
const sql=async q=>(await run(docker,[...compose,q],{timeout:20000})).stdout.trim();
for(const same of [false,true]){
 const tree=randomUUID(),a=randomUUID(),b=same?a:randomUUID();
 const submission=(id,value)=>`INSERT INTO fieldmerge.submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES('${id}','10000000-0000-4000-8000-000000000001','${randomUUID()}','${tree}',1,'tree-v1',repeat('a',64),'2026-06-01','2026-06-01','ready',now(),'${JSON.stringify({diameter_cm:value})}');`;
 await sql(`BEGIN;INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) VALUES('${tree}','20000000-0000-4000-8000-000000000001','${tree}');
 INSERT INTO fieldmerge.accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES('${tree}',1,30,'10000000-0000-4000-8000-000000000002');
 ${submission(a,32)}${same?'':submission(b,36)} COMMIT;`);
 const app='race_'+randomUUID().replaceAll('-','');
 const first=sql(`BEGIN;SET LOCAL application_name='${app}';SELECT fieldmerge.reconcile_submission('${a}',repeat('a',64));SELECT pg_sleep(2);COMMIT;`);
 // Attach rejection handling immediately while waiting for the observable lock barrier.
 first.catch(()=>{});
 let sleeping=false;
 for(let i=0;i<40;i++){
  sleeping=(await sql(`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='${app}' AND wait_event='PgSleep')`))==='t';
  if(sleeping)break;
  await new Promise(r=>setTimeout(r,50));
 }
 assert(sleeping,'first session must reach barrier holding tree lock');
 const second=sql(`SELECT fieldmerge.reconcile_submission('${b}',repeat('a',64));`);
 const [r1,r2]=await Promise.all([first,second]);
 const state=await sql(`SELECT state FROM fieldmerge.submissions WHERE submission_id='${b}'`);
 assert.equal(state,same?'applied':'needs_review');
 assert.equal(await sql(`SELECT count(*) FROM fieldmerge.accepted_versions WHERE record_id='${tree}'`),'2');
 assert.equal(await sql(`SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id='${a}'`),'1');
 if(same)assert.deepEqual(JSON.parse(r1.split('\n')[0]),JSON.parse(r2));
}
console.log('Concurrent reconciliation scenarios passed: 2 (competing submissions and same-submission retries).');
