import {call,mongo} from './database.mjs';
import {ApiError} from './canonical.mjs';
import {recordArgs} from './read-queries.mjs';
export async function acceptedExport(hash,filters){
 const rows=await call('api_accepted_export',[hash,...recordArgs(filters)]);
 if(rows.length>5000)throw new ApiError(413,'export_too_large_use_filters');return rows;
}
export async function evidenceSummary(db){
 const hasObservations={$gt:[{$size:{$ifNull:['$payload.observations',[]]}},0]},observationCount={$size:{$ifNull:['$payload.observations',[]]}};
 const [result]=await db.collection('submission_documents').aggregate([{$facet:{
  totals:[{$group:{_id:null,source_count:{$sum:1},with_observations:{$sum:{$cond:[hasObservations,1,0]}},observation_count:{$sum:observationCount}}},{$project:{_id:0}}],
  by_form:[{$group:{_id:'$form_version',source_count:{$sum:1},with_observations:{$sum:{$cond:[hasObservations,1,0]}},observation_count:{$sum:observationCount}}},{$sort:{_id:1}}],
  by_first_batch:[{$group:{_id:{$ifNull:['$batch_id',null]},source_count:{$sum:1}}},{$sort:{_id:1}},{$limit:101}],
  observation_categories:[{$unwind:'$payload.observations'},{$group:{_id:'$payload.observations.category',count:{$sum:1}}},{$sort:{_id:1}}],
  patch_field_presence:[{$project:{fields:{$objectToArray:'$payload.patch'}}},{$unwind:'$fields'},{$group:{_id:'$fields.k',count:{$sum:1},explicit_nulls:{$sum:{$cond:[{$eq:['$fields.v',null]},1,0]}}}},{$sort:{_id:1}}]
 }}],{maxTimeMS:5000}).toArray();
 const totals=result.totals[0]??{source_count:0,with_observations:0,observation_count:0};
 return{available:true,as_of:new Date().toISOString(),...totals,observation_coverage_pct:totals.source_count?100*totals.with_observations/totals.source_count:null,
  by_form:result.by_form.map(({_id,...r})=>({form_version:_id,...r})),
  by_first_batch:result.by_first_batch.slice(0,100).map(({_id,...r})=>({batch_id:_id,...r})),batch_groups_truncated:result.by_first_batch.length>100,
  observation_categories:result.observation_categories.map(({_id,...r})=>({category:_id,...r})),
  patch_field_presence:result.patch_field_presence.map(({_id,...r})=>({field:_id,...r}))};
}
export async function combinedSummary(hash,{mongoProvider=mongo}={}){
 const [sql,evidence]=await Promise.allSettled([call('api_sql_summary',[hash]),(async()=>evidenceSummary(await mongoProvider()))()]);
 if(sql.status==='rejected')throw sql.reason;
 return{sql:sql.value,evidence:evidence.status==='fulfilled'?evidence.value:{available:false,error:'evidence_unavailable'},consistency:'independent_database_reads'};
}
