import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const [docker,root,database]=process.argv.slice(2);
assert(/^fieldmerge_test_[a-f0-9]+$/.test(database));
const run=promisify(execFile),reviewer='10000000-0000-4000-8000-000000000002',author='10000000-0000-4000-8000-000000000001';
const args=['compose','--project-directory',root,'-f',root+'/compose.yaml','exec','-T','postgres-test',
 'psql','-X','-qAt','-U','fieldmerge_owner','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-c'];
const sql=async query=>(await run(docker,[...args,query],{timeout:20000})).stdout.trim();
async function fixture(warning=false){
 const tree=randomUUID(),source=randomUUID();
 await sql(`BEGIN;
 INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) VALUES('${tree}','20000000-0000-4000-8000-000000000001','${tree}');
 INSERT INTO fieldmerge.accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES('${tree}',1,30,'${reviewer}');
 INSERT INTO fieldmerge.submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES('${source}','${author}','${randomUUID()}','${tree}',1,'tree-v1',repeat('a',64),'${warning?'2026-06-01T00:10:00Z':'2026-06-01'}','2026-06-01','ready',now(),'{"diameter_cm":32}');COMMIT;`);
 return {tree,source};
}
async function deniedAtCommit(query){
 await assert.rejects(sql(`BEGIN;${query};SELECT 'reached_commit';COMMIT;`),e=>e.stderr.includes('23514')&&e.stdout.includes('reached_commit'));
}
let x=await fixture();
await sql(`BEGIN;SELECT fieldmerge.reconcile_submission('${x.source}',repeat('a',64));COMMIT;`);
assert.equal(await sql(`SELECT diameter_cm FROM fieldmerge.accepted_versions WHERE record_id='${x.tree}' AND version_no=2`),'32');
x=await fixture();
await deniedAtCommit(`SET LOCAL ROLE fieldmerge_workflow;
 INSERT INTO fieldmerge.accepted_versions(record_id,version_no,parent_version_no,diameter_cm,origin_submission_id,published_by)
 VALUES('${x.tree}',2,1,33,'${x.source}','${author}');RESET ROLE`);
assert.equal(await sql(`SELECT max(version_no) FROM fieldmerge.accepted_versions WHERE record_id='${x.tree}'`),'1');
assert.equal(await sql(`SELECT state FROM fieldmerge.submissions WHERE submission_id='${x.source}'`),'ready');
x=await fixture(true);
await sql(`SELECT fieldmerge.reconcile_submission('${x.source}',repeat('a',64));`);
const change=await sql(`SELECT change_id FROM fieldmerge.field_changes WHERE submission_id='${x.source}'`);
await deniedAtCommit(`SET LOCAL ROLE fieldmerge_workflow;
 UPDATE fieldmerge.field_changes SET state='rejected',pending_reason=NULL,revision_no=2 WHERE change_id='${change}';RESET ROLE`);
assert.equal(await sql(`SELECT state||':'||revision_no FROM fieldmerge.field_changes WHERE change_id='${change}'`),'pending:1');
await sql(`BEGIN;SELECT fieldmerge.review_change('${reviewer}','${randomUUID()}','${change}',1,1,'keep_current',NULL,'Commit fixture');COMMIT;`);
assert.equal(await sql(`SELECT max(version_no) FROM fieldmerge.accepted_versions WHERE record_id='${x.tree}'`),'1');
assert.equal(await sql(`SELECT state FROM fieldmerge.submissions WHERE submission_id='${x.source}'`),'resolved');
console.log('Actual COMMIT checks passed: 4 (automatic publication, missing applying link rollback, decisionless disposal rollback, no-publication review).');
