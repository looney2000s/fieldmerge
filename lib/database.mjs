import pg from 'pg';
import {MongoClient} from 'mongodb';

const state=globalThis.__fieldmergeConnections??={};
export function pool(){
  if(!process.env.DATABASE_URL)throw new Error('Backend database configuration missing; run configure:backend');
  if(new URL(process.env.DATABASE_URL).username!=='fieldmerge_api')throw new Error('Backend must use restricted fieldmerge_api credentials');
  return state.pg??=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:15000});
}
export async function query(sql,params=[]){return (await pool().query(sql,params)).rows;}
export async function call(name,params=[]){
  // name is an internal static constant, never user input.
  if(!/^api_[a-z_]+$/.test(name))throw new Error('Invalid database operation');
  const placeholders=params.map((_,i)=>'$'+(i+1)).join(',');
  return(await query(`SELECT fieldmerge.${name}(${placeholders}) AS value`,params))[0].value;
}
export async function mongo(){
  if(!process.env.MONGODB_URI||!process.env.MONGODB_DATABASE)throw new Error('MongoDB backend configuration missing');
  if(new URL(process.env.MONGODB_URI).username!=='fieldmerge_api')throw new Error('Backend must use restricted MongoDB credentials');
  state.mongo??=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:5000,waitQueueTimeoutMS:5000,maxPoolSize:5});
  await state.mongo.connect();return state.mongo.db(process.env.MONGODB_DATABASE);
}
export async function closeConnections(){await state.pg?.end();await state.mongo?.close();delete state.pg;delete state.mongo;}
