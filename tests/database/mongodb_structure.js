const assert = require('node:assert/strict');
assert(db.getSiblingDB('admin').auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD));
const name=process.env.FM_DB;
assert(/^fieldmerge_test_[a-f0-9]+$/.test(name),'tests require isolated test database');
const target=db.getSiblingDB(name);
let count=0;
function ok(label,condition){assert(condition,'FAIL '+label);count++;}
function fails(label,fn,code){let error;try{fn();}catch(e){error=e;}assert(error,'expected failure: '+label);assert.equal(error.code,code,label);count++;}
function id(n){return '80000000-0000-4000-8000-'+n.toString().padStart(12,'0');}
function source(n){return {
 _id:id(n),author_id:'10000000-0000-4000-8000-000000000001',client_submission_id:id(n),
 record_id:'30000000-0000-4000-8000-000000000001',form_version:'tree-v2',received_at:new Date('2026-11-02T10:00:00Z'),
 payload_hash:'a'.repeat(64),canonical_payload_json:'{"fixture":true}',
 payload:{client_submission_id:id(n),record_id:'30000000-0000-4000-8000-000000000001',base_version_no:Int32(1),form_version:'tree-v2',
 observed_at:new Date('2026-11-02T09:00:00Z'),patch:{diameter_cm:Decimal128('32.25')}}
};}
ok('three collections',target.getCollectionNames().length===3);
ok('idempotent form seed',target.form_definitions.countDocuments({})===2);
target.submission_documents.insertOne(source(1));count++;
fails('duplicate source identity',()=>target.submission_documents.insertOne(source(1)),11000);
let x=source(2);x.client_submission_id=id(1);x.payload.client_submission_id=id(1);
fails('duplicate author request key',()=>target.submission_documents.insertOne(x),11000);
x=source(2);x.payload.patch.diameter_cm=-1;
fails('invalid numeric type/range',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.patch.diameter_cm=Decimal128('32.251');
fails('decimal excess precision',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.patch.guard_damage='false';
fails('boolean string',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.patch.unexpected=true;
fails('unknown patch field',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.base_version_no=Int32(0);
fails('nonpositive base',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.record_id='30000000-0000-4000-8000-000000000002';
fails('lookup projection must match payload',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.received_at='2026-11-02';
fails('persisted timestamp must be BSON date',()=>target.submission_documents.insertOne(x),121);
x=source(2);delete x.canonical_payload_json;
fails('canonical source required',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.patch={};
fails('empty patch without evidence',()=>target.submission_documents.insertOne(x),121);
x=source(2);x.payload.patch={guard_damage:null,diameter_cm:Decimal128('0')};
target.submission_documents.insertOne(x);
const saved=target.submission_documents.findOne({_id:id(2)});
ok('JSON null and decimal zero retained',saved.payload.patch.guard_damage===null && saved.payload.patch.diameter_cm.toString()==='0');
ok('omitted field remains absent',!Object.hasOwn(saved.payload.patch,'health'));
x=source(3);x.payload.patch={guard_damage:false};target.submission_documents.insertOne(x);
ok('boolean false retained',target.submission_documents.findOne({_id:id(3)}).payload.patch.guard_damage===false);
x=source(4);x.payload.patch={};x.payload.observations=[{category:'guard',note:'Fixture note',observed_at:new Date('2026-11-02')}];
target.submission_documents.insertOne(x);count++;
x=source(5);x.form_version='tree-v1';x.payload.form_version='tree-v1';x.payload.observations=[];
fails('v1 rejects observations even when empty',()=>target.submission_documents.insertOne(x),121);
x=source(5);x.payload.observations=Array(21).fill({category:'guard',note:'Fixture',observed_at:new Date()});
fails('observation limit',()=>target.submission_documents.insertOne(x),121);
x=source(5);x.payload.observations=[{category:'invalid',note:'Fixture',observed_at:new Date()}];
fails('observation enum',()=>target.submission_documents.insertOne(x),121);
x=source(5);x.payload.observations=[{category:'guard',note:'   ',observed_at:new Date()}];
fails('blank observation note',()=>target.submission_documents.insertOne(x),121);
const totals=target.submission_documents.aggregate([{$group:{_id:'$form_version',count:{$sum:1}}}]).toArray();
ok('form aggregation independently counted',totals.length===1 && totals[0].count===4);
const draft={_id:id(10),owner_id:'10000000-0000-4000-8000-000000000001',client_submission_id:id(10),record_id:'30000000-0000-4000-8000-000000000001',
 base_version_no:Int32(1),form_version:'tree-v1',revision_no:Int32(1),state:'editable',payload:{patch:{}},created_at:new Date(),updated_at:new Date(),final_submission_id:null};
target.submission_drafts.insertOne(draft);count++;
const update=target.submission_drafts.updateOne({_id:id(10),owner_id:draft.owner_id,revision_no:1,state:'editable'},{$set:{'payload.patch.health':'Fair'},$inc:{revision_no:1}});
ok('revision-matched draft update',update.modifiedCount===1);
const stale=target.submission_drafts.updateOne({_id:id(10),owner_id:draft.owner_id,revision_no:1,state:'editable'},{$set:{'payload.patch.health':'Poor'}});
ok('stale draft update cannot match',stale.modifiedCount===0);
ok('owner-scoped draft delete',target.submission_drafts.deleteOne({_id:id(10),owner_id:draft.owner_id,state:'editable'}).deletedCount===1);
target.createUser({user:'structure_writer',pwd:'Temporary-test-only-password',roles:[{role:'fieldmerge_evidence_writer',db:name}]});
const conn=new Mongo('mongodb://127.0.0.1:27017');const limited=conn.getDB(name);
assert(limited.auth('structure_writer','Temporary-test-only-password'));
ok('writer may read evidence',limited.submission_documents.countDocuments({})===4);
fails('writer cannot update sealed evidence',()=>limited.submission_documents.updateOne({_id:id(1)},{$set:{payload_hash:'b'.repeat(64)}}),13);
fails('writer cannot delete sealed evidence',()=>limited.submission_documents.deleteOne({_id:id(1)}),13);
fails('writer cannot rewrite form definitions',()=>limited.form_definitions.updateOne({form_version:'tree-v1'},{$set:{schema_hash:'b'.repeat(64)}}),13);
print('MongoDB structural checks passed: '+count);
print('Ownership and finalization transition guarantees still require the backend; validators alone do not authenticate end users.');
