import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRecoveryWorker} from '../lib/recovery.mjs';
process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.env'));
if(process.argv.slice(2).some(x=>x!=='--once'))throw new Error('Only --once is supported');
const worker=createRecoveryWorker(),once=process.argv.includes('--once');let stopping=false,wake;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;wake?.();});
try{
 do{
  try{
   const result=await worker.tick();
   console.log(JSON.stringify({event:'recovery_cycle',discovered:result.discovered,discovery_failed:result.discovery_failed,
    processed:result.processed,outcomes:result.results.map(x=>({job_id:x.job_id,status:x.status,...(x.code?{code:x.code}:{})}))}));
  }catch{console.error(JSON.stringify({event:'recovery_cycle_unavailable'}));if(once)process.exitCode=1;}
  if(!once&&!stopping)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);wake=()=>{clearTimeout(timer);resolve();};});
 }while(!once&&!stopping);
}finally{await worker.close();}
