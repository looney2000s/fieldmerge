import {body,handled,protectOrigin,response} from '@/lib/http.mjs';
import {object,ApiError} from '@/lib/canonical.mjs';
import {login,cookie} from '@/lib/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handled(async request=>{
  protectOrigin(request);const p=object(await body(request,8192),['email','password']);
  if(typeof p.email!=='string'||p.email.length>254||typeof p.password!=='string'||!p.password||p.password.length>1024)throw new ApiError(400,'invalid_login');
  const {token,user}=await login(p.email.trim().toLowerCase(),p.password);
  return response({user},200,{'Set-Cookie':cookie(token)});
});
