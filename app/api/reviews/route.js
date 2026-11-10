import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
import {reviewFilters,page} from '@/lib/read-queries.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>{const {hash}=await authenticate(request,'reviewer'),f=reviewFilters(request.url);const result=page(await call('api_reviews_page',[hash,f.record,f.field,f.author,f.from,f.to,f.after,f.limit]),f.limit,'change_id');return response({changes:result.values,next_cursor:result.next_cursor});});
