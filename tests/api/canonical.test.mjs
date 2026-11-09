import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExact,canonical,validateSubmission,ApiError} from '../../lib/canonical.mjs';
test('canonicalization preserves exact decimals and ignores object order/whitespace',()=>{
 assert.equal(canonical(parseExact('{"z":0.100000000000000001,"a":1e0}')),'{"a":1,"z":0.100000000000000001}');
 assert.equal(canonical(parseExact('{ "b":2,"a":1 }')),canonical(parseExact('{"a":1.0,"b":2e0}')));
});
test('duplicate keys rejected at every object level',()=>{
 for(const text of ['{"a":1,"a":2}','{"p":{"x":1,"x":2}}'])assert.throws(()=>parseExact(text),e=>e.code==='duplicate_json_key');
});
test('strict JSON, resource bounds and special keys',()=>{
 for(const text of ['{"a":1,}','/* comment */ {}','{"a":1e999999}','['.repeat(40)+'0'+']'.repeat(40)])assert.throws(()=>parseExact(text),ApiError);
 assert.equal(canonical(parseExact('{"__proto__":{"admin":true}}')),'{"__proto__":{"admin":true}}');
 assert.equal({}.admin,undefined);
});
test('arrays, strings, omission and null have distinct fingerprints',()=>{
 assert.notEqual(canonical(parseExact('[1,2]')),canonical(parseExact('[2,1]')));
 assert.notEqual(canonical(parseExact('{"x":null}')),canonical(parseExact('{}')));
 assert.notEqual(canonical(parseExact('" x "')),canonical(parseExact('"x"')));
});
test('exact submission validation never rounds away excess precision',()=>{
 const envelope=patch=>parseExact(`{"client_submission_id":"70000000-0000-4000-8000-000000000001","record_id":"30000000-0000-4000-8000-000000000001","base_version_no":1,"form_version":"tree-v1","observed_at":"2026-06-01T00:00:00Z","patch":${patch}}`);
 validateSubmission(envelope('{"diameter_cm":0,"guard_damage":false,"health":null}'));
 assert.throws(()=>validateSubmission(envelope('{"diameter_cm":30.000000000000000001}')),e=>e.code==='invalid_diameter');
 assert.throws(()=>validateSubmission(envelope('{"guard_damage":"false"}')),ApiError);
 assert.throws(()=>validateSubmission(envelope('{"actor_id":"forged"}')),ApiError);
 const badDate=envelope('{"health":"Good"}');badDate.observed_at='2026-02-30T00:00:00Z';assert.throws(()=>validateSubmission(badDate),e=>e.code==='invalid_calendar_date');
});
