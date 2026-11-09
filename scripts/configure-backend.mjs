import pg from 'pg';
import {MongoClient} from 'mongodb';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.loadEnvFile(path.join(root,'.env'));
const e=process.env;
export async function configureBackend({pgDatabase=e.FM_CONFIG_DATABASE??'fieldmerge',mongoDatabase=e.FM_CONFIG_MONGO_DATABASE??'fieldmerge',save=true}={}){
const pgPassword=e.API_POSTGRES_PASSWORD??randomBytes(24).toString('hex');
const mongoPassword=e.API_MONGO_PASSWORD??randomBytes(24).toString('hex');
if(!/^fieldmerge(?:_test_[a-f0-9]+)?$/.test(pgDatabase)||!/^fieldmerge(?:_test_[a-f0-9]+)?$/.test(mongoDatabase))throw new Error('Unexpected target database');
const client=new pg.Client({host:'127.0.0.1',port:Number(e.POSTGRES_PORT??15432),database:pgDatabase,user:e.POSTGRES_USER,password:e.POSTGRES_PASSWORD});
const mongo=new MongoClient(`mongodb://${encodeURIComponent(e.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(e.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${e.MONGO_PORT??27018}/?authSource=admin`);
try{
 await client.connect();
 // PostgreSQL utility statements do not accept value placeholders; quote the generated secret as a literal.
 if(!/^[a-f0-9]{48}$/.test(pgPassword)||!/^[a-f0-9]{48}$/.test(mongoPassword))throw new Error('Generated backend credentials must be 48 hexadecimal characters');
 await client.query(`ALTER ROLE fieldmerge_api LOGIN PASSWORD '${pgPassword}'`);
 await mongo.connect();const db=mongo.db(mongoDatabase);
 const roles=[{role:'fieldmerge_evidence_writer',db:mongoDatabase},{role:'fieldmerge_evidence_reader',db:mongoDatabase}];
 const existing=await db.command({usersInfo:'fieldmerge_api'});
 if(existing.users.length)await db.command({updateUser:'fieldmerge_api',pwd:mongoPassword,roles});
 else await db.command({createUser:'fieldmerge_api',pwd:mongoPassword,roles});
 const values={API_POSTGRES_PASSWORD:pgPassword,API_MONGO_PASSWORD:mongoPassword,
  DATABASE_URL:`postgresql://fieldmerge_api:${pgPassword}@127.0.0.1:${e.POSTGRES_PORT??15432}/${pgDatabase}`,
  MONGODB_URI:`mongodb://fieldmerge_api:${mongoPassword}@127.0.0.1:${e.MONGO_PORT??27018}/${mongoDatabase}?authSource=${mongoDatabase}`,
  MONGODB_DATABASE:mongoDatabase,APP_ORIGIN:e.APP_ORIGIN??'http://localhost:3000'};
 if(save){
  let text=readFileSync(path.join(root,'.env'),'utf8');
  for(const [key,value]of Object.entries(values)){const re=new RegExp('^'+key+'=.*$','m');text=re.test(text)?text.replace(re,`${key}=${value}`):text+`\n${key}=${value}`;}
  writeFileSync(path.join(root,'.env'),text.trimEnd()+'\n');
  console.log('Restricted backend logins provisioned. Connection settings saved to ignored .env; secrets not printed.');
 }
 return values;
}finally{await client.end();await mongo.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await configureBackend();
