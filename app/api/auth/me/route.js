import {handled,response} from '@/lib/http.mjs';
import {authenticate} from '@/lib/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=handled(async request=>response({user:(await authenticate(request)).user}));
