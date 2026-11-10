import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
import {combinedSummary} from '@/lib/reports.mjs';
import {parameters} from '@/lib/read-queries.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>{const {hash}=await authenticate(request,'reviewer');parameters(request.url,[]);return response(await combinedSummary(hash));});
