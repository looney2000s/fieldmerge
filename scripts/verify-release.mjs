// Clean checkout verification. Built-ins only; never loads the development .env.
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,copyFileSync,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--ref'||args[2]!=='--commit'||!/^[a-zA-Z0-9/_-]+$/.test(args[1])||!/^[a-f0-9]{40}$/.test(args[3]))throw new Error('Use --ref branch-name --commit full-published-commit');
const sourceRef=args[1],expected=args[3],id=randomUUID().replaceAll('-',''),project='fieldmerge-release-'+id;
const privateDir=path.join(root,'tmp',project),checkout=path.join(privateDir,'checkout'),destination=path.join(root,'output/release');
assert(privateDir.startsWith(path.join(root,'tmp')+path.sep));assert(/^fieldmerge-release-[a-f0-9]{32}$/.test(project));
mkdirSync(privateDir,{recursive:true});mkdirSync(destination,{recursive:true});
const docker=process.env.DOCKER_EXE??path.join(process.env.USERPROFILE,'AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe');
const env={...process.env};
for(const key of Object.keys(env))if(/^(?:POSTGRES_|MONGO|DATABASE_URL$|WORKER_|API_POSTGRES|API_MONGO|API_BASE$|APP_ORIGIN$|SECURITY_LOG_DIR$|PLAYWRIGHT_BROWSERS_PATH$|FM_|COMPOSE_)/.test(key))delete env[key];
env.COMPOSE_PROJECT_NAME=project;env.GOMAXPROCS='2';env.NODE_OPTIONS='--max-old-space-size=1024';env.NEXT_TELEMETRY_DISABLED='1';env.CI='1';
const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';
env[pathKey]=path.dirname(docker)+path.delimiter+(env[pathKey]??'');
if(process.platform==='win32'){
 const moduleKey=Object.keys(env).find(k=>k.toLowerCase()==='psmodulepath')??'PSModulePath';
 // The Codex parent uses PowerShell 7; native powershell.exe must load its own modules.
 env[moduleKey]=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules');
}
const report={started_at_utc:new Date().toISOString(),status:'running',repository:'https://github.com/looney2000s/fieldmerge.git',requested_ref:sourceRef,expected_commit:expected,compose_project:project,private_checkout:path.relative(root,checkout).replaceAll('\\','/'),fresh_credentials:true,development_env_loaded:false,development_project_targeted:false,steps:[],cleanup_completed:false,orchestrator_sha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),environment:{platform:process.platform,os_release:os.release(),node:process.version}};
const save=()=>writeFileSync(path.join(destination,'verification.json'),JSON.stringify(report,null,2)+'\n');
save();let failure=null,baselineIds=[],servicesStarted=false,liveChild=null;
async function run(executable,command,{cwd=checkout,timeout=300000,log=true,extraEnv={}}={}){
 const child=spawn(executable,command,{cwd,env:{...env,...extraEnv},windowsHide:true,stdio:['ignore','pipe','pipe']});liveChild=child;
 const chunks=[],stdout=[];let expired=false;
 const timer=setTimeout(()=>{expired=true;child.kill();},timeout);timer.unref();
 child.stdout.on('data',b=>{chunks.push(b);stdout.push(b);});child.stderr.on('data',b=>chunks.push(b));
 let code;
 try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
 finally{clearTimeout(timer);if(liveChild===child)liveChild=null;}
 const text=Buffer.concat(chunks).toString('utf8');
 if(log)writeFileSync(path.join(privateDir,'last-command.log'),text);
 if(expired||code!==0){const error=new Error(expired?'Command timed out':'Command failed');error.privateOutput=text;error.exitCode=code;throw error;}
 return Buffer.concat(stdout).toString('utf8');
}
function packageCommand(tail){assert(tail.every(x=>/^[a-zA-Z0-9:@/._=-]+$/.test(x)));return [process.env.ComSpec??'cmd.exe',['/d','/s','/c','pnpm.cmd '+tail.join(' ')]];}
async function pnpm(tail,options){return run(...packageCommand(tail),options);}
async function step(name,fn){const start=Date.now(),entry={name,started_at_utc:new Date(start).toISOString(),status:'running'};report.steps.push(entry);save();console.log('START '+name);
 try{const result=await fn();entry.status='passed';if(result)entry.result=result;console.log('PASS '+name);}
 catch(error){entry.status='failed';entry.error='See the private log for this stage; raw errors are not published.';entry.error_code=/^[A-Z][A-Z0-9_]{0,49}$/.test(error.code??'')?error.code:null;writeFileSync(path.join(privateDir,name+'.log'),(error.privateOutput??'')+'\n'+String(error.stack??error));throw error;}
 finally{const last=path.join(privateDir,'last-command.log');if(entry.status==='passed'&&existsSync(last)&&statSync(last).mtimeMs>=start-1000)copyFileSync(last,path.join(privateDir,name+'.log'));entry.elapsed_ms=Date.now()-start;entry.finished_at_utc=new Date().toISOString();save();}
}
const compose=(tail,options={})=>run(docker,['compose','--project-directory',checkout,'-p',project,'-f',path.join(checkout,'compose.yaml'),'--profile','test',...tail],options);
const json=p=>JSON.parse(readFileSync(path.join(checkout,p),'utf8').replace(/^\uFEFF/,''));
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
async function port(){const s=createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});const n=s.address().port;await new Promise(resolve=>s.close(resolve));return n;}
async function freePort(n){const s=createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(n,'127.0.0.1',resolve);});await new Promise(resolve=>s.close(resolve));}
function testPasses(text){const match=text.match(/(?:ℹ|#)\s*pass\s+(\d+)/);assert(match,'Expected a completed Node test summary');return Number(match[1]);}
function freshReport(p,started){const r=json(p);const when=r.verified_at_utc??r.finished_at_utc;assert(when&&Date.parse(when)>=started-1000,'A previously committed report cannot establish this run');return r;}
async function originalContainerIds(){return (await run(docker,['ps','-a','--filter','label=com.docker.compose.project=fieldmerge','--format','{{.ID}}'],{cwd:root,log:false})).trim().split(/\r?\n/).filter(Boolean).sort();}
function collect(){
 const folders=['database','api','acceptance','browser','security','performance','design'];
 const credentials=[];
 for(const line of readFileSync(path.join(checkout,'.env'),'utf8').split(/\r?\n/)){const i=line.indexOf('=');if(i>0&&/PASSWORD|DATABASE_URL|MONGODB_URI/.test(line.slice(0,i)))credentials.push(line.slice(i+1));}
 for(const a of json('tmp/database-fixtures/demo-accounts.json'))credentials.push(a.password,a.password_hash);
 const files=[];
 function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.name.endsWith('.json')||e.name.endsWith('.csv')||(e.name==='README.md'&&file.includes(path.sep+'performance'+path.sep)))files.push(file);}}
 for(const folder of folders)walk(path.join(checkout,'output',folder));
 const manifest={};
 for(const file of files){if(file===path.join(checkout,'output/design/report-verification.json'))continue;const content=readFileSync(file);assert(!credentials.some(x=>x&&x.length>=10&&content.includes(Buffer.from(x))),'Generated credentials cannot enter public release evidence');const relative=path.relative(path.join(checkout,'output'),file),target=path.join(destination,'evidence',relative);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,content);manifest['evidence/'+relative.replaceAll('\\','/')]=digest(target);}
 const dictionary=readFileSync(path.join(checkout,'docs/FieldMerge_Data_Dictionary.md'));assert(!credentials.some(x=>x&&x.length>=10&&dictionary.includes(Buffer.from(x))));writeFileSync(path.join(destination,'evidence/design/FieldMerge_Data_Dictionary.md'),dictionary);manifest['evidence/design/FieldMerge_Data_Dictionary.md']=digest(path.join(destination,'evidence/design/FieldMerge_Data_Dictionary.md'));
 for(const [log,name]of [['unit_tests.log','unit-tests.txt'],['production_build.log','production-build.txt']]){const file=path.join(privateDir,log);assert(existsSync(file));const text=readFileSync(file);assert(!credentials.some(x=>x&&x.length>=10&&text.includes(Buffer.from(x))));const target=path.join(destination,'evidence',name);writeFileSync(target,text);manifest['evidence/'+name]=digest(target);}
 writeFileSync(path.join(destination,'artifact-checksums.json'),JSON.stringify(manifest,null,2)+'\n');return {artifacts:Object.keys(manifest).length,generated_secret_scan:'passed'};
}
try{
 await step('docker_ready',async()=>{
  const start=Date.now();for(;;){try{report.environment.docker=(await run(docker,['version','--format','{{.Server.Version}}'],{cwd:root,log:false,timeout:10000})).trim();break;}catch{if(Date.now()-start>150000)throw new Error('Docker not ready');await new Promise(r=>setTimeout(r,2000));}}
  baselineIds=await originalContainerIds();report.original_development_container_ids=baselineIds;
 });
 await step('clone_published_revision',async()=>{
  await run('git',['clone','--depth','1','--single-branch','--branch',sourceRef,report.repository,checkout],{cwd:privateDir,timeout:180000});
  const commit=(await run('git',['rev-parse','HEAD'],{log:false})).trim();assert.equal(commit,expected);assert.equal((await run('git',['status','--porcelain'],{log:false})).trim(),'');
  for(const name of ['.env','node_modules','.next','tmp'])assert(!existsSync(path.join(checkout,name)),'Fresh checkout contains an unexpected private/build input');
  report.tested_commit=commit;report.initial_checkout_clean=true;report.initial_build_and_private_inputs_absent=true;
  report.lockfile_sha256=digest(path.join(checkout,'pnpm-lock.yaml'));
  return {commit};
 });
 await step('install_frozen_dependencies',async()=>{
  report.environment.pnpm=(await pnpm(['--version'],{log:false})).trim();
  await pnpm(['install','--frozen-lockfile','--child-concurrency=1'],{timeout:900000});
  assert.equal(digest(path.join(checkout,'pnpm-lock.yaml')),report.lockfile_sha256);
  report.environment.next=json('node_modules/next/package.json').version;
  report.environment.playwright=json('node_modules/@playwright/test/package.json').version;
  return {lockfile_unchanged:true,project_node_modules_reused:false};
 });
 await step('generate_private_configuration',async()=>{
  await run(process.execPath,['database/scripts/generate-fixtures.mjs']);
  const pgPort=await port();let mongoPort=await port();while(mongoPort===pgPort)mongoPort=await port();await freePort(3100);
  const file=path.join(checkout,'.env');let text=readFileSync(file,'utf8');text=text.replace(/^POSTGRES_PORT=.*$/m,'POSTGRES_PORT='+pgPort).replace(/^MONGO_PORT=.*$/m,'MONGO_PORT='+mongoPort);text+='\nCOMPOSE_PROJECT_NAME='+project+'\n';writeFileSync(file,text);
  const config=JSON.parse(await run(docker,['compose','--project-directory',checkout,'-f',path.join(checkout,'compose.yaml'),'config','--format','json'],{log:false}));
  assert.equal(config.name,project);for(const v of Object.values(config.volumes))assert(v.name.startsWith(project+'_'));
  report.database_ports={postgres:pgPort,mongodb:mongoPort};report.compose_isolation_validated=true;
 });
 await step('database_setup_and_verification',async()=>{
  servicesStarted=true;
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/database.ps1','Setup'],{timeout:900000});
  const r=json('output/database/verification.json');assert(Date.parse(r.verified_at_utc)>=Date.parse(report.started_at_utc));assert(r.form_registry_hashes_match);assert.equal(r.migration_checksums.length,10);
  for(const [field,count] of [['postgres_output',39],['reconciliation_output',32],['reviewer_output',34],['integrity_output',52],['recovery_output',21],['query_output',22],['mongo_output',31]])assert(r[field].join('\n').includes('checks passed: '+count),'Expected completed structural/workflow suite: '+field);
  assert(r.commit_output.join('\n').includes('COMMIT checks passed: 4'));assert(r.concurrency_output.join('\n').includes('scenarios passed: 2'));assert(r.reviewer_concurrency_output.join('\n').includes('scenarios passed: 4'));
  await compose(['stop','postgres-test','mongo-test']);
  return {assertions:231,actual_commit_cases:4,concurrent_sql_cases:6,form_hashes_match:true};
 });
 await step('restricted_backend_configuration',async()=>{await pnpm(['configure:backend']);return {new_restricted_api_and_worker_credentials:true};});
 await step('unit_tests',async()=>{const out=await pnpm(['test:unit']);const pass=testPasses(out);assert.equal(pass,18);return {groups:pass};});
 await step('production_build',async()=>{await pnpm(['build'],{timeout:600000});assert(existsSync(path.join(checkout,'.next/BUILD_ID')));return {build_id:readFileSync(path.join(checkout,'.next/BUILD_ID'),'utf8').trim()};});
 await step('install_chromium',async()=>{await pnpm(['exec','playwright','install','chromium'],{timeout:900000,extraEnv:{PLAYWRIGHT_BROWSERS_PATH:path.join(checkout,'tmp/playwright-browsers')}});return {browser_cache_from_development_reused:false};});
 await step('api_integration',async()=>{const start=Date.now();await pnpm(['test:api'],{timeout:600000});const r=freshReport('output/api/verification.json',start);const groups=testPasses(r.output);assert.equal(groups,33);return {groups};});
 await step('functional_acceptance',async()=>{const start=Date.now();await pnpm(['test:acceptance'],{timeout:600000});const r=freshReport('output/acceptance/verification.json',start),cases=json('output/acceptance/scenarios.json');assert.equal(r.status,'passed');assert(r.cleanup_completed);assert.equal(cases.total,35);assert.equal(cases.passed,35);return {scenarios:cases.passed,disposable_cleanup:true};});
 await step('transport_and_security',async()=>{const start=Date.now();await pnpm(['test:security'],{timeout:600000});freshReport('output/security/verification.json',start);const r=json('output/security/checks.json'),b=json('output/security/browser.json');assert.equal(r.groups,23);assert.equal(r.passed,23);assert.equal(b.checks.length,5);assert.deepEqual(b.runtime_errors,[]);return {api_groups:23,browser_checks:5};});
 await step('browser_workflows',async()=>{const start=Date.now();await pnpm(['test:browser'],{timeout:600000});freshReport('output/browser/verification.json',start);const r=json('output/browser/checks.json');assert.equal(r.checks.length,15);assert.equal(r.accessibility.length,9);assert(r.accessibility.every(x=>!x.violations.length));assert.deepEqual(r.browser_errors,[]);return {workflows:15,representative_accessibility_pages:9,reported_violations:0};});
 await step('query_and_performance_evidence',async()=>{const start=Date.now();await pnpm(['db:evidence'],{timeout:1200000});await pnpm(['db:evidence:summary']);const r=freshReport('output/performance/verification.json',start);assert.equal(r.status,'passed');assert(r.cleanup_completed);return {status:'passed',disposable_cleanup:true};});
 await step('schema_dictionary_reconciliation',async()=>{await pnpm(['design:export']);const r=json('output/design/verification.json');assert(r.applied_migration_checksums_match&&r.all_column_meanings_present);assert.equal(r.table_count,17);assert.equal(r.column_count,146);assert.equal(r.foreign_key_count,29);assert.equal(r.collection_count,3);return {sql_tables:17,columns:146,foreign_keys:29,mongodb_collections:3};});
 await step('source_integrity_and_public_evidence',async()=>{
  assert.equal((await run('git',['rev-parse','HEAD'],{log:false})).trim(),expected);
  assert.equal(digest(path.join(checkout,'pnpm-lock.yaml')),report.lockfile_sha256);
  const files=(await run('git',['ls-files','-z'],{log:false})).split('\0').filter(Boolean);
  const changed=(await run('git',['diff','--name-only'],{log:false})).trim().split(/\r?\n/).filter(Boolean);
  assert(changed.every(x=>x.startsWith('output/')||x==='docs/FieldMerge_Data_Dictionary.md'),'Verification changed tracked implementation source');
  const manifest=Object.fromEntries(files.filter(p=>!p.startsWith('output/')&&p!=='docs/FieldMerge_Data_Dictionary.md').map(p=>[p,digest(path.join(checkout,p))]));
  writeFileSync(path.join(destination,'source-checksums.json'),JSON.stringify(manifest,null,2)+'\n');
  report.implementation_source_unchanged=true;report.lockfile_unchanged=true;
  return collect();
 });
}catch(error){failure=error;report.failure='A stage failed. Inspect its private log; no raw error/credential material is included in this report.';console.error('FAIL release verification; failed stage and private logs recorded.');}
finally{
 await step('isolated_environment_cleanup',async()=>{
  // All candidate names/files originate in this brand-new checkout; never target fieldmerge.
  if(existsSync(path.join(checkout,'tmp'))){for(const file of readdirSync(path.join(checkout,'tmp'))){const match=file.match(/^(fieldmerge-(?:acceptance|performance)-[a-f0-9]{32})\.json$/);if(match)await run(docker,['compose','--project-directory',checkout,'-p',match[1],'-f',path.join(checkout,'compose.yaml'),'-f',path.join(checkout,'tmp',file),'--profile','test','down','--timeout','5']);}}
  if(servicesStarted){const names=(await run(docker,['volume','ls','--filter','label=com.docker.compose.project='+project,'--format','{{.Name}}'],{cwd:root,log:false})).trim().split(/\r?\n/).filter(Boolean);assert(names.every(x=>x.startsWith(project+'_')));await compose(['down','--volumes','--timeout','5']);}
  const remaining=(await run(docker,['ps','-a','--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}'],{cwd:root,log:false})).trim();assert.equal(remaining,'');
  assert.deepEqual(await originalContainerIds(),baselineIds);
  report.cleanup_completed=true;report.original_development_container_ids_unchanged=true;return {new_release_volumes_removed:true,development_project_preserved:true};
 }).catch(()=>{failure??=new Error('Cleanup failed');report.cleanup_completed=false;report.cleanup_error='Inspect private logs; unique verification project retained if cleanup failed.';});
 report.status=failure?'failed':'passed';report.finished_at_utc=new Date().toISOString();save();
 mkdirSync(path.join(destination,'attempts'),{recursive:true});writeFileSync(path.join(destination,'attempts',id+'.json'),JSON.stringify(report,null,2)+'\n');
}
if(failure)process.exitCode=1;
else console.log('PASS clean published-checkout verification. Evidence: output/release/verification.json');
