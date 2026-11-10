import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {acceptedExport} from '@/lib/reports.mjs';
import {recordFilters} from '@/lib/read-queries.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>{const {hash}=await authenticate(request,'reviewer'),f=recordFilters(request.url,{exporting:true});return response({exported_at:new Date().toISOString(),records:await acceptedExport(hash,f)},200,{'Content-Disposition':'attachment; filename="fieldmerge-accepted.json"'});});
