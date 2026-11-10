import {parseTree} from 'jsonc-parser';
import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';

export class ApiError extends Error {
  constructor(status,code){super(code);this.status=status;this.code=code;}
}
export function parseExact(text){
  const errors=[];const root=parseTree(text,errors,{allowTrailingComma:false,disallowComments:true});
  if(!root||errors.length)throw new ApiError(400,'invalid_json');
  function visit(n,depth=0){
    if(depth>30)throw new ApiError(400,'json_too_deep');
    if(n.type==='object'){
      const out=Object.create(null);
      for(const prop of n.children??[]){const key=prop.children[0].value;
        if(key.includes('\u0000'))throw new ApiError(400,'invalid_json_key');
        if(Object.hasOwn(out,key))throw new ApiError(400,'duplicate_json_key');
        out[key]=visit(prop.children[1],depth+1);
      }return out;
    }
    if(n.type==='array')return(n.children??[]).map(x=>visit(x,depth+1));
    if(n.type==='number'){
      const raw=text.slice(n.offset,n.offset+n.length);
      if(raw.length>128)throw new ApiError(400,'number_too_large');
      const value=new Decimal(raw);
      if(!value.isFinite()||value.precision()>34||Math.abs(value.e)>308)throw new ApiError(400,'number_out_of_range');
      return value;
    }
    return n.value;
  }
  return visit(root);
}
export function canonical(value){
  if(value instanceof Decimal)return value.isZero()?'0':value.toString();
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const sha256=s=>createHash('sha256').update(s).digest('hex');
export function object(value,allowed,required=allowed){
  if(!value||Array.isArray(value)||value instanceof Decimal||typeof value!=='object')throw new ApiError(400,'object_required');
  if(Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw new ApiError(400,'unexpected_or_missing_fields');
  return value;
}
export function uuid(value){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))throw new ApiError(400,'invalid_uuid');return value;}
export function integer(value){if(!(value instanceof Decimal)||!value.isInteger()||value.lt(1)||value.gt(2147483647))throw new ApiError(400,'positive_integer_required');return value.toNumber();}
function stamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw new ApiError(400,'invalid_timestamp');
  const [year,month,day]=value.slice(0,10).split('-').map(Number),calendar=new Date(0);
  calendar.setUTCFullYear(year,month-1,day);
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)throw new ApiError(400,'invalid_calendar_date');
  if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)throw new ApiError(400,'invalid_timestamp');
}
export function validateSubmission(p){
  object(p,['client_submission_id','record_id','base_version_no','form_version','observed_at','patch','observations','client_metadata'],
    ['client_submission_id','record_id','base_version_no','form_version','observed_at','patch']);
  uuid(p.client_submission_id);uuid(p.record_id);integer(p.base_version_no);
  const partial=Object.fromEntries(['observed_at','patch','observations','client_metadata'].filter(k=>Object.hasOwn(p,k)).map(k=>[k,p[k]]));
  validateDraftPayload(partial,p.form_version);
  if(!Object.keys(p.patch).length&&!p.observations?.length)throw new ApiError(400,'empty_submission');
  return p;
}
export function validateDraftPayload(p,formVersion){
  object(p,['observed_at','patch','observations','client_metadata'],[]);
  if(Object.hasOwn(p,'observed_at'))stamp(p.observed_at);
  if(!['tree-v1','tree-v2'].includes(formVersion))throw new ApiError(400,'unsupported_form');
  if(Object.hasOwn(p,'patch'))object(p.patch,['species','health','diameter_cm','guard_damage'],[]);
  for(const [key,v]of Object.entries(p.patch??{})){
    if(v===null)continue;
    if(key==='species'&&(typeof v!=='string'||v.length>120||!v.trim()||/[\u0000-\u001f\u007f]/.test(v)))throw new ApiError(400,'invalid_species');
    if(key==='health'&&!['Good','Fair','Poor'].includes(v))throw new ApiError(400,'invalid_health');
    if(key==='guard_damage'&&typeof v!=='boolean')throw new ApiError(400,'invalid_boolean');
    if(key==='diameter_cm'&&(!(v instanceof Decimal)||v.lt(0)||v.gt('999999.99')||v.decimalPlaces()>2))throw new ApiError(400,'invalid_diameter');
  }
  if(Object.hasOwn(p,'observations')){
    if(formVersion!=='tree-v2'||!Array.isArray(p.observations)||p.observations.length>20)throw new ApiError(400,'invalid_observations');
    for(const o of p.observations){object(o,['category','note','observed_at']);stamp(o.observed_at);
      if(!['guard','trunk','root','branch','other'].includes(o.category)||typeof o.note!=='string'||!o.note.trim()||o.note.length>500)throw new ApiError(400,'invalid_observation');}
  }
  if(Object.hasOwn(p,'client_metadata'))object(p.client_metadata,Object.keys(p.client_metadata??{}),[]);
  return p;
}
export {Decimal};
