const target=db.getSiblingDB(process.env.FM_DB);
const assert = require('node:assert/strict');
assert(db.getSiblingDB('admin').auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD));
const fs=require('fs');
const forms=JSON.parse(fs.readFileSync('/fixtures/forms.json','utf8'));
for (const f of forms) {
 const existing=target.form_definitions.findOne({_id:f._id});
 if (existing) { assert.equal(existing.schema_hash,f.schema_hash,'published definition hash changed'); continue; }
 f.published_at=new Date('2026-11-02T00:00:00Z');
 f.canonical_fields=f.canonical_fields.map(x=>x.name==='diameter_cm'?{...x,minimum:Decimal128('0'),maximum:Decimal128('999999.99')}:x);
 assert.equal(target.form_definitions.insertOne(f).acknowledged,true);
}
print('Seeded two published form definitions without rewriting existing evidence.');
