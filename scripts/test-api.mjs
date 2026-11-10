import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {configureBackend} from './configure-backend.mjs';
const run=promisify(execFile),root=process.cwd();
const docker=process.env.DOCKER_EXE??path.join(process.env.USERPROFILE??'C:/Users/abdullah','AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe');
const name='fieldmerge_test_'+randomUUID().replaceAll('-','');
const args=['compose','--project-directory',root,'-f',path.join(root,'compose.yaml'),'exec','-T'];
async function command(tail){return(await run(docker,[...args,...tail],{maxBuffer:4*1024*1024})).stdout;}
const admin=new pg.Client({host:'127.0.0.1',port:Number(process.env.POSTGRES_PORT??15432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:'fieldmerge'});
let server;
try{
 await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 for(const file of readdirSync('database/postgres/migrations').filter(x=>x.endsWith('.sql')).sort()){
  const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(readFileSync('database/postgres/migrations/'+file)).digest('hex');
  await command(['postgres','psql','-X','-U','fieldmerge_owner','-d',name,'-v','ON_ERROR_STOP=1','-v','migration_hash='+hash,'-f','/database/postgres/migrations/'+file]);
 }
 await command(['postgres','psql','-X','-U','fieldmerge_owner','-d',name,'-v','ON_ERROR_STOP=1','-f','/fixtures/seed.sql']);
 for(const script of ['initialize','seed'])await command(['-e','FM_DB='+name,'mongo','mongosh','--quiet','--file',`/database/mongodb/${script}.js`]);
 const config=await configureBackend({pgDatabase:name,mongoDatabase:name,save:false});
 const env={...process.env,...config,APP_ORIGIN:'http://127.0.0.1:3100',API_BASE:'http://127.0.0.1:3100',FM_TEST_DATABASE:name,NEXT_TELEMETRY_DISABLED:'1'};
 const log=[];
 server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3100'],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 server.stdout.on('data',x=>log.push(x.toString()));server.stderr.on('data',x=>log.push(x.toString()));
 let ready=false;
 for(let i=0;i<100;i++){
  if(server.exitCode!==null)throw new Error('API server exited: '+log.join('').slice(-2000));
  try{ready=(await fetch(env.API_BASE+'/api/auth/me')).status===401;}catch{}
  if(ready)break;await new Promise(r=>setTimeout(r,200));
 }
 if(!ready)throw new Error('API server not ready');
 console.log('Testing production Next.js server against isolated databases.');
 const child=spawn(process.execPath,['--test','--test-concurrency=1','tests/api/integration.test.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 const output=[];child.stdout.on('data',x=>{process.stdout.write(x);output.push(x.toString());});child.stderr.on('data',x=>{process.stderr.write(x);output.push(x.toString());});
 const code=await new Promise(resolve=>child.on('exit',resolve));
 if(code!==0)throw new Error('API integration checks failed');
 mkdirSync('output/api',{recursive:true});writeFileSync('output/api/verification.json',JSON.stringify({verified_at_utc:new Date().toISOString(),test_database:name,production_server:true,output:output.join(''),remaining:'Persistent recovery workers, full workflow-wide consistency enforcement, richer query/export APIs and UI remain.'},null,2));
 console.log('API verification passed; evidence saved to output/api/verification.json.');
}finally{if(server){server.kill();await new Promise(r=>{if(server.exitCode!==null)return r();server.once('exit',r);setTimeout(r,3000).unref();});}await admin.end();}
