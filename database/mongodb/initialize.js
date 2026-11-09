load('/database/mongodb/model.js');
const assert = require('node:assert/strict');
const admin = db.getSiblingDB('admin');
assert(admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD));
const targetName = process.env.FM_DB;
assert(/^fieldmerge(?:_test_[a-f0-9]+)?$/.test(targetName),'unexpected database name');
const target = db.getSiblingDB(targetName);
for (const [name,validator] of [
  ['submission_documents',fmModel.sourceValidator],
  ['form_definitions',{$jsonSchema:fmModel.formSchema}],
  ['submission_drafts',fmModel.draftValidator]
]) {
  if (!target.getCollectionNames().includes(name)) {
    assert.equal(target.createCollection(name,{validator,validationLevel:'strict',validationAction:'error'}).ok,1);
  } else {
    assert.equal(target.runCommand({collMod:name,validator,validationLevel:'strict',validationAction:'error'}).ok,1);
  }
}
target.submission_documents.createIndex({author_id:1,client_submission_id:1},{unique:true});
target.submission_documents.createIndex({record_id:1,received_at:1});
target.submission_documents.createIndex({form_version:1,received_at:1});
target.submission_documents.createIndex({batch_id:1,received_at:1});
target.form_definitions.createIndex({form_version:1},{unique:true});
target.submission_drafts.createIndex({owner_id:1,client_submission_id:1},{unique:true});
target.submission_drafts.createIndex({owner_id:1,state:1,updated_at:1});
// Least-privilege service roles. End-user ownership/state policies arrive with the backend.
for (const [role,privileges] of [
  ['fieldmerge_evidence_writer',[{resource:{db:targetName,collection:'submission_documents'},actions:['find','insert']}]],
  ['fieldmerge_evidence_reader',[{resource:{db:targetName,collection:'submission_documents'},actions:['find']},{resource:{db:targetName,collection:'form_definitions'},actions:['find']}]],
  ['fieldmerge_draft_editor',[{resource:{db:targetName,collection:'submission_drafts'},actions:['find','insert','update','remove']}]]
]) {
  if (!target.getRole(role)) target.createRole({role,privileges,roles:[]});
  else target.updateRole(role,{privileges,roles:[]});
}
print('MongoDB collections, validators, indexes and service roles ready: '+targetName);
