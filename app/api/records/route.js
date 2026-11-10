import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {recordFilters,recordArgs,page} from '@/lib/read-queries.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>{const {hash}=await authenticate(request),f=recordFilters(request.url);const result=page(await call('api_records_page',[hash,...recordArgs(f),f.after,f.limit]),f.limit,'record_id');return response({records:result.values,next_cursor:result.next_cursor});});
