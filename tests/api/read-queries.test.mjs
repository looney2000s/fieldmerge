import test from 'node:test';
import assert from 'node:assert/strict';
import {recordFilters,reviewFilters,snapshotVersion,page,csvCell,acceptedCsv} from '../../lib/read-queries.mjs';
test('read query parameters are bounded and reject ambiguous or unknown filters',()=>{
 for(const query of ['limit=0','limit=101','limit=01','limit=1&limit=2','sort=secret','health=bad','active=yes','species=%20','after=bad'])assert.throws(()=>recordFilters('http://localhost/?'+query),e=>e.status===400);
 const f=recordFilters('http://localhost/?source_record_id=O%27Reilly%25_&health=unknown&active=false&limit=1');assert.equal(f.source,"O'Reilly%_");assert.equal(f.health,'unknown');assert.equal(f.active,false);assert.equal(f.limit,1);
 assert.throws(()=>recordFilters('http://localhost/?limit=1',{exporting:true}),e=>e.status===400);
});
test('review filters validate identity, field and millisecond timestamp ranges',()=>{
 for(const query of ['field=anything','record_id=bad','from=2026-02-30T00:00:00Z','from=2026-06-02T00:00:00Z&to=2026-06-01T00:00:00Z','from=2026-06-01T00:00:00.123456Z'])assert.throws(()=>reviewFilters('http://localhost/?'+query),e=>e.status===400);
 assert.equal(reviewFilters('http://localhost/?field=health&from=2026-06-01T00:00:00Z').field,'health');
 assert.equal(snapshotVersion('http://localhost/?version=2'),2);assert.throws(()=>snapshotVersion('http://localhost/?version=0'));
});
test('cursor pages expose continuation only when another row exists',()=>{
 assert.deepEqual(page([{id:'a'},{id:'b'}],1,'id'),{values:[{id:'a'}],next_cursor:'a'});
 assert.equal(page([{id:'a'}],1,'id').next_cursor,null);
});
test('CSV retains null/false/zero and quotes data while neutralizing formula-like cells',()=>{
 assert.equal(csvCell(null),'""');assert.equal(csvCell(false),'"false"');assert.equal(csvCell(0),'"0"');
 assert.equal(csvCell('a,"b"'),'"a,""b"""');
 for(const text of ['=1+1','+SUM(A1)','-1','@value','\t=1','  =1'])assert(csvCell(text).startsWith('"\''));
 assert(acceptedCsv([{record_id:'x',diameter_cm:'0',guard_damage:false}]).includes('"0","false"'));
});
