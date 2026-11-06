import { env } from "cloudflare:workers";
import { digest, token, verifyPassword } from "./password";
export class HttpError extends Error { constructor(public status:number,message:string){super(message)} }
export function db(){if(!env.DB)throw new HttpError(503,"O banco de dados está indisponível. Tente novamente em instantes.");return env.DB;}
export function bucket(){if(!env.BUCKET)throw new HttpError(503,"O armazenamento está indisponível. Tente novamente.");return env.BUCKET;}
export function json(value:unknown,status=200,headers:Record<string,string>={}) {return Response.json(value,{status,headers:{"Cache-Control":"no-store, private","X-Content-Type-Options":"nosniff",...headers}})}
async function storedCredentials() {
  return db().prepare("SELECT username,password_hash FROM admin_credentials WHERE id=1").first<{username:string;password_hash:string}>();
}
export async function config() {
  let username=env.ADMIN_USERNAME;let hash=env.ADMIN_PASSWORD_HASH;
  if(!username&&!hash){const stored=await storedCredentials();username=stored?.username;hash=stored?.password_hash;}
  if(!username||!hash)throw new HttpError(503,"O acesso ainda está sendo configurado. Tente novamente em instantes.");
  return {username,hash,version:digest(username+hash)};
}
export async function readLimited(request:Request,max:number) {
  const declared=Number(request.headers.get("content-length"));
  if(declared>max)throw new HttpError(413,"O conteúdo ultrapassa o tamanho permitido.");
  const reader=request.body?.getReader();if(!reader)return new Uint8Array(0);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>max){await reader.cancel();throw new HttpError(413,"O conteúdo ultrapassa o tamanho permitido.");}chunks.push(part.value);}}finally{reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
export async function body(request:Request,max=100000) {
  if(!request.headers.get("content-type")?.includes("application/json"))throw new HttpError(415,"Formato de solicitação inválido.");
  const raw=new TextDecoder().decode(await readLimited(request,max));
  try{return JSON.parse(raw)}catch{throw new HttpError(400,"Não foi possível ler os dados enviados.")}
}
export function checkWrite(request:Request) {
  const origin=request.headers.get("origin");
  const expected=env.APP_ORIGIN||new URL(request.url).origin;
  if(origin!==expected||request.headers.get("x-oficina-request")!=="1")throw new HttpError(403,"Solicitação não autorizada. Atualize a página e tente novamente.");
}
const cookieName="__Host-oficina";
export function cookie(request:Request) {return request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(cookieName+"="))?.slice(cookieName.length+1)||"";}
export function cookieHeader(value:string,age:number) {return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${age}`;}
export async function session(request:Request) {
  const value=cookie(request); if(!/^[a-f0-9]{64}$/.test(value))return false;
  const cfg=await config();
  return !!await db().prepare("SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>? AND credential_version=?").bind(digest(value),Date.now(),cfg.version).first();
}
export async function login(request:Request) {
  const input=await body(request,2000);
  if(typeof input.username!=="string"||typeof input.password!=="string"||input.username.length>160||input.password.length>256)throw new HttpError(400,"Confira o usuário e a senha.");
  const cfg=await config(); const now=Date.now();
  const identity=request.headers.get("cf-connecting-ip")||request.headers.get("oai-authenticated-user-id")||"unknown";
  const keys=["login:"+digest(identity),"login:all"];
  const counts=await db().batch<{count:number}>(keys.map(key=>db().prepare("INSERT INTO login_attempts (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END RETURNING count").bind(key,now+15*60000,now,now)));
  if(Number(counts[0].results[0]?.count)>5||Number(counts[1].results[0]?.count)>30)throw new HttpError(429,"Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.");
  const valid=verifyPassword(input.password,cfg.hash);
  if(!valid||input.username!==cfg.username)throw new HttpError(401,"Usuário ou senha incorretos.");
  const value=token();
  await db().batch([
    db().prepare("DELETE FROM sessions WHERE expires_at<? OR credential_version<>?").bind(now,cfg.version),
    db().prepare("INSERT INTO sessions (token_hash,credential_version,expires_at,created_at) VALUES (?,?,?,?)").bind(digest(value),cfg.version,now+12*60*60000,now),
    db().prepare("DELETE FROM login_attempts WHERE key=? OR expires_at<?").bind(keys[0],now),
  ]);
  return json({authenticated:true,username:cfg.username},200,{"Set-Cookie":cookieHeader(value,12*60*60)});
}
export async function logout(request:Request) {await db().prepare("DELETE FROM sessions WHERE token_hash=?").bind(digest(cookie(request))).run();return json({ok:true},200,{"Set-Cookie":cookieHeader("",0)})}
