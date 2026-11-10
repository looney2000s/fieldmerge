import pg from 'pg';
import {MongoClient} from 'mongodb';
export function recoveryConnections(env=process.env){
 let postgres,mongodb;
 function pool(){
  if(!env.WORKER_DATABASE_URL||new URL(env.WORKER_DATABASE_URL).username!=='fieldmerge_worker')throw new Error('Restricted worker PostgreSQL configuration required');
  if(!postgres){
   postgres=new pg.Pool({connectionString:env.WORKER_DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:15000});
   postgres.on('error',()=>console.error(JSON.stringify({event:'recovery_postgres_connection_lost'})));
  }
  return postgres;
 }
 return{
  async call(name,values=[]){
   if(!/^worker_[a-z_]+$/.test(name))throw new Error('Invalid worker operation');
   return(await pool().query(`SELECT fieldmerge.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,values)).rows[0].value;
  },
  async mongo(){
   if(!env.WORKER_MONGODB_URI||!env.MONGODB_DATABASE||new URL(env.WORKER_MONGODB_URI).username!=='fieldmerge_worker')throw new Error('Restricted worker MongoDB configuration required');
   mongodb??=new MongoClient(env.WORKER_MONGODB_URI,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:10000,maxPoolSize:2});
   await mongodb.connect();return mongodb.db(env.MONGODB_DATABASE);
  },
  async close(){await postgres?.end();await mongodb?.close();postgres=undefined;mongodb=undefined;}
 };
}
