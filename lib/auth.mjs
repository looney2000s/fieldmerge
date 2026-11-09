import {randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {call} from './database.mjs';
import {sha256,ApiError} from './canonical.mjs';
const scrypt=promisify(scryptCallback);
const cookieName='fieldmerge_session';
export function tokenHash(request){
  const raw=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  if(!raw||!/^[a-f0-9]{64}$/.test(raw))throw new ApiError(401,'authentication_required');return sha256(raw);
}
export async function authenticate(request,role){const hash=tokenHash(request),user=await call('api_me',[hash]);if(role&&user.role!==role)throw new ApiError(403,'role_denied');return {hash,user};}
export function cookie(token,maxAge=28800){return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV==='production'&&process.env.APP_ORIGIN?.startsWith('https:')?'; Secure':''}`;}
export async function login(email,password){
  if(!await call('api_login_allowed',[sha256(email)]))throw new ApiError(429,'login_rate_limited');
  const credential=await call('api_credentials',[email]);
  const parts=credential?.password_hash?.split('$')??[];
  const usable=parts.length===3&&parts[0]==='scrypt'&&/^[a-f0-9]{32}$/.test(parts[1])&&/^[a-f0-9]{128}$/.test(parts[2]);
  const salt=usable?parts[1]:'0'.repeat(32),expected=Buffer.from(usable?parts[2]:'0'.repeat(128),'hex');
  const actual=await scrypt(password,salt,64);
  if(!credential||!usable||!timingSafeEqual(actual,expected))throw new ApiError(401,'invalid_credentials');
  const token=randomBytes(32).toString('hex');await call('api_create_session',[credential.user_id,sha256(token)]);
  return {token,user:await call('api_me',[sha256(token)])};
}
