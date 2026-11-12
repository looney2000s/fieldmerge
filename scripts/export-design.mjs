// Read-only catalogue export. No application rows, credentials, tokens or session hashes.
import pg from 'pg';
import {MongoClient} from 'mongodb';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
process.loadEnvFile('.env');
const schemas=['fieldmerge','fieldmerge_auth','fieldmerge_ops','fieldmerge_meta'];
const sql=new pg.Client({host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??15432),database:'fieldmerge',user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD});
const mongo=new MongoClient(`mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT??27018}/?authSource=admin`,{serverSelectionTimeoutMS:5000});
try {
 await sql.connect();await sql.query('BEGIN READ ONLY');
 const q=async(text)=> (await sql.query(text,[schemas])).rows;
 const tables=await q(`SELECT n.nspname AS schema,c.relname AS name,obj_description(c.oid) AS description FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) AND c.relkind='r' ORDER BY 1,2`);
 const columns=await q(`SELECT n.nspname AS schema,c.relname AS relation,a.attnum AS position,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,pg_get_expr(d.adbin,d.adrelid) AS default_expression,CASE a.attidentity WHEN 'a' THEN 'ALWAYS' WHEN 'd' THEN 'BY DEFAULT' END AS identity_generation,a.attgenerated AS generated_kind,col_description(c.oid,a.attnum) AS description FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=ANY($1) AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,3`);
 const constraints=await q(`SELECT n.nspname AS schema,c.relname AS relation,k.conname AS name,k.contype AS kind,pg_get_constraintdef(k.oid,true) AS definition,k.condeferrable AS deferrable,k.condeferred AS initially_deferred,CASE WHEN k.contype='f' THEN k.confrelid::regclass::text END AS referenced_relation,ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.num ORDER BY u.ord) AS columns FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) ORDER BY 1,2,3`);
 const indexes=await q(`SELECT schemaname AS schema,tablename AS relation,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname=ANY($1) ORDER BY 1,2,3`);
 const views=await q(`SELECT schemaname AS schema,viewname AS name,definition FROM pg_views WHERE schemaname=ANY($1) ORDER BY 1,2`);
 const triggers=await q(`SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) AND NOT t.tgisinternal ORDER BY 1,2,3`);
 const functions=await q(`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result,p.prosecdef AS security_definer,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1) ORDER BY 1,2,3`);
 const migrations=(await sql.query('SELECT version,checksum FROM fieldmerge_meta.migrations ORDER BY version')).rows;
 await sql.query('COMMIT');
 await mongo.connect();
 const db=mongo.db('fieldmerge'),collections=[];
 for(const c of await db.listCollections({}, {nameOnly:false}).toArray()) {
  collections.push({name:c.name,validator:c.options.validator,validationLevel:c.options.validationLevel,validationAction:c.options.validationAction,indexes:await db.collection(c.name).listIndexes().toArray()});
 }
 collections.sort((a,b)=>a.name.localeCompare(b.name));
 const snapshot={captured_at_utc:new Date().toISOString(),implementation_commit:execFileSync('git',['rev-parse','HEAD']).toString().trim(),scope:'Schema metadata only from development databases after migrations 001–010; no application data.',tables,columns,constraints,indexes,views,triggers,functions,migrations,collections};
 mkdirSync('output/design',{recursive:true});
 writeFileSync('output/design/schema-catalog.json',JSON.stringify(snapshot,null,2)+'\n');
 console.log(`Exported ${tables.length} SQL tables, ${columns.length} columns, ${constraints.filter(x=>x.kind==='f').length} foreign keys, ${views.length} views and ${collections.length} MongoDB collections. No application rows exported.`);
} catch {console.error('Design export failed; check local database services and private configuration. No connection details emitted.');process.exitCode=1;}
finally {await sql.end();await mongo.close();}
