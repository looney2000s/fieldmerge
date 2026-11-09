import {randomBytes,scryptSync,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if (!existsSync(path.join(root,'.env'))) {
 const template=readFileSync(path.join(root,'.env.example'),'utf8');
 writeFileSync(path.join(root,'.env'),template
  .replace('replace_with_random_local_password',randomBytes(24).toString('hex'))
  .replace('replace_with_another_random_local_password',randomBytes(24).toString('hex')));
 console.log('Generated ignored .env with local random database credentials.');
}
const generated=path.join(root,'tmp/database-fixtures'); mkdirSync(generated,{recursive:true});
const ctx={}; vm.runInNewContext(readFileSync(path.join(root,'database/fixtures/forms.js'),'utf8'),ctx);
// Fixed source form object key insertion order is the versioned definition encoding for this milestone.
const forms=JSON.parse(JSON.stringify(ctx.fmForms)).map(f=>({...f,schema_hash:createHash('sha256').update(JSON.stringify(f)).digest('hex')}));
writeFileSync(path.join(generated,'forms.json'),JSON.stringify(forms,null,2));
const accountFile=path.join(generated,'demo-accounts.json');
let accounts;
if (existsSync(accountFile)) accounts=JSON.parse(readFileSync(accountFile,'utf8'));
else {
 accounts=['surveyor','reviewer'].map((role,i)=>{
  const password=randomBytes(16).toString('hex'),salt=randomBytes(16).toString('hex');
  const hash=scryptSync(password,salt,64).toString('hex');
  return {user_id:`10000000-0000-4000-8000-00000000000${i+1}`,email:`${role}@fieldmerge.local`,role,password,password_hash:`scrypt$${salt}$${hash}`};
 });
 writeFileSync(accountFile,JSON.stringify(accounts,null,2));
}
const sqlQuote=s=>"'"+s.replaceAll("'","''")+"'";
const users=accounts.map(a=>`INSERT INTO app_users(user_id,email,password_hash,display_name,role) VALUES (${[a.user_id,a.email,a.password_hash,a.role,a.role].map(sqlQuote).join(',')}) ON CONFLICT DO NOTHING;`).join('\n');
const registry=forms.map(f=>`INSERT INTO form_versions(form_version,definition_id,schema_hash,published_at) VALUES (${[f.form_version,f._id,f.schema_hash,'2026-11-02T00:00:00Z'].map(sqlQuote).join(',')}) ON CONFLICT DO NOTHING;`).join('\n');
const sql=`\\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;
${users}
${registry}
INSERT INTO survey_campaigns(campaign_id,name,starts_at,ends_at,source_dataset_id,source_url,import_mapping_version)
VALUES ('20000000-0000-4000-8000-000000000001','Synthetic demonstration campaign','2026-01-01','2026-12-31T23:59:59Z','synthetic-fixtures-v1','https://example.invalid/fieldmerge-synthetic','fixture-v1') ON CONFLICT DO NOTHING;
WITH new_records AS (
 INSERT INTO tree_records(record_id,campaign_id,source_record_id)
 SELECT ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'20000000-0000-4000-8000-000000000001','DEMO-'||i FROM generate_series(1,3) i
 ON CONFLICT DO NOTHING RETURNING record_id
)
INSERT INTO accepted_versions(record_id,version_no,species,health,diameter_cm,guard_damage,published_by)
SELECT record_id,1,'Demo species','Good',30,NULL,'10000000-0000-4000-8000-000000000002' FROM new_records;
COMMIT;
`;
writeFileSync(path.join(generated,'seed.sql'),sql);
console.log('Prepared synthetic seed: two accounts, two matching form hashes, three trees. Secrets remain in ignored tmp files.');
