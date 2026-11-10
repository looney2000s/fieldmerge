import {handled} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {acceptedExport} from '@/lib/reports.mjs';
import {recordFilters,acceptedCsv} from '@/lib/read-queries.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>{const {hash}=await authenticate(request,'reviewer');return new Response(acceptedCsv(await acceptedExport(hash,recordFilters(request.url,{exporting:true}))),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="fieldmerge-accepted.csv"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});});
