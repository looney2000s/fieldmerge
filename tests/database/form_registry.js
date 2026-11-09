const assert=require('node:assert/strict');
assert(db.getSiblingDB('admin').auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD));
db.getSiblingDB(process.env.FM_DB).form_definitions.find({}).sort({form_version:1}).forEach(f=>print(f.form_version+':'+f.schema_hash));
