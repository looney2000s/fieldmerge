import {ApiError,uuid,parseExact,validateDraftPayload} from './canonical.mjs';
export function parameters(url,allowed){
 const q=new URL(url).searchParams;
 for(const key of q.keys())if(!allowed.includes(key)||q.getAll(key).length!==1)throw new ApiError(400,'unknown_or_duplicate_filter');
 return q;
}
function text(q,key){if(!q.has(key))return null;const s=q.get(key).trim();if(!s||s.length>120||/[\u0000-\u001f\u007f]/.test(s))throw new ApiError(400,'invalid_text_filter');return s;}
function positive(q,key,fallback,max=2147483647){if(!q.has(key))return fallback;const s=q.get(key);if(!/^[1-9][0-9]*$/.test(s)||Number(s)>max)throw new ApiError(400,'invalid_page_or_version');return Number(s);}
export function recordFilters(url,{exporting=false}={}){
 const q=parameters(url,['source_record_id','species','health','active',...(exporting?[]:['after','limit'])]);
 const health=q.get('health');if(health!==null&&!['Good','Fair','Poor','unknown'].includes(health))throw new ApiError(400,'invalid_health_filter');
 const active=q.get('active');if(active!==null&&!['all','true','false'].includes(active))throw new ApiError(400,'invalid_active_filter');
 return{source:text(q,'source_record_id'),species:text(q,'species'),health,active:active===null||active==='all'?null:active==='true',
  after:q.has('after')?uuid(q.get('after')):null,limit:positive(q,'limit',50,100)};
}
export const recordArgs=f=>[f.source,f.species,f.health,f.active];
export function reviewFilters(url){
 const q=parameters(url,['record_id','field','author_id','from','to','after','limit']);
 const field=q.get('field');if(field!==null&&!['species','health','diameter_cm','guard_damage'].includes(field))throw new ApiError(400,'invalid_field_filter');
 for(const key of ['from','to'])if(q.has(key)){
  validateDraftPayload(parseExact(JSON.stringify({observed_at:q.get(key)})),'tree-v2');
  if(/\.\d{4,}/.test(q.get(key)))throw new ApiError(400,'filter_timestamp_precision');
 }
 if(q.has('from')&&q.has('to')&&Date.parse(q.get('from'))>=Date.parse(q.get('to')))throw new ApiError(400,'invalid_date_range');
 return{record:q.has('record_id')?uuid(q.get('record_id')):null,field,author:q.has('author_id')?uuid(q.get('author_id')):null,
  from:q.get('from'),to:q.get('to'),after:q.has('after')?uuid(q.get('after')):null,limit:positive(q,'limit',100,100)};
}
export function snapshotVersion(url){return positive(parameters(url,['version']),'version',null);}
export function page(rows,limit,key){const more=rows.length>limit;const values=rows.slice(0,limit);return{values,next_cursor:more?values.at(-1)[key]:null};}
export function csvCell(value){
 let text=value===null||value===undefined?'':String(value);
 if(/^[\s]*[=+\-@]/.test(text)||/^[\t\r\n\u0000]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function acceptedCsv(records){
 const columns=['record_id','source_record_id','campaign_id','is_active','version_no','species','health','diameter_cm','guard_damage','origin_submission_id','published_by','created_at'];
 return '\ufeff'+[columns.map(csvCell).join(','),...records.map(r=>columns.map(k=>csvCell(r[k])).join(','))].join('\r\n')+'\r\n';
}
