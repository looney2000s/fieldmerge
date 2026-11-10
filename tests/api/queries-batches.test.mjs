import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {MongoClient} from 'mongodb';
import {call,closeConnections} from '../../lib/database.mjs';
import {combinedSummary} from '../../lib/reports.mjs';
import {submit} from '../../lib/intake.mjs';
import {canonical,parseExact,sha256} from '../../lib/canonical.mjs';
import {createRecoveryWorker} from '../../lib/recovery.mjs';
assert(/^fieldmerge_test_[a-f0-9]+$/.test(process.env.FM_TEST_DATABASE));
const base=process.env.API_BASE,accounts=JSON.parse(readFileSync('tmp/database-fixtures/demo-accounts.json','utf8'));
const admin=new pg.Client({host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??15432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.FM_TEST_DATABASE});
const rootMongo=new MongoClient(`mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT??27018}/?authSource=admin`);
let surveyor,reviewer,other,db,token;
async function request(path,{cookie=surveyor,method='GET',value,headers={}}={}){
 const r=await fetch(base+path,{method,headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json',...headers},body:value===undefined?undefined:JSON.stringify(value)});
 const text=await r.text();return{status:r.status,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text,headers:r.headers};
}
async function login(a){const r=await request('/api/auth/login',{method:'POST',value:{email:a.email,password:a.password}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
before(async()=>{
 await admin.connect();await rootMongo.connect();db=rootMongo.db(process.env.MONGODB_DATABASE);surveyor=await login(accounts[0]);reviewer=await login(accounts[1]);token=sha256(surveyor.split('=')[1]);
 const id=randomUUID(),email=id+'@test.invalid';await admin.query('INSERT INTO fieldmerge.app_users(user_id,email,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5)',[id,email,accounts[0].password_hash,'Other reader fixture','surveyor']);other=await login({email,password:accounts[0].password});
 await admin.query("UPDATE fieldmerge_ops.recovery_jobs SET status='blocked',lease_token=NULL,lease_expires_at=NULL,claimed_by=NULL WHERE status<>'completed'");
});
after(async()=>{await admin.end();await rootMongo.close();await closeConnections();});
async function tree(species='Query fixture'){
 const id=randomUUID(),source='QUERY-'+randomUUID();await admin.query('BEGIN');
 try{await admin.query('INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) VALUES($1,$2,$3)',[id,'20000000-0000-4000-8000-000000000001',source]);
 await admin.query('INSERT INTO fieldmerge.accepted_versions(record_id,version_no,species,health,diameter_cm,guard_damage,published_by) VALUES($1,1,$2,NULL,0,false,$3)',[id,species,accounts[1].user_id]);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}return{id,source};
}
const envelope=(t,patch)=>({client_submission_id:randomUUID(),record_id:t.id,base_version_no:1,form_version:'tree-v2',observed_at:'2026-06-01T00:00:00Z',patch});

test('record filters are literal, bounded and paginate without duplicates',async()=>{
 const t=await tree("O'Reilly%_fixture");
 const found=await request('/api/records?species='+encodeURIComponent("O'Reilly%_fixture")+'&health=unknown&active=true');assert.equal(found.status,200);assert.deepEqual(found.body.records.map(x=>x.record_id),[t.id]);
 assert.equal((await request('/api/records?source_record_id='+encodeURIComponent(t.source))).body.records[0].record_id,t.id);
 assert.deepEqual((await request('/api/records?species='+encodeURIComponent("' OR true --"))).body.records,[]);
 for(const q of ['limit=0','limit=101','limit=1&limit=2','health=bad','unknown=1','after=bad'])assert.equal((await request('/api/records?'+q)).status,400);
 let cursor=null;const ids=[];
 do{const r=await request('/api/records?limit=1'+(cursor?'&after='+cursor:''));assert.equal(r.status,200);ids.push(...r.body.records.map(x=>x.record_id));cursor=r.body.next_cursor;}while(cursor);
 assert.equal(new Set(ids).size,ids.length);assert(ids.includes(t.id));assert.equal(ids.length,(await admin.query('SELECT count(*) FROM fieldmerge.tree_records')).rows[0].count*1);
});

test('downloaded snapshots retain an explicit immutable base version and campaign',async()=>{
 const t=await tree('Historical fixture'),initial=await request('/api/records/'+t.id+'/snapshot?version=1');
 assert.equal(initial.status,200);assert.match(initial.headers.get('content-disposition'),/attachment/);assert.equal(initial.headers.get('cache-control'),'no-store');assert.equal(initial.body.record.version_no,1);assert(initial.body.campaign.starts_at);assert(initial.body.supported_forms.includes('tree-v2'));
 assert.equal((await request('/api/submissions',{method:'POST',value:envelope(t,{health:'Good'})})).status,200);
 const historical=await request('/api/records/'+t.id+'/snapshot?version=1',{cookie:reviewer});assert.deepEqual(historical.body.record,initial.body.record);
 assert.equal((await request('/api/records/'+t.id+'/snapshot')).body.record.version_no,2);
 assert.equal((await request('/api/records/'+t.id+'/snapshot?version=999')).status,404);assert.equal((await request('/api/records/'+t.id+'/snapshot?version=0')).status,400);
});

test('review filters return actual current comparisons and guarded continuation',async()=>{
 const t=await tree();await request('/api/submissions',{method:'POST',value:envelope(t,{diameter_cm:2})});
 const conflict=await request('/api/submissions',{method:'POST',value:envelope(t,{diameter_cm:3})});assert.equal(conflict.body.state,'needs_review');
 const url='/api/reviews?record_id='+t.id+'&field=diameter_cm&author_id='+accounts[0].user_id+'&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z&limit=1';
 assert.equal((await request(url)).status,403);const r=await request(url,{cookie:reviewer});assert.equal(r.status,200);assert.equal(r.body.changes.length,1);assert.equal(r.body.changes[0].current_value,2);assert.equal(r.body.changes[0].current_version_no,2);
 assert.deepEqual((await request('/api/reviews?record_id='+t.id+'&field=health',{cookie:reviewer})).body.changes,[]);
 assert.equal((await request('/api/reviews?from=2026-06-02T00:00:00Z&to=2026-06-01T00:00:00Z',{cookie:reviewer})).status,400);
});

test('batch manifests replay safely, preserve first attribution, and scope membership by owner',async()=>{
 const t=await tree(),p=envelope(t,{health:'Fair'}),invalid=envelope(t,{diameter_cm:-1}),key=randomUUID();
 p.observations=[{category:'guard',note:'Synthetic first observation',observed_at:p.observed_at},{category:'root',note:'Synthetic second observation',observed_at:'2026-06-01T01:00:00Z'}];
 const first=await request('/api/submissions/batch',{method:'POST',headers:{'X-FieldMerge-Batch-Id':key},value:[p,invalid]});assert.equal(first.status,207);assert.equal(first.body.results[0].ok,true);assert.equal(first.body.results[1].ok,false);
 const id=first.body.batch_id,sid=first.body.results[0].result.submission_id;
 const [retryA,retryB]=await Promise.all([1,2].map(()=>request('/api/submissions/batch',{method:'POST',headers:{'X-FieldMerge-Batch-Id':key},value:[p,invalid]})));
 for(const r of [retryA,retryB]){assert.equal(r.body.batch_id,id);assert.deepEqual(r.body.results,first.body.results);}
 assert.equal((await request('/api/submissions/batch',{method:'POST',headers:{'X-FieldMerge-Batch-Id':key},value:[invalid,p]})).status,409);
 const later=await request('/api/submissions/batch',{method:'POST',value:[p]});assert.notEqual(later.body.batch_id,id);assert.equal(later.body.results[0].result.submission_id,sid);
 const source=await db.collection('submission_documents').findOne({_id:sid});assert.equal(source.batch_id,id);
 assert.equal((await request('/api/batches/'+id,{cookie:other})).status,404);assert.equal((await request('/api/batches/'+id,{cookie:reviewer})).status,200);
 const details=await request('/api/batches/'+id);assert.equal(details.body.items[0].processed,true);assert.equal(details.body.items[1].error,'invalid_diameter');
 assert.equal((await admin.query("SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=$1 AND event_type='submission_reconciled'",[sid])).rows[0].count,'1');
 const single=envelope(t,{guard_damage:true}),singleResult=await request('/api/submissions',{method:'POST',value:single});assert.equal(singleResult.status,200);
 const grouped=await request('/api/submissions/batch',{method:'POST',value:[single]});assert.equal(grouped.status,207);
 assert.equal((await db.collection('submission_documents').findOne({_id:singleResult.body.submission_id})).batch_id,undefined);
 assert.equal((await request('/api/batches/'+grouped.body.batch_id)).body.items[0].first_intake_batch_id,null);
});

test('interface read models preserve ownership, roles, bounded lists and current comparisons',async()=>{
 const t=await tree(),first=await request('/api/submissions',{method:'POST',value:envelope(t,{diameter_cm:5})});assert.equal(first.status,200);
 const conflict=await request('/api/submissions',{method:'POST',value:envelope(t,{diameter_cm:6})});assert.equal(conflict.status,200);
 const list=await request('/api/submissions?record_id='+t.id);assert.equal(list.status,200);assert.equal(list.body.submissions.length,2);assert(list.body.submissions.every(s=>s.author_id===accounts[0].user_id&&s.source_record_id===t.source));assert.equal(list.body.submissions[0].verified_patch,undefined);
 assert.deepEqual((await request('/api/submissions?record_id='+t.id,{cookie:other})).body.submissions,[]);
 assert.equal((await request('/api/submissions?state=bad')).status,400);assert.equal((await request('/api/submissions?record_id=bad')).status,400);
 const queue=await request('/api/reviews?record_id='+t.id,{cookie:reviewer}),c=queue.body.changes[0];assert.equal(c.source_record_id,t.source);
 const comparison=await request('/api/reviews/'+c.change_id,{cookie:reviewer});assert.equal(comparison.status,200);assert.equal(comparison.body.change.base_version_no,1);assert.equal(comparison.body.change.current_value,5);assert.equal(comparison.body.change.source_record_id,t.source);assert(comparison.body.change.author_name);
 assert.equal((await request('/api/reviews/'+c.change_id)).status,403);assert.equal((await request('/api/reviews/authors')).status,403);
 assert((await request('/api/reviews/authors',{cookie:reviewer})).body.authors.some(a=>a.user_id===accounts[0].user_id));
 const batch=await request('/api/submissions/batch',{method:'POST',value:[envelope(t,{species:'Interface fixture'})]});assert.equal(batch.status,207);
 assert((await request('/api/batches')).body.batches.some(b=>b.batch_id===batch.body.batch_id));assert(!(await request('/api/batches',{cookie:other})).body.batches.some(b=>b.batch_id===batch.body.batch_id));assert((await request('/api/batches',{cookie:reviewer})).body.batches.some(b=>b.batch_id===batch.body.batch_id));
 const draft=await request('/api/drafts',{method:'POST',value:{record_id:t.id,base_version_no:1,form_version:'tree-v2',payload:{patch:{}}}});assert.equal(draft.status,201);
 const details=await request('/api/drafts/'+draft.body.draft.draft_id);assert.equal(details.status,200);assert.equal(details.body.base.record.version_no,1);assert.equal(details.body.base.record.source_record_id,t.source);
 assert((await request('/api/drafts')).body.drafts.some(d=>d.draft_id===draft.body.draft.draft_id&&d.source_record_id===t.source));
});

test('SQL and MongoDB summaries match independent counts without conflating accepted state',async()=>{
 assert.equal((await request('/api/reports/summary')).status,403);
 const r=await request('/api/reports/summary',{cookie:reviewer});assert.equal(r.status,200);assert.equal(r.body.consistency,'independent_database_reads');
 assert.equal(r.body.sql.accepted_records,Number((await admin.query('SELECT count(*) FROM fieldmerge.tree_records')).rows[0].count));
 const states=(await admin.query('SELECT state,count(*) AS n FROM fieldmerge.submissions GROUP BY state')).rows;
 for(const state of states)assert.equal(r.body.sql.submissions.find(x=>x.state===state.state).count,Number(state.n));
 const docs=await db.collection('submission_documents').find({}).toArray();assert.equal(r.body.evidence.source_count,docs.length);
 const categories=new Map(),forms=new Map(),batches=new Map();let observations=0,withObservations=0;
 for(const d of docs){forms.set(d.form_version,(forms.get(d.form_version)??0)+1);batches.set(d.batch_id??null,(batches.get(d.batch_id??null)??0)+1);if(d.payload.observations?.length)withObservations++;for(const o of d.payload.observations??[]){observations++;categories.set(o.category,(categories.get(o.category)??0)+1);}}
 assert.equal(r.body.evidence.observation_count,observations);assert.equal(r.body.evidence.with_observations,withObservations);
 for(const [key,count]of forms)assert.equal(r.body.evidence.by_form.find(x=>x.form_version===key).source_count,count);
 for(const [key,count]of batches)assert.equal(r.body.evidence.by_first_batch.find(x=>x.batch_id===key).source_count,count);
 for(const [key,count]of categories)assert.equal(r.body.evidence.observation_categories.find(x=>x.category===key).count,count);
 const partial=await combinedSummary(sha256(reviewer.split('=')[1]),{mongoProvider:async()=>{throw new Error('injected unavailable evidence store');}});assert.equal(partial.sql.accepted_records,r.body.sql.accepted_records);assert.equal(partial.evidence.available,false);
});

test('accepted exports retain null, false and zero and escape spreadsheet formulas',async()=>{
 const t=await tree('=1+1'),filter='?source_record_id='+encodeURIComponent(t.source);
 assert.equal((await request('/api/reports/accepted.json'+filter)).status,403);
 const json=await request('/api/reports/accepted.json'+filter,{cookie:reviewer});assert.equal(json.status,200);assert.match(json.headers.get('content-disposition'),/attachment/);assert.equal(json.body.records.length,1);
 assert.equal(json.body.records[0].diameter_cm,'0');assert.equal(json.body.records[0].guard_damage,false);assert.equal(json.body.records[0].health,null);assert.equal(json.body.records[0].species,'=1+1');
 const csv=await request('/api/reports/accepted.csv'+filter,{cookie:reviewer});assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert(csv.body.includes('"\'=1+1"'));assert(csv.body.includes('"0","false"'));
});

test('recovery preserves first-batch source metadata after interrupted publication',async()=>{
 const t=await tree(),p=envelope(t,{health:'Poor'}),encoded=canonical(parseExact(JSON.stringify(p))),b=await call('api_register_batch',[token,randomUUID(),JSON.stringify([sha256(encoded)])]);
 await assert.rejects(submit(token,parseExact(JSON.stringify(p)),{batch:{id:b.batch_id,index:0},afterInsert:()=>{throw new Error('batch interruption');}}),/batch interruption/);
 const w=createRecoveryWorker();try{assert.equal((await w.runOne()).status,'completed');}finally{await w.close();}
 const detail=await request('/api/batches/'+b.batch_id);assert.equal(detail.body.items[0].processed,true);
 const source=await db.collection('submission_documents').findOne({_id:detail.body.items[0].submission_id});assert.equal(source.batch_id,b.batch_id);
});

test('exports refuse 5001 rows instead of silently truncating and allow 5000',async()=>{
 const prefix='EXPORTCAP-'+randomUUID();await admin.query('BEGIN');
 try{await admin.query("INSERT INTO fieldmerge.tree_records(record_id,campaign_id,source_record_id) SELECT gen_random_uuid(),$1,$2||'-'||n FROM generate_series(1,5001) n",['20000000-0000-4000-8000-000000000001',prefix]);
 await admin.query('INSERT INTO fieldmerge.accepted_versions(record_id,version_no,diameter_cm,published_by) SELECT record_id,1,0,$1 FROM fieldmerge.tree_records WHERE starts_with(source_record_id,$2)',[accounts[1].user_id,prefix]);await admin.query('COMMIT');}
 catch(e){await admin.query('ROLLBACK');throw e;}
 const filter='?source_record_id='+prefix;
 const rejected=await request('/api/reports/accepted.json'+filter,{cookie:reviewer});assert.equal(rejected.status,413);assert.equal(rejected.body.error,'export_too_large_use_filters');
 await admin.query('UPDATE fieldmerge.tree_records SET is_active=false WHERE record_id=(SELECT record_id FROM fieldmerge.tree_records WHERE starts_with(source_record_id,$1) LIMIT 1)',[prefix]);
 const accepted=await request('/api/reports/accepted.json'+filter+'&active=true',{cookie:reviewer});assert.equal(accepted.status,200);assert.equal(accepted.body.records.length,5000);
});
