import {handled,protectOrigin,response} from '@/lib/http.mjs';
import {tokenHash,cookie} from '@/lib/auth.mjs';
import {call} from '@/lib/database.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async request=>{protectOrigin(request);await call('api_logout',[tokenHash(request)]);return response({ok:true},200,{'Set-Cookie':cookie('',0)});});
